import type Redis from "ioredis";
import { prisma } from "@/lib/prisma";
import { keys } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { emptyProfile, foldProfile, type DetectorConfig, type LongTermProfile, type MinuteSample } from "./detector";

const PROFILE_TTL_SECONDS = 14 * 86_400;

export interface StoredProfile {
  profile: LongTermProfile;
  /** First minute the agent was observed; drives the warm-up requirement. */
  firstSeenMinute: number;
  lastEvaluatedMinute: number;
}

const FIELDS = ["count", "mean", "variance", "tprCount", "tprMean", "tprVariance", "lastMinute", "firstSeenMinute", "lastEvaluatedMinute"] as const;

export async function loadProfiles(client: Redis, agentIds: string[]): Promise<Map<string, StoredProfile | null>> {
  const pipeline = client.pipeline();
  for (const id of agentIds) pipeline.hmget(keys.anomalyProfile(id), ...FIELDS);
  const results = (await pipeline.exec()) ?? [];
  const out = new Map<string, StoredProfile | null>();
  agentIds.forEach((id, i) => {
    const values = (results[i]?.[1] ?? []) as Array<string | null>;
    if (values.length === 0 || values[0] === null) {
      out.set(id, null);
      return;
    }
    const n = values.map((v) => Number(v ?? 0));
    out.set(id, {
      profile: {
        count: n[0]!,
        mean: n[1]!,
        variance: n[2]!,
        tprCount: n[3]!,
        tprMean: n[4]!,
        tprVariance: n[5]!,
        lastMinute: n[6]!,
      },
      firstSeenMinute: n[7]!,
      lastEvaluatedMinute: n[8]!,
    });
  });
  return out;
}

export async function saveProfile(client: Redis, agentId: string, stored: StoredProfile): Promise<void> {
  const p = stored.profile;
  const key = keys.anomalyProfile(agentId);
  await client
    .multi()
    .hset(key, {
      count: p.count,
      mean: p.mean,
      variance: p.variance,
      tprCount: p.tprCount,
      tprMean: p.tprMean,
      tprVariance: p.tprVariance,
      lastMinute: p.lastMinute,
      firstSeenMinute: stored.firstSeenMinute,
      lastEvaluatedMinute: stored.lastEvaluatedMinute,
    })
    .expire(key, PROFILE_TTL_SECONDS)
    .exec();
}

/**
 * Rebuild a missing profile from the Postgres ledger (Redis restart, new
 * replica, expired key). Folds the last `lookbackMinutes` of per-minute spend.
 */
export async function rebuildProfile(
  agentId: string,
  nowMinute: number,
  cfg: DetectorConfig,
  lookbackMinutes = 1440,
): Promise<StoredProfile> {
  const from = new Date((nowMinute - lookbackMinutes) * 60_000);
  const to = new Date((nowMinute - cfg.windowMinutes + 1) * 60_000);
  const [rows, first] = await Promise.all([
    prisma.$queryRaw<Array<{ minute: Date; cost: bigint; requests: bigint; tokens: bigint }>>`
      SELECT date_trunc('minute', "createdAt") AS minute,
             COALESCE(SUM("costMicros"), 0)::bigint AS cost,
             COUNT(*)::bigint AS requests,
             COALESCE(SUM("inputTokens" + "outputTokens" + "cachedInputTokens"), 0)::bigint AS tokens
      FROM "usage_events"
      WHERE "agentId" = ${agentId} AND "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY minute
    `,
    prisma.usageEvent.findFirst({ where: { agentId }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);

  const series = new Map<number, MinuteSample>();
  for (const r of rows) {
    const minute = Math.floor(r.minute.getTime() / 60_000);
    series.set(minute, { minute, costMicros: Number(r.cost), requests: Number(r.requests), tokens: Number(r.tokens) });
  }
  const firstSeenMinute = first ? Math.floor(first.createdAt.getTime() / 60_000) : nowMinute;
  const startMinute = Math.max(firstSeenMinute, nowMinute - lookbackMinutes);
  const profile = foldProfile(emptyProfile(startMinute), series, nowMinute - cfg.windowMinutes + 1, cfg);
  logger.info("anomaly.profile_rebuilt", { agentId, minutes: profile.count, mean: profile.mean });
  return { profile, firstSeenMinute, lastEvaluatedMinute: nowMinute - 1 };
}
