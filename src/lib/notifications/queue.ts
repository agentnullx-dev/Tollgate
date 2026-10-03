import type Redis from "ioredis";
import { defineScript, keys, runScript } from "@/lib/redis";

/**
 * Delayed delivery queue with leases.
 *
 *   due      ZSET  member = deliveryId, score = due time (ms)
 *   inflight ZSET  member = deliveryId, score = lease expiry (ms)
 *
 * claim() atomically moves due items into inflight with a lease. If a worker
 * dies mid-send, the reaper returns expired leases to `due`, so a delivery is
 * never stranded. Postgres remains the source of truth for attempts/status;
 * the reconciler re-enqueues anything Redis forgets.
 */

const CLAIM = defineScript(`
local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, id in ipairs(items) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), id)
end
return items
`);

const RESCHEDULE = defineScript(`
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
return 1
`);

const REAP = defineScript(`
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), id)
end
return #expired
`);

const ENQUEUE_IF_ABSENT = defineScript(`
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
return redis.call('ZADD', KEYS[1], 'NX', tonumber(ARGV[2]), ARGV[1])
`);

export class DeliveryQueue {
  constructor(private readonly client: Redis) {}

  async enqueue(deliveryId: string, dueAt: number): Promise<void> {
    await runScript(this.client, ENQUEUE_IF_ABSENT, [keys.notifyDue(), keys.notifyInflight()], [deliveryId, dueAt]);
  }

  async enqueueMany(items: Array<{ id: string; dueAt: number }>): Promise<void> {
    if (items.length === 0) return;
    await Promise.all(items.map((i) => this.enqueue(i.id, i.dueAt)));
  }

  async claim(limit: number, leaseMs: number, now: number = Date.now()): Promise<string[]> {
    if (limit <= 0) return [];
    return runScript<string[]>(this.client, CLAIM, [keys.notifyDue(), keys.notifyInflight()], [now, limit, now + leaseMs]);
  }

  async complete(deliveryId: string): Promise<void> {
    await this.client.zrem(keys.notifyInflight(), deliveryId);
  }

  async reschedule(deliveryId: string, dueAt: number): Promise<void> {
    await runScript(this.client, RESCHEDULE, [keys.notifyDue(), keys.notifyInflight()], [deliveryId, dueAt]);
  }

  async extendLease(deliveryId: string, leaseMs: number): Promise<void> {
    await this.client.zadd(keys.notifyInflight(), "XX", Date.now() + leaseMs, deliveryId);
  }

  async reapExpired(now: number = Date.now(), limit = 500): Promise<number> {
    return runScript<number>(this.client, REAP, [keys.notifyDue(), keys.notifyInflight()], [now, limit]);
  }

  async deadLetter(deliveryId: string, reason: string): Promise<void> {
    await this.client
      .multi()
      .lpush(keys.notifyDead(), JSON.stringify({ deliveryId, reason, at: new Date().toISOString() }))
      .ltrim(keys.notifyDead(), 0, 9_999)
      .exec();
  }

  /** Milliseconds until the next due item, or null when the queue is empty. */
  async msUntilNextDue(now: number = Date.now()): Promise<number | null> {
    const head = await this.client.zrange(keys.notifyDue(), 0, 0, "WITHSCORES");
    if (head.length < 2) return null;
    return Math.max(0, Number(head[1]) - now);
  }

  async depth(): Promise<{ due: number; inflight: number; dead: number }> {
    const [due, inflight, dead] = await Promise.all([
      this.client.zcard(keys.notifyDue()),
      this.client.zcard(keys.notifyInflight()),
      this.client.llen(keys.notifyDead()),
    ]);
    return { due, inflight, dead };
  }
}
