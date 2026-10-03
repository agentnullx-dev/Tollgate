import type Redis from "ioredis";
import { defineScript, keys, runScript } from "@/lib/redis";

/**
 * Per-channel circuit breaker shared by every worker replica.
 *
 * After `threshold` consecutive retryable failures the circuit opens for a
 * cool-down that doubles with every consecutive opening (30 s, 60 s, 2 min …
 * capped at 15 min). While open, deliveries are parked until the cool-down
 * ends without consuming an attempt, so a provider outage cannot exhaust a
 * delivery's retry budget. One success closes the circuit.
 */

const RECORD_FAILURE = defineScript(`
local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
local openUntil = 0
if failures >= tonumber(ARGV[2]) then
  local opens = redis.call('HINCRBY', KEYS[1], 'opens', 1)
  local cooldown = math.min(tonumber(ARGV[4]), tonumber(ARGV[3]) * (2 ^ (opens - 1)))
  openUntil = tonumber(ARGV[1]) + cooldown
  redis.call('HSET', KEYS[1], 'openUntil', openUntil, 'failures', 0)
end
redis.call('EXPIRE', KEYS[1], 86400)
return openUntil
`);

export interface BreakerConfig {
  threshold: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { threshold: 5, baseCooldownMs: 30_000, maxCooldownMs: 15 * 60_000 };

export class CircuitBreaker {
  constructor(private readonly client: Redis, private readonly config: BreakerConfig = DEFAULT_BREAKER) {}

  /** Returns the time the circuit re-closes, or null when requests may flow. */
  async openUntil(channelId: string, now: number = Date.now()): Promise<number | null> {
    const raw = await this.client.hget(keys.circuit(channelId), "openUntil");
    const until = raw ? Number(raw) : 0;
    return until > now ? until : null;
  }

  async recordSuccess(channelId: string): Promise<void> {
    await this.client.del(keys.circuit(channelId));
  }

  /** Returns the open-until timestamp if this failure tripped the breaker. */
  async recordFailure(channelId: string, now: number = Date.now()): Promise<number | null> {
    const until = await runScript<number>(this.client, RECORD_FAILURE, [keys.circuit(channelId)], [
      now,
      this.config.threshold,
      this.config.baseCooldownMs,
      this.config.maxCooldownMs,
    ]);
    return until > 0 ? until : null;
  }
}
