import { Prisma, type Agent, type BillingStatus, type Organization, type PlanTier } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { usdToMicros } from "@/lib/money";
import { recordAudit } from "@/lib/services/audit";
import { emitAlerts } from "@/lib/services/alerts";
import { invalidateBudgetCache } from "@/lib/services/budgets";
import { afterAgentTransition, transitionAgentStatus } from "@/lib/services/agent-control";
import { invalidateBillingStatus } from "./gate";
import {
  PLAN_ENTITLEMENTS,
  capOverrideUsd,
  idOf,
  mapSubscriptionStatus,
  parsePricePlanMap,
  primaryPrice,
  resolvePlan,
  subscriptionPeriodEnd,
  type SubscriptionLike,
} from "./plans";

export const BILLING_ACTOR = { type: "SYSTEM" as const, id: "stripe-billing" };
/** Prefix on kill reasons written by billing; restoration only revives agents carrying it. */
export const BILLING_KILL_PREFIX = "[billing] ";
export const MANAGED_BY_BILLING = "billing";
const SWEEP_BATCH = 100;

export type SyncOutcome =
  | "synced"
  | "stale"
  | "unmapped_price"
  | "suspended"
  | "restored";

export async function findOrganizationForStripe(input: {
  customerId: string | null;
  metadataOrgId?: string | null;
}): Promise<Organization | null> {
  if (input.customerId) {
    const byCustomer = await prisma.organization.findUnique({ where: { stripeCustomerId: input.customerId } });
    if (byCustomer) return byCustomer;
  }
  if (input.metadataOrgId) {
    const org = await prisma.organization.findUnique({ where: { id: input.metadataOrgId } });
    // Only adopt the customer when the organization has none: never re-point a tenant's billing.
    if (org && input.customerId && !org.stripeCustomerId) {
      return prisma.organization.update({ where: { id: org.id }, data: { stripeCustomerId: input.customerId } });
    }
    return org && (!org.stripeCustomerId || org.stripeCustomerId === input.customerId) ? org : null;
  }
  return null;
}

/**
 * Keep the billing-managed organization budget in line with the plan.
 * Returns the new cap in USD, or null when the plan has no ceiling.
 */
async function applyPlanEntitlements(
  tx: Prisma.TransactionClient,
  organizationId: string,
  plan: PlanTier,
  overrideUsd: number | null,
): Promise<number | null> {
  const cap = overrideUsd ?? PLAN_ENTITLEMENTS[plan].monthlySpendCapUsd;
  const where = { organizationId_managedBy: { organizationId, managedBy: MANAGED_BY_BILLING } };
  if (cap === null) {
    await tx.budget.updateMany({ where: { organizationId, managedBy: MANAGED_BY_BILLING }, data: { isActive: false } });
    return null;
  }
  await tx.budget.upsert({
    where,
    create: {
      organizationId,
      scope: "ORGANIZATION",
      name: `${PLAN_ENTITLEMENTS[plan].label} plan monthly ceiling`,
      period: "MONTHLY",
      limitMicros: usdToMicros(cap),
      enforcement: "BLOCK",
      alertThresholds: [80, 90, 100],
      managedBy: MANAGED_BY_BILLING,
    },
    update: {
      name: `${PLAN_ENTITLEMENTS[plan].label} plan monthly ceiling`,
      limitMicros: usdToMicros(cap),
      isActive: true,
    },
  });
  return cap;
}

/**
 * Apply a subscription's state to the organization: plan tier, billing status,
 * period end and the billing-managed spend ceiling. Events older than the last
 * applied one are ignored (Stripe does not guarantee delivery order).
 */
export async function syncSubscription(input: {
  org: Organization;
  subscription: SubscriptionLike;
  eventCreated: Date;
  eventId: string;
}): Promise<SyncOutcome> {
  const { org, subscription, eventCreated, eventId } = input;
  if (org.billingSyncedAt && eventCreated < org.billingSyncedAt) {
    logger.info("billing.stale_subscription_event", { organizationId: org.id, eventId });
    return "stale";
  }

  const priceMap = parsePricePlanMap(env().STRIPE_PRICE_PLAN_MAP);
  const price = primaryPrice(subscription, priceMap);
  const resolved = price ? resolvePlan(price, priceMap) : null;
  const mapped = mapSubscriptionStatus(subscription.status);
  const plan: PlanTier = mapped.downgradeToFree ? "FREE" : resolved ?? org.plan;
  const policy = env().BILLING_SUSPEND_POLICY;

  // A suspended organization stays suspended until the subscription is healthy again or ends.
  // An unpaid/paused subscription is moved to SUSPENDED by suspendOrganization (not here), so the
  // org-level gate and the agent sweep always change together; with policy "never" it is PAST_DUE.
  const healthy = mapped.billingStatus === "ACTIVE" || mapped.billingStatus === "TRIALING" || mapped.billingStatus === "CANCELED";
  let nextStatus: BillingStatus;
  if (org.billingStatus === "SUSPENDED" && !healthy) nextStatus = "SUSPENDED";
  else if (mapped.billingStatus === "SUSPENDED") nextStatus = policy === "never" ? "PAST_DUE" : org.billingStatus;
  else nextStatus = mapped.billingStatus;

  const cap = await prisma.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: org.id },
      data: {
        plan,
        billingStatus: nextStatus,
        stripeSubscriptionId: mapped.downgradeToFree ? null : subscription.id,
        stripePriceId: price?.id ?? null,
        currentPeriodEnd: subscriptionPeriodEnd(subscription),
        billingSyncedAt: eventCreated,
        stripeCustomerId: org.stripeCustomerId ?? idOf(subscription.customer),
      },
    });
    const newCap = await applyPlanEntitlements(tx, org.id, plan, capOverrideUsd(subscription));
    await recordAudit(
      {
        organizationId: org.id,
        actorType: BILLING_ACTOR.type,
        actorId: BILLING_ACTOR.id,
        action: "billing.subscription_synced",
        targetType: "organization",
        targetId: org.id,
        before: { plan: org.plan, billingStatus: org.billingStatus, stripePriceId: org.stripePriceId },
        after: { plan, billingStatus: nextStatus, stripePriceId: price?.id ?? null, monthlyCapUsd: newCap, subscriptionStatus: subscription.status },
        requestId: eventId,
      },
      tx,
    );
    return newCap;
  });

  await Promise.all([invalidateBudgetCache(org.id), invalidateBillingStatus(org.id)]);
  logger.info("billing.subscription_synced", { organizationId: org.id, plan, status: nextStatus, capUsd: cap, eventId });

  if (mapped.suspend && policy !== "never") {
    await suspendOrganization({ org: { ...org, billingStatus: nextStatus }, reason: `Subscription is ${subscription.status}`, invoiceId: null, eventId });
    return "suspended";
  }
  if (org.billingStatus === "SUSPENDED" && healthy) {
    await restoreOrganization({ organizationId: org.id, eventId, invoiceId: null, statusAfter: nextStatus });
    return "restored";
  }
  if (!resolved && !mapped.downgradeToFree) {
    logger.warn("billing.unmapped_price", { organizationId: org.id, priceId: price?.id ?? null, eventId });
    return "unmapped_price";
  }
  return "synced";
}

export interface SuspensionResult {
  suspensionId: string;
  agentsStopped: number;
}

/**
 * Stop the organization for non-payment.
 *
 * 1. The org-level gate flips to SUSPENDED first, so /authorize refuses every
 *    request (including brand-new agents) the moment this commits.
 * 2. Every ACTIVE agent is then killed through the shared kill-switch state
 *    machine in batches, each batch in its own transaction, and the suspension
 *    row records exactly which agents it stopped.
 *
 * Idempotent per source event: a retried webhook resumes the sweep.
 */
export async function suspendOrganization(input: {
  org: Pick<Organization, "id" | "name" | "billingStatus">;
  reason: string;
  invoiceId: string | null;
  eventId: string;
}): Promise<SuspensionResult> {
  const { org, reason, invoiceId, eventId } = input;

  const suspension = await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: org.id }, data: { billingStatus: "SUSPENDED" } });
    const existing = await tx.billingSuspension.findUnique({
      where: { organizationId_sourceEventId: { organizationId: org.id, sourceEventId: eventId } },
    });
    const row =
      existing ??
      (await tx.billingSuspension.create({
        data: { organizationId: org.id, reason, stripeInvoiceId: invoiceId, sourceEventId: eventId, agentIds: [] },
      }));
    if (!existing) {
      await recordAudit(
        {
          organizationId: org.id,
          actorType: BILLING_ACTOR.type,
          actorId: BILLING_ACTOR.id,
          action: "billing.suspended",
          targetType: "organization",
          targetId: org.id,
          before: { billingStatus: org.billingStatus },
          after: { billingStatus: "SUSPENDED", reason, invoiceId, suspensionId: row.id },
          requestId: eventId,
        },
        tx,
      );
    }
    return row;
  });
  await invalidateBillingStatus(org.id);

  let stopped = 0;
  for (;;) {
    const batch = await prisma.agent.findMany({
      where: { organizationId: org.id, status: "ACTIVE" },
      select: { id: true },
      orderBy: { id: "asc" },
      take: SWEEP_BATCH,
    });
    if (batch.length === 0) break;

    const changed = await prisma.$transaction(
      async (tx) => {
        const killed: Agent[] = [];
        for (const { id } of batch) {
          const result = await transitionAgentStatus(tx, {
            agentId: id,
            organizationId: org.id,
            to: "KILLED",
            reason: `${BILLING_KILL_PREFIX}${reason}. Pay the outstanding invoice to resume automatically.`,
            actor: BILLING_ACTOR,
            requestId: eventId,
            expectFrom: ["ACTIVE"],
          });
          if (result.changed && result.agent) killed.push(result.agent);
        }
        if (killed.length) {
          await tx.billingSuspension.update({ where: { id: suspension.id }, data: { agentIds: { push: killed.map((a) => a.id) } } });
        }
        return killed;
      },
      { timeout: 30_000 },
    );

    await Promise.all(changed.map((a) => afterAgentTransition(a)));
    stopped += changed.length;
    // Every agent in the batch lost a race to another transition: nothing left to stop.
    if (changed.length === 0) break;
  }

  await emitAlerts([
    {
      organizationId: org.id,
      type: "BILLING_SUSPENDED",
      severity: "CRITICAL",
      dedupeKey: `billing-suspended:${suspension.id}`,
      message: `${org.name}: all agents were stopped because of a billing problem (${reason}). ${stopped} running agent${stopped === 1 ? "" : "s"} stopped. Pay the outstanding invoice to resume automatically.`,
      payload: { suspensionId: suspension.id, invoiceId, agentsStopped: stopped },
    },
  ]);
  logger.warn("billing.organization_suspended", { organizationId: org.id, suspensionId: suspension.id, agentsStopped: stopped, eventId });
  return { suspensionId: suspension.id, agentsStopped: stopped };
}

/**
 * Lift suspensions and revive exactly the agents they stopped. Agents an admin
 * stopped for other reasons in the meantime (different kill reason) stay
 * stopped. With `invoiceId`, only suspensions caused by that invoice are lifted;
 * the organization returns to `statusAfter` only when none remain.
 */
export async function restoreOrganization(input: {
  organizationId: string;
  eventId: string;
  invoiceId: string | null;
  statusAfter: BillingStatus;
}): Promise<{ lifted: number; agentsRestored: number; stillSuspended: boolean }> {
  const { organizationId, eventId, invoiceId, statusAfter } = input;
  const open = await prisma.billingSuspension.findMany({ where: { organizationId, liftedAt: null } });
  const toLift = invoiceId ? open.filter((s) => s.stripeInvoiceId === invoiceId) : open;
  const remaining = open.length - toLift.length;

  const org = await prisma.$transaction(async (tx) => {
    if (toLift.length) {
      await tx.billingSuspension.updateMany({
        where: { id: { in: toLift.map((s) => s.id) } },
        data: { liftedAt: new Date(), liftedByEventId: eventId },
      });
    }
    const current = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const nextStatus: BillingStatus = remaining > 0 ? "SUSPENDED" : current.billingStatus === "SUSPENDED" || current.billingStatus === "PAST_DUE" ? statusAfter : current.billingStatus;
    const updated = await tx.organization.update({ where: { id: organizationId }, data: { billingStatus: nextStatus } });
    if (toLift.length || current.billingStatus !== nextStatus) {
      await recordAudit(
        {
          organizationId,
          actorType: BILLING_ACTOR.type,
          actorId: BILLING_ACTOR.id,
          action: "billing.restored",
          targetType: "organization",
          targetId: organizationId,
          before: { billingStatus: current.billingStatus },
          after: { billingStatus: nextStatus, liftedSuspensions: toLift.map((s) => s.id), remainingSuspensions: remaining },
          requestId: eventId,
        },
        tx,
      );
    }
    return updated;
  });
  await invalidateBillingStatus(organizationId);

  const agentIds = Array.from(new Set(toLift.flatMap((s) => s.agentIds)));
  let restored = 0;
  if (remaining === 0) {
    for (let i = 0; i < agentIds.length; i += SWEEP_BATCH) {
      const chunk = agentIds.slice(i, i + SWEEP_BATCH);
      const revived = await prisma.$transaction(
        async (tx) => {
          const candidates = await tx.agent.findMany({
            where: { id: { in: chunk }, organizationId, status: "KILLED", killReason: { startsWith: BILLING_KILL_PREFIX } },
            select: { id: true },
          });
          const out: Agent[] = [];
          for (const { id } of candidates) {
            const result = await transitionAgentStatus(tx, {
              agentId: id,
              organizationId,
              to: "ACTIVE",
              reason: "Billing restored",
              actor: BILLING_ACTOR,
              requestId: eventId,
              expectFrom: ["KILLED"],
            });
            if (result.changed && result.agent) out.push(result.agent);
          }
          return out;
        },
        { timeout: 30_000 },
      );
      await Promise.all(revived.map((a) => afterAgentTransition(a)));
      restored += revived.length;
    }
  }

  if (toLift.length > 0 && remaining === 0) {
    await emitAlerts([
      {
        organizationId,
        type: "BILLING_RESTORED",
        severity: "INFO",
        dedupeKey: `billing-restored:${eventId}`,
        message: `${org.name}: billing is back in good standing. ${restored} agent${restored === 1 ? " was" : "s were"} restarted automatically.`,
        payload: { agentsRestored: restored, liftedSuspensions: toLift.length },
      },
    ]);
  }
  logger.info("billing.organization_restored", { organizationId, lifted: toLift.length, remaining, agentsRestored: restored, eventId });
  return { lifted: toLift.length, agentsRestored: restored, stillSuspended: remaining > 0 };
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
