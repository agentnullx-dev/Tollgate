import { describe, expect, it } from "vitest";
import { computeCostMicros, microsToUsd, usdToMicros, type ModelPricing } from "@/lib/money";
import { periodWindow } from "@/lib/periods";
import { generateApiKey, hashApiKey, parseApiKey } from "@/lib/auth";
import { sumReservationMembers } from "@/lib/redis";
import { CreateBudgetSchema, UsageIngestRequestSchema, UpdateAgentSchema, UsageQuerySchema } from "@/lib/schemas";
import { baseModelName } from "@/lib/services/pricing";

const sonnetLike: ModelPricing = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  inputMicrosPerMTok: 3_000_000n,
  outputMicrosPerMTok: 15_000_000n,
  cachedInputMicrosPerMTok: 300_000n,
};

describe("money", () => {
  it("prices tokens exactly in micro-USD", () => {
    // 10k in @ $3/M = $0.03, 2k out @ $15/M = $0.03, 5k cached @ $0.30/M = $0.0015
    expect(computeCostMicros(sonnetLike, { inputTokens: 10_000, outputTokens: 2_000, cachedInputTokens: 5_000 })).toBe(61_500n);
  });

  it("rounds fractional micros up so spend is never under-reported", () => {
    expect(computeCostMicros(sonnetLike, { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 })).toBe(3n);
    expect(computeCostMicros({ ...sonnetLike, inputMicrosPerMTok: 1n }, { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 })).toBe(1n);
  });

  it("returns zero for zero usage", () => {
    expect(computeCostMicros(sonnetLike, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })).toBe(0n);
  });

  it("converts between USD and micros without float drift", () => {
    expect(usdToMicros(0.1 + 0.2)).toBe(300_000n);
    expect(microsToUsd(1_234_567n)).toBeCloseTo(1.234567, 9);
    expect(microsToUsd(-2_500_000n)).toBe(-2.5);
  });
});

describe("periods", () => {
  const created = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-10-03T15:30:00Z"); // Saturday

  it("computes UTC daily windows", () => {
    const w = periodWindow("DAILY", now, created, now);
    expect(w.key).toBe("d:2026-10-03");
    expect(w.start.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(w.end?.toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });

  it("starts weekly windows on Monday", () => {
    const w = periodWindow("WEEKLY", now, created, now);
    expect(w.key).toBe("w:2026-09-28");
    expect(w.end?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("handles a Sunday as the last day of the ISO week", () => {
    const sunday = new Date("2026-10-04T23:59:59Z");
    expect(periodWindow("WEEKLY", sunday, created, sunday).key).toBe("w:2026-09-28");
  });

  it("computes monthly windows across year boundaries", () => {
    const dec = new Date("2026-12-31T23:00:00Z");
    const w = periodWindow("MONTHLY", dec, created, dec);
    expect(w.key).toBe("m:2026-12");
    expect(w.end?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("anchors lifetime budgets at creation", () => {
    const w = periodWindow("TOTAL", now, created, now);
    expect(w.key).toBe("all");
    expect(w.start).toEqual(created);
    expect(w.end).toBeNull();
  });
});

describe("api keys", () => {
  it("generates keys that round-trip through the parser", () => {
    const key = generateApiKey();
    expect(parseApiKey(key.plaintext)?.prefix).toBe(key.prefix);
    expect(hashApiKey(key.plaintext)).toBe(key.hashedKey);
  });

  it("rejects malformed keys", () => {
    expect(parseApiKey("tg_live_short_secret")).toBeNull();
    expect(parseApiKey("sk-not-a-tollgate-key")).toBeNull();
  });
});

describe("reservations", () => {
  it("sums reservation members and ignores malformed entries", () => {
    expect(sumReservationMembers(["res_a:1500", "res_b:2500", "garbage", "res_c:abc"])).toBe(4000n);
  });
});

describe("pricing aliases", () => {
  it("strips dated snapshot suffixes", () => {
    expect(baseModelName("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(baseModelName("gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });
});

describe("validation", () => {
  it("requires projectId for project budgets", () => {
    const result = CreateBudgetSchema.safeParse({ name: "x", scope: "PROJECT", period: "DAILY", limitUsd: 10 });
    expect(result.success).toBe(false);
  });

  it("normalizes alert thresholds", () => {
    const result = CreateBudgetSchema.parse({
      name: "Org",
      scope: "ORGANIZATION",
      period: "MONTHLY",
      limitUsd: 100,
      alertThresholds: [100, 50, 80, 50],
    });
    expect(result.alertThresholds).toEqual([50, 80, 100]);
  });

  it("rejects duplicate idempotency keys within a batch", () => {
    const event = {
      idempotencyKey: "evt-000001",
      agentKey: "bot",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 10,
    };
    expect(UsageIngestRequestSchema.safeParse({ events: [event, event] }).success).toBe(false);
  });

  it("requires a reason when killing an agent", () => {
    expect(UpdateAgentSchema.safeParse({ status: "KILLED" }).success).toBe(false);
    expect(UpdateAgentSchema.safeParse({ status: "KILLED", reason: "Loop detected" }).success).toBe(true);
  });

  it("caps usage query ranges at 92 days", () => {
    const result = UsageQuerySchema.safeParse({ from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" });
    expect(result.success).toBe(false);
  });
});
