import { describe, expect, it } from "vitest";
import {
  capOverrideUsd,
  formatMoney,
  invoiceSubscriptionId,
  mapSubscriptionStatus,
  parsePricePlanMap,
  primaryPrice,
  resolvePlan,
  shouldSuspendForInvoice,
  subscriptionPeriodEnd,
  type SubscriptionLike,
} from "@/lib/billing/plans";

const sub = (over: Partial<SubscriptionLike> = {}): SubscriptionLike => ({
  id: "sub_1",
  status: "active",
  customer: "cus_1",
  metadata: {},
  items: { data: [{ price: { id: "price_team", lookup_key: "tollgate_team_monthly", metadata: {} }, current_period_end: 1_790_000_000 }] },
  ...over,
});

describe("plan resolution", () => {
  it("prefers price metadata, then product metadata, then lookup key, then the env map", () => {
    expect(resolvePlan({ id: "p", metadata: { tollgate_plan: "business" }, lookup_key: "tollgate_team" })).toBe("BUSINESS");
    expect(resolvePlan({ id: "p", product: { id: "prod", metadata: { tollgate_plan: "enterprise" } } })).toBe("ENTERPRISE");
    expect(resolvePlan({ id: "p", lookup_key: "tollgate_team_annual" })).toBe("TEAM");
    expect(resolvePlan({ id: "price_x" }, { price_x: "BUSINESS" })).toBe("BUSINESS");
    expect(resolvePlan({ id: "price_unknown", lookup_key: "other_plan" })).toBeNull();
  });

  it("ignores deleted products and malformed lookup keys", () => {
    expect(resolvePlan({ id: "p", product: { id: "prod", deleted: true, metadata: { tollgate_plan: "team" } } })).toBeNull();
    expect(resolvePlan({ id: "p", lookup_key: "tollgate_teamwork" })).toBeNull();
  });

  it("validates the price map", () => {
    expect(parsePricePlanMap('{"price_1":"team"}')).toEqual({ price_1: "TEAM" });
    expect(() => parsePricePlanMap('{"price_1":"platinum"}')).toThrow();
    expect(() => parsePricePlanMap("not json")).toThrow();
    expect(parsePricePlanMap(undefined)).toEqual({});
  });

  it("picks the plan-bearing item among add-ons", () => {
    const s = sub({
      items: { data: [{ price: { id: "price_addon" } }, { price: { id: "price_biz", metadata: { tollgate_plan: "business" } } }] },
    });
    expect(primaryPrice(s, {})?.id).toBe("price_biz");
  });

  it("reads negotiated caps from metadata and rejects nonsense", () => {
    expect(capOverrideUsd(sub({ metadata: { tollgate_monthly_cap_usd: "75000" } }))).toBe(75000);
    expect(capOverrideUsd(sub({ metadata: { tollgate_monthly_cap_usd: "-5" } }))).toBeNull();
    expect(capOverrideUsd(sub())).toBeNull();
  });
});

describe("status mapping and suspension policy", () => {
  it("maps Stripe subscription states", () => {
    expect(mapSubscriptionStatus("active").billingStatus).toBe("ACTIVE");
    expect(mapSubscriptionStatus("trialing").billingStatus).toBe("TRIALING");
    expect(mapSubscriptionStatus("past_due")).toEqual({ billingStatus: "PAST_DUE", downgradeToFree: false, suspend: false });
    expect(mapSubscriptionStatus("unpaid").suspend).toBe(true);
    expect(mapSubscriptionStatus("canceled")).toEqual({ billingStatus: "CANCELED", downgradeToFree: true, suspend: false });
  });

  it("applies the invoice suspension policy", () => {
    const retrying = { id: "in_1", customer: "cus_1", next_payment_attempt: 1_790_000_000 };
    const final = { id: "in_1", customer: "cus_1", next_payment_attempt: null };
    expect(shouldSuspendForInvoice("immediate", retrying)).toBe(true);
    expect(shouldSuspendForInvoice("final_attempt", retrying)).toBe(false);
    expect(shouldSuspendForInvoice("final_attempt", final)).toBe(true);
    expect(shouldSuspendForInvoice("never", final)).toBe(false);
  });
});

describe("Stripe API version tolerance", () => {
  it("finds an invoice's subscription in both API shapes", () => {
    expect(invoiceSubscriptionId({ id: "in", customer: "c", subscription: "sub_old" })).toBe("sub_old");
    expect(invoiceSubscriptionId({ id: "in", customer: "c", parent: { subscription_details: { subscription: "sub_new" } } })).toBe("sub_new");
    expect(invoiceSubscriptionId({ id: "in", customer: "c", subscription: { id: "sub_obj" } })).toBe("sub_obj");
    expect(invoiceSubscriptionId({ id: "in", customer: "c" })).toBeNull();
  });

  it("finds the period end on items (2025+) or the subscription (older)", () => {
    expect(subscriptionPeriodEnd(sub())?.toISOString()).toBe(new Date(1_790_000_000_000).toISOString());
    const legacy = sub({ current_period_end: 1_780_000_000, items: { data: [{ price: { id: "p" } }] } });
    expect(subscriptionPeriodEnd(legacy)?.toISOString()).toBe(new Date(1_780_000_000_000).toISOString());
  });

  it("formats minor units per currency", () => {
    expect(formatMoney(12345, "usd")).toBe("$123.45");
    expect(formatMoney(5000, "jpy")).toBe("¥5,000");
  });
});
