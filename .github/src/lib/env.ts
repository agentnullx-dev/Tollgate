import { z } from "zod";

const DEV_ENCRYPTION_KEY = "ZGV2LW9ubHktdG9sbGdhdGUta2V5LWRvLW5vdC11c2U="; // 32 bytes, development only

const boolish = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    APP_BASE_URL: z.string().url().default("http://localhost:3000"),

    // Gateway
    RESERVATION_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
    API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(1200),
    CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // Notifications
    NOTIFICATION_ENCRYPTION_KEY: z.string().optional(),
    NOTIFY_HTTP_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(8000),
    NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(30).default(10),
    NOTIFY_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(2000),
    NOTIFY_BACKOFF_MAX_MS: z.coerce.number().int().min(1000).max(86_400_000).default(30 * 60_000),
    NOTIFY_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(16),
    NOTIFY_LEASE_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
    NOTIFY_ALLOW_PRIVATE_WEBHOOKS: boolish.default("false"),
    EMAIL_FROM: z.string().min(3).default("Tollgate Alerts <alerts@tollgate.local>"),
    SMTP_URL: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),

    // Anomaly engine
    ANOMALY_TICK_MS: z.coerce.number().int().min(1000).max(300_000).default(15_000),
    ANOMALY_SIGMA: z.coerce.number().min(1).max(10).default(3),
    ANOMALY_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
    ANOMALY_BASELINE_MINUTES: z.coerce.number().int().min(15).max(1440).default(60),
    ANOMALY_MIN_HISTORY_MINUTES: z.coerce.number().int().min(5).max(10_080).default(30),
    ANOMALY_MIN_WINDOW_SPEND_USD: z.coerce.number().min(0).max(100_000).default(1),
    ANOMALY_AUTO_QUARANTINE: boolish.default("true"),

    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(9100),

    // Billing
    STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_(live|test)_/, "Must be a Stripe secret or restricted key.").optional(),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    /** JSON map of Stripe price id -> plan, e.g. {"price_123":"TEAM"}; used when prices carry no metadata. */
    STRIPE_PRICE_PLAN_MAP: z.string().optional(),
    /**
     * When a failed invoice stops the organization's agents:
     *   immediate     on the first failed payment attempt
     *   final_attempt only when Stripe has no retries left
     *   never         record and alert only
     */
    BILLING_SUSPEND_POLICY: z.enum(["immediate", "final_attempt", "never"]).default("immediate"),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === "production" && !e.NOTIFICATION_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NOTIFICATION_ENCRYPTION_KEY"],
        message: "NOTIFICATION_ENCRYPTION_KEY is required in production (32 random bytes, base64).",
      });
    }
    if (e.NOTIFICATION_ENCRYPTION_KEY && Buffer.from(e.NOTIFICATION_ENCRYPTION_KEY, "base64").length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NOTIFICATION_ENCRYPTION_KEY"],
        message: "NOTIFICATION_ENCRYPTION_KEY must decode to exactly 32 bytes.",
      });
    }
  })
  .transform((e) => ({
    ...e,
    NOTIFICATION_ENCRYPTION_KEY: e.NOTIFICATION_ENCRYPTION_KEY ?? DEV_ENCRYPTION_KEY,
  }));

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Lazily validated environment. Validation is deferred to first use so that
 * `next build` can import route modules without runtime secrets present.
 */
export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached environment so a test can change process.env. */
export function resetEnvCache(): void {
  cached = null;
}
