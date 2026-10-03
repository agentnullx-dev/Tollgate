import type Redis from "ioredis";
import { keys } from "@/lib/redis";
import type { MinuteSample } from "./detector";

/** How long per-minute buckets are retained (long enough for baseline + window + catch-up). */
const BUCKET_TTL_SECONDS = 4 * 3600;

export const minuteOf = (ms: number) => Math.floor(ms / 60_000);
const hourOf = (minute: number) => Math.floor(minute / 60);

/**
 * Record settled usage for anomaly detection. Called from the ingestion hot
 * path; one pipeline round trip per batch.
 */
export async function recordAgentUsage(
  client: Redis,
  entries: Array<{ agentId: string; costMicros: bigint; requests: number; tokens: number }>,
  atMs: number = Date.now(),
): Promise<void> {
  if (entries.length === 0) return;
  const minute = minuteOf(atMs);
  const key = (agentId: string) => keys.agentMinutes(agentId, hourOf(minute));
  const pipeline = client.pipeline();
  const touched = new Set<string>();
  for (const e of entries) {
    const k = key(e.agentId);
    pipeline.hincrby(k, `${minute}:c`, Number(e.costMicros));
    pipeline.hincrby(k, `${minute}:r`, e.requests);
    pipeline.hincrby(k, `${minute}:t`, e.tokens);
    touched.add(e.agentId);
  }
  for (const agentId of touched) {
    pipeline.expire(key(agentId), BUCKET_TTL_SECONDS);
    pipeline.zadd(keys.activeAgents(), atMs, agentId);
  }
  await pipeline.exec();
}

/** Agents with usage since `sinceMs`; prunes entries older than the retention horizon. */
export async function activeAgentIds(client: Redis, sinceMs: number): Promise<string[]> {
  await client.zremrangebyscore(keys.activeAgents(), "-inf", Date.now() - BUCKET_TTL_SECONDS * 1000);
  return client.zrangebyscore(keys.activeAgents(), sinceMs, "+inf");
}

/** Load the dense per-minute series for [fromMinute, toMinute] for many agents in one pipeline. */
export async function loadSeries(
  client: Redis,
  agentIds: string[],
  fromMinute: number,
  toMinute: number,
): Promise<Map<string, Map<number, MinuteSample>>> {
  const hours: number[] = [];
  for (let h = hourOf(fromMinute); h <= hourOf(toMinute); h++) hours.push(h);

  const pipeline = client.pipeline();
  for (const agentId of agentIds) for (const h of hours) pipeline.hgetall(keys.agentMinutes(agentId, h));
  const results = (await pipeline.exec()) ?? [];

  const out = new Map<string, Map<number, MinuteSample>>();
  agentIds.forEach((agentId, ai) => {
    const series = new Map<number, MinuteSample>();
    hours.forEach((_, hi) => {
      const hash = (results[ai * hours.length + hi]?.[1] ?? {}) as Record<string, string>;
      for (const [field, raw] of Object.entries(hash)) {
        const sep = field.indexOf(":");
        const minute = Number(field.slice(0, sep));
        if (minute < fromMinute || minute > toMinute) continue;
        const kind = field.slice(sep + 1);
        const sample = series.get(minute) ?? { minute, costMicros: 0, requests: 0, tokens: 0 };
        const value = Number(raw);
        if (kind === "c") sample.costMicros = value;
        else if (kind === "r") sample.requests = value;
        else if (kind === "t") sample.tokens = value;
        series.set(minute, sample);
      }
    });
    out.set(agentId, series);
  });
  return out;
}
