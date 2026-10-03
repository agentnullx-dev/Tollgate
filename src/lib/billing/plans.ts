import type { BillingStatus, PlanTier } from "@prisma/client";

/**
 * Pure billing rules: plan resolution, entitlements, status mapping and
 * version-tolerant accessors for Stripe objects. No Stripe SDK types are used
 * here on purpose: Stripe moved `invoice.subscription` and
 * `subscription.current_period_end` in its 2025 API versions, and these
 * structural types accept both shapes.
 */

export interface PriceLike {
  id: string;
  lookup_key?: string | null;
  metadata?: Record<string, string> | null;
  product?: string | { id: string; metadata?: Record<string, string> | null; deleted?: boolean } | null;
}

export interface SubscriptionItemLike {
  price: PriceLike;
  quantity?: number | null;
  current_period_end?: number | null;
}

export interface SubscriptionLike {
  id: string;
  status: string;
  customer: string | { id: string };
  metadata?: Record<string, string> | null;
  cancel_at_period_end?: boolean | null;
  current_period_end?: number | null;
  items: { data: SubscriptionItemLike[] };
}

export interface InvoiceLike {
  id: string;
  number?: string | null;
  customer: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } | null; metadata?: Record<string, string> | null } | null } | null;
  attempt_count?: number | null;
  next_payment_attempt?: number | null;
  amount_due?: number | null;
  currency?: string | null;
  billing_reason?: string | null;
  hosted_invoice_url?: string | null;
}

export interface CheckoutSessionLike {
  id: string;
  mode?: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
}

export interface PlanEntitlement {
  label: string;
  /** Organization-wide monthly spend ceiling enforced by a billing-managed budget; null = no ceiling. */
  monthlySpendCapUsd: number | null;
}

export const PLAN_ENTITLEMENTS: Record<PlanTier, PlanEntitlement> = {
  FREE: { label: "Free", monthlySpendCapUsd: 50 },
  TEAM: { label: "Team", monthlySpendCapUsd: 2_000 },
  BUSINESS: { label: "Business", monthlySpendCapUsd: 25_000 },
  ENTERPRISE: { label: "Enterprise", monthlySpendCapUsd: null },
};

const PLAN_VALUES: readonly PlanTier[] = ["FREE", "TEAM", "BUSINESS", "ENTERPRISE"];

function asPlan(value: unknown): PlanTier | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return (PLAN_VALUES as readonly string[]).includes(upper) ? (upper as PlanTier) : null;
}

export function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

export function parsePricePlanMap(raw: string | undefined): Record<string, PlanTier> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("STRIPE_PRICE_PLAN_MAP must be a JSON object of price id to plan.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("STRIPE_PRICE_PLAN_MAP must be a JSON object.");
  const out: Record<string, PlanTier> = {};
  for (const [priceId, plan] of Object.entries(parsed as Record<string, unknown>)) {
    const p = asPlan(plan);
    if (!p) throw new Error(`STRIPE_PRICE_PLAN_MAP has an unknown plan for ${priceId}.`);
    out[priceId] = p;
  }
  return out;
}

/**
 * Resolve the plan a price grants, in priority order:
 * price metadata `tollgate_plan`, product metadata `tollgate_plan`,
 * lookup key `tollgate_<plan>_*`, then the STRIPE_PRICE_PLAN_MAP fallback.
 */
export function resolvePlan(price: PriceLike, priceMap: Record<string, PlanTier> = {}): PlanTier | null {
  const fromPrice = asPlan(price.metadata?.tollgate_plan);
  if (fromPrice) return fromPrice;
  if (price.product && typeof price.product === "object" && !price.product.deleted) {
    const fromProduct = asPlan(price.product.metadata?.tollgate_plan);
    if (fromProduct) return fromProduct;
  }
  const lookup = price.lookup_key ? /^tollgate[_-](free|team|business|enterprise)(?:[_-]|$)/i.exec(price.lookup_key) : null;
  if (lookup?.[1]) return asPlan(lookup[1]);
  return priceMap[price.id] ?? null;
}

/** Optional per-customer override, e.g. negotiated enterprise caps: metadata `tollgate_monthly_cap_usd`. */
export function capOverrideUsd(subscription: SubscriptionLike): number | null {
  const raw = subscription.metadata?.tollgate_monthly_cap_usd ?? subscription.items.data[0]?.price.metadata?.tollgate_monthly_cap_usd;
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 10_000_000 ? Math.round(n * 100) / 100 : null;
}

export interface MappedStatus {
  billingStatus: BillingStatus;
  /** The subscription no longer grants a paid plan. */
  downgradeToFree: boolean;
  /** The subscription state itself warrants stopping agents (subject to policy). */
  suspend: boolean;
}

export function mapSubscriptionStatus(status: string): MappedStatus {
  switch (status) {
    case "active":
      return { billingStatus: "ACTIVE", downgradeToFree: false, suspend: false };
    case "trialing":
      return { billingStatus: "TRIALING", downgradeToFree: false, suspend: false };
    case "past_due":
    case "incomplete":
      return { billingStatus: "PAST_DUE", downgradeToFree: false, suspend: false };
    case "unpaid":
    case "paused":
      return { billingStatus: "SUSPENDED", downgradeToFree: false, suspend: true };
    case "canceled":
    case "incomplete_expired":
      return { billingStatus: "CANCELED", downgradeToFree: true, suspend: false };
    default:
      return { billingStatus: "PAST_DUE", downgradeToFree: false, suspend: false };
  }
}

export type SuspendPolicy = "immediate" | "final_attempt" | "never";

export function shouldSuspendForInvoice(policy: SuspendPolicy, invoice: InvoiceLike): boolean {
  if (policy === "never") return false;
  if (policy === "immediate") return true;
  // final_attempt: Stripe sets next_payment_attempt to null when no retries remain.
  return invoice.next_payment_attempt === null || invoice.next_payment_attempt === undefined;
}

/** Subscription id of an invoice across API versions (pre-2025 `subscription`, 2025+ `parent.subscription_details`). */
export function invoiceSubscriptionId(invoice: InvoiceLike): string | null {
  return idOf(invoice.parent?.subscription_details?.subscription ?? null) ?? idOf(invoice.subscription ?? null);
}

/** Current period end across API versions (pre-2025 on the subscription, 2025+ on items). */
export function subscriptionPeriodEnd(subscription: SubscriptionLike): Date | null {
  const fromItems = subscription.items.data
    .map((i) => i.current_period_end)
    .filter((v): v is number => typeof v === "number");
  const seconds = fromItems.length ? Math.max(...fromItems) : subscription.current_period_end ?? null;
  return seconds ? new Date(seconds * 1000) : null;
}

/** The plan-bearing price: the first item whose price resolves to a plan, else the first item. */
export function primaryPrice(subscription: SubscriptionLike, priceMap: Record<string, PlanTier>): PriceLike | null {
  const items = subscription.items.data;
  return items.find((i) => resolvePlan(i.price, priceMap) !== null)?.price ?? items[0]?.price ?? null;
}

export function formatMoney(amountMinor: number | null | undefined, currency: string | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined) return "an amount";
  const code = (currency ?? "usd").toUpperCase();
  try {
    // Stripe amounts are in the currency's minor unit, which is not always cents (e.g. JPY has none).
    const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(amountMinor / 10 ** digits);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${code}`;
  }
}
