import Stripe from "stripe";
import { env } from "@/lib/env";

const globalForStripe = globalThis as unknown as { __tollgateStripe?: Stripe };

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  toleranceSeconds: number;
  livemode: boolean;
}

/** Null when billing is not configured for this deployment. */
export function stripeConfig(): StripeConfig | null {
  const e = env();
  if (!e.STRIPE_SECRET_KEY || !e.STRIPE_WEBHOOK_SECRET) return null;
  return {
    secretKey: e.STRIPE_SECRET_KEY,
    webhookSecret: e.STRIPE_WEBHOOK_SECRET,
    toleranceSeconds: e.STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    livemode: /_live_/.test(e.STRIPE_SECRET_KEY),
  };
}

/** API version is pinned by the installed SDK, which keeps request and response types consistent. */
export function stripe(): Stripe {
  const cfg = stripeConfig();
  if (!cfg) throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.");
  if (!globalForStripe.__tollgateStripe) {
    globalForStripe.__tollgateStripe = new Stripe(cfg.secretKey, {
      maxNetworkRetries: 2,
      timeout: 10_000,
      appInfo: { name: "Tollgate", version: "1.0.0" },
    });
  }
  return globalForStripe.__tollgateStripe;
}
