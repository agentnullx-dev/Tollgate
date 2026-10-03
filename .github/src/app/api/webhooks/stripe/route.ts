import type Stripe from "stripe";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { StripeEventStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { stripe, stripeConfig } from "@/lib/billing/stripe";
import {
  findOrganizationForStripe,
  isUniqueViolation,
  restoreOrganization,
  suspendOrganization,
  syncSubscription,
} from "@/lib/billing/lifecycle";
import {
  formatMoney,
  idOf,
  invoiceSubscriptionId,
  shouldSuspendForInvoice,
  type CheckoutSessionLike,
  type InvoiceLike,
  type SubscriptionLike,
} from "@/lib/billing/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2_000_000;
/** A PROCESSING claim older than this is assumed abandoned (crashed instance) and may be retried. */
const STALE_CLAIM_MS = 5 * 60_000;

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

interface Outcome {
  status: Extract<StripeEventStatus, "PROCESSED" | "IGNORED">;
  outcome: string;
  organizationId: string | null;
}

const processed = (outcome: string, organizationId: string | null): Outcome => ({ status: "PROCESSED", outcome, organizationId });
const ignored = (outcome: string, organizationId: string | null = null): Outcome => ({ status: "IGNORED", outcome, organizationId });

function respond(status: number, body: Record<string, unknown>, requestId: string): NextResponse {
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

type Claim = "claimed" | "duplicate" | "in_progress";

/**
 * Claim an event for processing. The event id is the primary key, so two
 * deliveries of the same event cannot both claim it. FAILED events and
 * abandoned PROCESSING claims can be re-claimed when Stripe retries.
 */
async function claimEvent(event: Stripe.Event): Promise<Claim> {
  try {
    await prisma.stripeEvent.create({
      data: {
        id: event.id,
        type: event.type,
        status: "PROCESSING",
        livemode: event.livemode,
        stripeCreated: new Date(event.created * 1000),
      },
    });
    return "claimed";
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  const existing = await prisma.stripeEvent.findUnique({ where: { id: event.id } });
  if (!existing || existing.status === "PROCESSED" || existing.status === "IGNORED") return "duplicate";

  const reclaimed = await prisma.stripeEvent.updateMany({
    where: {
      id: event.id,
      OR: [{ status: "FAILED" }, { status: "PROCESSING", updatedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }],
    },
    data: { status: "PROCESSING", attempts: { increment: 1 }, error: null },
  });
  return reclaimed.count === 1 ? "claimed" : "in_progress";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(event: Stripe.Event): Promise<Outcome> {
  const session = event.data.object as unknown as CheckoutSessionLike;
  if (session.mode !== "subscription") return ignored("not_a_subscription_checkout");

  const orgId = session.client_reference_id ?? session.metadata?.tollgate_org_id ?? null;
  const customerId = idOf(session.customer ?? null);
  if (!orgId || !customerId) return ignored("missing_org_or_customer");

  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return ignored("unknown_organization");
  if (org.stripeCustomerId && org.stripeCustomerId !== customerId) {
    // Never re-point an organization's billing to a different customer from a webhook.
    logger.error("billing.customer_conflict", { organizationId: org.id, existing: org.stripeCustomerId, incoming: customerId, eventId: event.id });
    return ignored("customer_conflict", org.id);
  }

  let linked = org;
  if (!org.stripeCustomerId) {
    try {
      linked = await prisma.organization.update({ where: { id: org.id }, data: { stripeCustomerId: customerId } });
    } catch (err) {
      if (isUniqueViolation(err)) {
        logger.error("billing.customer_already_linked", { organizationId: org.id, customerId, eventId: event.id });
        return ignored("customer_linked_elsewhere", org.id);
      }
      throw err;
    }
  }

  const subscriptionId = idOf(session.subscription ?? null);
  if (!subscriptionId) return processed("customer_linked", org.id);

  // Fetch the authoritative subscription: the session carries only its id.
  const subscription = (await stripe().subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price.product"],
  })) as unknown as SubscriptionLike;
  const outcome = await syncSubscription({ org: linked, subscription, eventCreated: new Date(event.created * 1000), eventId: event.id });
  return processed(`checkout_${outcome}`, org.id);
}

async function handleSubscriptionEvent(event: Stripe.Event): Promise<Outcome> {
  const subscription = event.data.object as unknown as SubscriptionLike;
  const org = await findOrganizationForStripe({
    customerId: idOf(subscription.customer),
    metadataOrgId: subscription.metadata?.tollgate_org_id ?? null,
  });
  if (!org) return ignored("unknown_customer");

  // A deleted subscription arrives with status "canceled"; normalise in case of older API shapes.
  const effective: SubscriptionLike =
    event.type === "customer.subscription.deleted" && subscription.status !== "canceled" ? { ...subscription, status: "canceled" } : subscription;

  const outcome = await syncSubscription({ org, subscription: effective, eventCreated: new Date(event.created * 1000), eventId: event.id });
  return outcome === "stale" ? ignored("stale_event", org.id) : processed(outcome, org.id);
}

async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<Outcome> {
  const invoice = event.data.object as unknown as InvoiceLike;
  const org = await findOrganizationForStripe({
    customerId: idOf(invoice.customer),
    metadataOrgId: invoice.parent?.subscription_details?.metadata?.tollgate_org_id ?? null,
  });
  if (!org) return ignored("unknown_customer");

  const policy = env().BILLING_SUSPEND_POLICY;
  const label = invoice.number ?? invoice.id;
  const attempt = invoice.attempt_count ?? 1;
  const amount = formatMoney(invoice.amount_due, invoice.currency);

  if (!shouldSuspendForInvoice(policy, invoice)) {
    if (org.billingStatus !== "SUSPENDED") {
      await prisma.organization.update({ where: { id: org.id }, data: { billingStatus: "PAST_DUE" } });
    }
    logger.warn("billing.payment_failed_retrying", {
      organizationId: org.id,
      invoiceId: invoice.id,
      attempt,
      nextAttempt: invoice.next_payment_attempt ?? null,
      subscriptionId: invoiceSubscriptionId(invoice),
      policy,
    });
    return processed("past_due", org.id);
  }

  const result = await suspendOrganization({
    org,
    reason: `Payment of ${amount} for invoice ${label} failed (attempt ${attempt})`,
    invoiceId: invoice.id,
    eventId: event.id,
  });
  return processed(`suspended:${result.agentsStopped}`, org.id);
}

async function handleInvoicePaid(event: Stripe.Event): Promise<Outcome> {
  const invoice = event.data.object as unknown as InvoiceLike;
  const org = await findOrganizationForStripe({ customerId: idOf(invoice.customer) });
  if (!org) return ignored("unknown_customer");
  if (org.billingStatus !== "SUSPENDED" && org.billingStatus !== "PAST_DUE") return ignored("already_in_good_standing", org.id);

  const result = await restoreOrganization({ organizationId: org.id, eventId: event.id, invoiceId: invoice.id, statusAfter: "ACTIVE" });
  if (result.stillSuspended) return processed("partially_restored", org.id);
  return processed(`restored:${result.agentsRestored}`, org.id);
}

async function dispatch(event: Stripe.Event): Promise<Outcome> {
  if (SUBSCRIPTION_EVENTS.has(event.type)) return handleSubscriptionEvent(event);
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(event);
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(event);
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return handleInvoicePaid(event);
    default:
      return ignored("unhandled_event_type");
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * Stripe billing webhook.
 *
 * Responses follow Stripe's retry semantics: 2xx stops retries (processed,
 * ignored or duplicate), 4xx means the request itself is invalid (bad
 * signature), and 5xx asks Stripe to retry with backoff for up to three days.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const started = performance.now();

  const config = stripeConfig();
  if (!config) {
    logger.error("stripe.webhook_not_configured", { requestId });
    return respond(503, { error: "Billing is not configured." }, requestId);
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return respond(400, { error: "Missing Stripe-Signature header." }, requestId);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return respond(413, { error: "Payload too large." }, requestId);

  // The signature covers the exact bytes Stripe sent: verify the raw body, never re-serialised JSON.
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return respond(413, { error: "Payload too large." }, requestId);

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, config.webhookSecret, config.toleranceSeconds);
  } catch (err) {
    // Do not echo verification details to the caller.
    logger.warn("stripe.signature_rejected", { requestId, err: err instanceof Error ? err.message : String(err) });
    return respond(400, { error: "Invalid signature." }, requestId);
  }

  // A test-mode event must never change a live deployment, and vice versa.
  if (event.livemode !== config.livemode) {
    logger.warn("stripe.livemode_mismatch", { requestId, eventId: event.id, eventLivemode: event.livemode });
    return respond(200, { received: true, ignored: "livemode_mismatch" }, requestId);
  }

  let claim: Claim;
  try {
    claim = await claimEvent(event);
  } catch (err) {
    logger.error("stripe.claim_failed", { requestId, eventId: event.id, err });
    return respond(500, { error: "Could not record event." }, requestId);
  }
  if (claim === "duplicate") return respond(200, { received: true, duplicate: true }, requestId);
  // Another instance is processing this delivery right now; a 409 makes Stripe retry later.
  if (claim === "in_progress") return respond(409, { error: "Event is being processed." }, requestId);

  try {
    const result = await dispatch(event);
    await prisma.stripeEvent.update({
      where: { id: event.id },
      data: { status: result.status, outcome: result.outcome, organizationId: result.organizationId },
    });
    logger.info("stripe.webhook_handled", {
      requestId,
      eventId: event.id,
      type: event.type,
      status: result.status,
      outcome: result.outcome,
      organizationId: result.organizationId,
      durationMs: Math.round(performance.now() - started),
    });
    return respond(200, { received: true, status: result.status, outcome: result.outcome }, requestId);
  } catch (err) {
    logger.error("stripe.webhook_failed", { requestId, eventId: event.id, type: event.type, err });
    await prisma.stripeEvent
      .update({
        where: { id: event.id },
        data: { status: "FAILED", error: (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000) },
      })
      .catch((markErr) => logger.error("stripe.mark_failed_error", { requestId, eventId: event.id, err: markErr }));
    return respond(500, { error: "Processing failed; Stripe will retry." }, requestId);
  }
}
