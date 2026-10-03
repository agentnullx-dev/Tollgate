import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { defineScript, keys, runScript } from "@/lib/redis";

const RELEASE = defineScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`);

const RENEW = defineScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2])) end
return 0
`);

/**
 * Single-holder lease used to elect one leader among worker replicas.
 * Safe release/renew via compare-and-act so a replica never deletes a lease
 * another replica acquired after its own expired.
 */
export class LeaderLease {
  private readonly token = randomUUID();
  private held = false;

  constructor(private readonly client: Redis, private readonly name: string, private readonly ttlMs: number) {}

  get isHeld(): boolean {
    return this.held;
  }

  /** Acquire if free, renew if already ours. Returns whether we hold it now. */
  async tryAcquire(): Promise<boolean> {
    const key = keys.lock(this.name);
    if (this.held) {
      const renewed = await runScript<number>(this.client, RENEW, [key], [this.token, this.ttlMs]);
      this.held = renewed === 1;
      if (this.held) return true;
    }
    const ok = await this.client.set(key, this.token, "PX", this.ttlMs, "NX");
    this.held = ok === "OK";
    return this.held;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    await runScript(this.client, RELEASE, [keys.lock(this.name)], [this.token]);
    this.held = false;
  }
}
