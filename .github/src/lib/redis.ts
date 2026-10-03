import { createHash } from "node:crypto";
import Redis, { type Result } from "ioredis";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * AUTHORIZE (atomic check-and-reserve across every applicable budget).
 *
 * KEYS[1..n]        committed spend counters (string, integer micros)
 * KEYS[n+1..2n]     in-flight reservation sorted sets (member "<resId>:<micros>", score = expiry ms)
 * KEYS[2n+1]        reservation record key
 *
 * ARGV[1]           n
 * ARGV[2]           estimated cost (micros)
 * ARGV[3]           now (ms since epoch)
 * ARGV[4]           reservation expiry (ms since epoch)
 * ARGV[5]           reservation id
 * ARGV[6]           reservation ttl seconds
 * ARGV[7]           reservation payload (JSON)
 * ARGV[8..7+n]      limits (micros)
 * ARGV[8+n..7+2n]   enforce flags ("1" = BLOCK, "0" = ALERT_ONLY)
 * ARGV[8+2n..7+3n]  counter ttl seconds per budget window
 *
 * Returns {allowed(1|0), budgetIndex, committed, reserved}. When allowed, a
 * non-zero budgetIndex reports the first non-enforcing budget that the request
 * pushed over its limit ("soft violation"), so alert-only budgets and
 * alert-only agents still raise alerts.
 */
const AUTHORIZE_LUA = `
local n = tonumber(ARGV[1])
local estimate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local expiresAt = tonumber(ARGV[4])
local resId = ARGV[5]
local resTtl = tonumber(ARGV[6])
local payload = ARGV[7]
local member = resId .. ':' .. ARGV[2]
local soft, softCommitted, softReserved = 0, 0, 0

for i = 1, n do
  local rkey = KEYS[n + i]
  redis.call('ZREMRANGEBYSCORE', rkey, '-inf', now)
  local members = redis.call('ZRANGE', rkey, 0, -1)
  local reserved = 0
  for _, m in ipairs(members) do
    local amt = tonumber(string.match(m, ':(%d+)$'))
    if amt then reserved = reserved + amt end
  end
  local committed = tonumber(redis.call('GET', KEYS[i]) or '0')
  local limit = tonumber(ARGV[7 + i])
  local enforce = ARGV[7 + n + i]
  if (committed + reserved + estimate) > limit then
    if enforce == '1' then
      return {0, i, committed, reserved}
    elseif soft == 0 then
      soft, softCommitted, softReserved = i, committed, reserved
    end
  end
end

for i = 1, n do
  local rkey = KEYS[n + i]
  local ttl = tonumber(ARGV[7 + 2 * n + i])
  redis.call('ZADD', rkey, expiresAt, member)
  if redis.call('TTL', rkey) < ttl then
    redis.call('EXPIRE', rkey, ttl)
  end
end

redis.call('SET', KEYS[2 * n + 1], payload, 'EX', resTtl)
return {1, soft, softCommitted, softReserved}
`;

/**
 * SETTLE (release a reservation and commit actual spend).
 *
 * KEYS[1]               reservation record key
 * KEYS[2..n+1]          committed counters to increment
 * KEYS[n+2..n+m+1]      reservation sorted sets to release the member from
 *
 * ARGV[1]  n
 * ARGV[2]  m
 * ARGV[3]  actual cost (micros)
 * ARGV[4]  reservation member ("" when the event had no reservation)
 * ARGV[5..4+n] counter ttl seconds
 *
 * Returns the post-increment committed value for each of the n counters.
 */
const SETTLE_LUA = `
local n = tonumber(ARGV[1])
local m = tonumber(ARGV[2])
local actual = ARGV[3]
local member = ARGV[4]

if member ~= '' then
  redis.call('DEL', KEYS[1])
  for j = 1, m do
    redis.call('ZREM', KEYS[n + 1 + j], member)
  end
end

local out = {}
for i = 1, n do
  local key = KEYS[1 + i]
  local value = redis.call('INCRBY', key, actual)
  local ttl = tonumber(ARGV[4 + i])
  if redis.call('TTL', key) < ttl then
    redis.call('EXPIRE', key, ttl)
  end
  out[i] = value
end
return out
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    tgAuthorize(numKeys: number, ...args: (string | number)[]): Result<number[], Context>;
    tgSettle(numKeys: number, ...args: (string | number)[]): Result<number[], Context>;
  }
}

const globalForRedis = globalThis as unknown as { __tollgateRedis?: Redis };

function createClient(): Redis {
  const client = new Redis(env().REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    connectTimeout: 5_000,
  });
  client.defineCommand("tgAuthorize", { lua: AUTHORIZE_LUA });
  client.defineCommand("tgSettle", { lua: SETTLE_LUA });
  client.on("error", (err) => logger.error("redis.error", { err }));
  return client;
}

export function redis(): Redis {
  if (!globalForRedis.__tollgateRedis) {
    globalForRedis.__tollgateRedis = createClient();
  }
  return globalForRedis.__tollgateRedis;
}

/**
 * Key layout. Budget keys are intentionally not hash-tagged: multi-budget Lua
 * scripts require a single Redis primary (standalone or Sentinel), which is the
 * supported deployment topology.
 */
export const keys = {
  committed: (budgetId: string, periodKey: string) => `tg:b:${budgetId}:${periodKey}:c`,
  reserved: (budgetId: string, periodKey: string) => `tg:b:${budgetId}:${periodKey}:r`,
  reservation: (reservationId: string) => `tg:res:${reservationId}`,
  velocity: (agentId: string, minute: number) => `tg:vel:${agentId}:${minute}`,
  rateLimit: (apiKeyId: string, minute: number) => `tg:rl:${apiKeyId}:${minute}`,
  apiKeyCache: (prefix: string) => `tg:cache:key:${prefix}`,
  agentCache: (projectId: string, externalId: string) => `tg:cache:agent:${projectId}:${externalId}`,
  alertStream: () => "tg:stream:alerts",
  notifyDue: () => "tg:notify:due",
  notifyInflight: () => "tg:notify:inflight",
  notifyDead: () => "tg:notify:dead",
  circuit: (channelId: string) => `tg:cb:${channelId}`,
  lock: (name: string) => `tg:lock:${name}`,
  agentMinutes: (agentId: string, hour: number) => `tg:am:${agentId}:${hour}`,
  activeAgents: () => "tg:am:active",
  anomalyProfile: (agentId: string) => `tg:ap:${agentId}`,
  budgetCache: (organizationId: string) => `tg:cache:budgets:${organizationId}`,
  billingGate: (organizationId: string) => `tg:cache:billing:${organizationId}`,
};

/** Sum the live (non-expired) reservation amounts in a reservation sorted set. */
export function sumReservationMembers(members: string[]): bigint {
  let total = 0n;
  for (const m of members) {
    const idx = m.lastIndexOf(":");
    if (idx === -1) continue;
    const amount = m.slice(idx + 1);
    if (/^\d+$/.test(amount)) total += BigInt(amount);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Ad-hoc Lua scripts with EVALSHA caching (used by the worker subsystems)
// ---------------------------------------------------------------------------

export interface LuaScript {
  lua: string;
  sha: string;
}

export function defineScript(lua: string): LuaScript {
  return { lua, sha: createHash("sha1").update(lua).digest("hex") };
}

/** EVALSHA with transparent fallback to EVAL when the script cache is cold (e.g. after a Redis restart). */
export async function runScript<T>(client: Redis, script: LuaScript, keyList: string[], args: (string | number)[]): Promise<T> {
  try {
    return (await client.evalsha(script.sha, keyList.length, ...keyList, ...args)) as T;
  } catch (err) {
    if (err instanceof Error && err.message.includes("NOSCRIPT")) {
      return (await client.eval(script.lua, keyList.length, ...keyList, ...args)) as T;
    }
    throw err;
  }
}
