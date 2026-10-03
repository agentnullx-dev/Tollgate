import { z } from "zod";

const MAX_TOKENS = 10_000_000;

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:\-/]*$/, "Use letters, digits and . _ : - / only, starting with a letter or digit.");

const provider = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Provider must be a lowercase slug, e.g. 'anthropic'.");

const model = z.string().trim().min(1).max(128);

const tokenCount = z.number().int().min(0).max(MAX_TOKENS);

const metadata = z
  .record(z.string().max(64), z.union([z.string().max(512), z.number(), z.boolean(), z.null()]))
  .refine((obj) => Object.keys(obj).length <= 32, "metadata may contain at most 32 keys.")
  .optional();

// ---------------------------------------------------------------------------
// POST /api/v1/authorize
// ---------------------------------------------------------------------------

export const AuthorizeRequestSchema = z
  .object({
    agentKey: identifier,
    agentName: z.string().trim().min(1).max(120).optional(),
    provider,
    model,
    estimatedInputTokens: tokenCount,
    estimatedCachedInputTokens: tokenCount.default(0),
    maxOutputTokens: tokenCount.refine((v) => v > 0, "maxOutputTokens must be greater than zero."),
    traceId: z.string().max(128).optional(),
    metadata,
  })
  .strict();

export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;

// ---------------------------------------------------------------------------
// POST /api/v1/usage
// ---------------------------------------------------------------------------

export const UsageEventInputSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(128),
    reservationId: z.string().trim().min(1).max(64).optional(),
    agentKey: identifier,
    provider,
    model,
    inputTokens: tokenCount,
    outputTokens: tokenCount,
    cachedInputTokens: tokenCount.default(0),
    latencyMs: z.number().int().min(0).max(3_600_000).optional(),
    status: z.enum(["SUCCESS", "ERROR", "CANCELLED"]).default("SUCCESS"),
    traceId: z.string().max(128).optional(),
    occurredAt: z.coerce.date().optional(),
    metadata,
  })
  .strict();

export const UsageIngestRequestSchema = z
  .object({
    events: z.array(UsageEventInputSchema).min(1).max(500),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.events.forEach((event, index) => {
      if (seen.has(event.idempotencyKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["events", index, "idempotencyKey"],
          message: "Duplicate idempotencyKey within the same batch.",
        });
      }
      seen.add(event.idempotencyKey);
    });
  });

export type UsageEventInput = z.infer<typeof UsageEventInputSchema>;

export const UsageQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    groupBy: z.enum(["day", "agent", "model"]).default("day"),
    agentId: z.string().min(1).max(64).optional(),
  })
  .transform((q) => {
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 7 * 86_400_000);
    return { ...q, from, to };
  })
  .superRefine((q, ctx) => {
    if (q.from >= q.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "'from' must be earlier than 'to'." });
    }
    if (q.to.getTime() - q.from.getTime() > 92 * 86_400_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "Query range cannot exceed 92 days." });
    }
  });

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

const usdAmount = z
  .number()
  .positive()
  .max(10_000_000)
  .refine((v) => Math.round(v * 1_000_000) / 1_000_000 === v, "limitUsd supports at most 6 decimal places.");

const thresholds = z
  .array(z.number().int().min(1).max(500))
  .max(10)
  .transform((arr) => Array.from(new Set(arr)).sort((a, b) => a - b));

export const CreateBudgetSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scope: z.enum(["ORGANIZATION", "PROJECT", "AGENT"]),
    projectId: z.string().min(1).max(64).optional(),
    agentId: z.string().min(1).max(64).optional(),
    period: z.enum(["DAILY", "WEEKLY", "MONTHLY", "TOTAL"]),
    limitUsd: usdAmount,
    enforcement: z.enum(["BLOCK", "ALERT_ONLY"]).default("BLOCK"),
    alertThresholds: thresholds.default([50, 80, 100]),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.scope === "ORGANIZATION" && (b.projectId || b.agentId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "Organization budgets cannot target a project or agent." });
    }
    if (b.scope === "PROJECT" && (!b.projectId || b.agentId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projectId"], message: "Project budgets require projectId and no agentId." });
    }
    if (b.scope === "AGENT" && !b.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agentId"], message: "Agent budgets require agentId." });
    }
  });

export type CreateBudgetInput = z.infer<typeof CreateBudgetSchema>;

export const UpdateBudgetSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    limitUsd: usdAmount.optional(),
    enforcement: z.enum(["BLOCK", "ALERT_ONLY"]).optional(),
    alertThresholds: thresholds.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "Provide at least one field to update.");

export type UpdateBudgetInput = z.infer<typeof UpdateBudgetSchema>;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const UpdateAgentSchema = z
  .object({
    // QUARANTINED is set only by the anomaly engine and cannot be requested.
    status: z.enum(["ACTIVE", "PAUSED", "KILLED"]).optional(),
    enforcementMode: z.enum(["STRICT", "ALERT_ONLY"]).optional(),
    /** How open incidents are closed when a quarantined agent is released. */
    incidentResolution: z.enum(["RESOLVED", "FALSE_POSITIVE"]).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    maxRequestsPerMinute: z.number().int().min(1).max(100_000).nullable().optional(),
    autoKillOnVelocity: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "Provide at least one field to update.")
  .refine((b) => b.status !== "KILLED" || !!b.reason, {
    message: "A reason is required when killing an agent.",
    path: ["reason"],
  });

export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;

// ---------------------------------------------------------------------------
// Notification channels
// ---------------------------------------------------------------------------

const severity = z.enum(["INFO", "WARNING", "CRITICAL"]);
const alertType = z.enum([
  "BUDGET_THRESHOLD",
  "BUDGET_BLOCKED",
  "BUDGET_LIMIT_BYPASSED",
  "VELOCITY_LIMIT",
  "AGENT_KILLED",
  "AGENT_QUARANTINED",
  "ANOMALY_DETECTED",
  "BILLING_SUSPENDED",
  "BILLING_RESTORED",
]);

export const CreateChannelSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SLACK"),
    name: z.string().trim().min(1).max(120),
    webhookUrl: z.string().url().max(2048),
    minSeverity: severity.default("WARNING"),
    alertTypes: z.array(alertType).max(10).default([]),
  }).strict(),
  z.object({
    type: z.literal("TEAMS"),
    name: z.string().trim().min(1).max(120),
    webhookUrl: z.string().url().max(2048),
    minSeverity: severity.default("WARNING"),
    alertTypes: z.array(alertType).max(10).default([]),
  }).strict(),
  z.object({
    type: z.literal("WEBHOOK"),
    name: z.string().trim().min(1).max(120),
    webhookUrl: z.string().url().max(2048),
    signingSecret: z.string().min(16).max(256).optional(),
    minSeverity: severity.default("WARNING"),
    alertTypes: z.array(alertType).max(10).default([]),
  }).strict(),
  z.object({
    type: z.literal("EMAIL"),
    name: z.string().trim().min(1).max(120),
    recipients: z.array(z.string().trim().email().max(254)).min(1).max(50),
    minSeverity: severity.default("WARNING"),
    alertTypes: z.array(alertType).max(10).default([]),
  }).strict(),
]);

export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const UpdateChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    minSeverity: severity.optional(),
    alertTypes: z.array(alertType).max(10).optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "Provide at least one field to update.");

export const IncidentQuerySchema = z.object({
  status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "FALSE_POSITIVE"]).optional(),
  agentId: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Console: API keys
// ---------------------------------------------------------------------------

export const API_KEY_SCOPES = [
  "gateway:authorize",
  "usage:write",
  "usage:read",
  "budgets:read",
  "budgets:write",
  "agents:write",
  "org:admin",
] as const;

/** Scopes a developer may grant; anything else needs an admin. */
export const DEVELOPER_GRANTABLE_SCOPES: ReadonlySet<string> = new Set(["gateway:authorize", "usage:write", "usage:read", "budgets:read"]);

export const CreateApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    projectId: z.string().min(1).max(64),
    scopes: z
      .array(z.enum(API_KEY_SCOPES))
      .min(1)
      .max(API_KEY_SCOPES.length)
      .transform((s) => Array.from(new Set(s))),
    expiresInDays: z.number().int().min(1).max(730).optional(),
  })
  .strict();
