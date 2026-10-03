import { hostname } from "node:os";
import type Redis from "ioredis";
import type { DeliveryStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { keys } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { ALERT_CONSUMER_GROUP } from "@/lib/notifications/events";
import { DeliveryQueue } from "@/lib/notifications/queue";
import { CircuitBreaker } from "@/lib/notifications/circuit-breaker";
import { nextRetryDelayMs } from "@/lib/notifications/backoff";
import { buildNotificationContext } from "@/lib/notifications/context";
import { resolveChannel } from "@/lib/notifications/channels";
import { dispatchToChannel } from "@/lib/notifications/dispatch";
import { SEVERITY_RANK } from "@/lib/notifications/types";
import { workerMetrics } from "./metrics";

const RETRYABLE_STATES: DeliveryStatus[] = ["PENDING", "RETRY_SCHEDULED", "SENDING"];
const SWEEP_INTERVAL_MS = 15_000;
const SWEEP_GRACE_MS = 10_000;
const REAP_INTERVAL_MS = 10_000;
const RECONCILE_INTERVAL_MS = 60_000;
const STREAM_BLOCK_MS = 5_000;
const STREAM_CLAIM_IDLE_MS = 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * Asynchronous notification engine.
 *
 *   alert rows (outbox) ──┬─ Redis Stream (low latency) ──┐
 *                         └─ outbox sweeper (guarantee) ──┴─> fan-out
 *   fan-out ─> notification_deliveries rows ─> delayed queue (Redis ZSET)
 *   dispatcher ─> claim with lease ─> render ─> send ─> DELIVERED
 *                                              └─ failure ─> backoff ─> RETRY_SCHEDULED
 *                                              └─ permanent / exhausted ─> DEAD (+ dead-letter list)
 *
 * Guarantees: at-least-once delivery per (alert, channel). Postgres holds the
 * authoritative delivery state; any Redis data loss is repaired by the
 * reconciler, and crashed sends are recovered when their lease expires.
 */
export class NotificationWorker {
  private readonly abort = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly queue: DeliveryQueue;
  private readonly breaker: CircuitBreaker;
  private readonly consumer = `${hostname()}-${process.pid}`;

  constructor(
    private readonly client: Redis,
    /** Dedicated connection for blocking XREADGROUP calls. */
    private readonly blockingClient: Redis,
  ) {
    this.queue = new DeliveryQueue(client);
    this.breaker = new CircuitBreaker(client);
  }

  async start(): Promise<void> {
    await this.ensureConsumerGroup();
    const signal = this.abort.signal;
    this.loops.push(
      this.streamLoop(signal),
      this.every(SWEEP_INTERVAL_MS, () => this.sweepOutbox(), "sweep"),
      this.dispatchLoop(signal),
      this.every(REAP_INTERVAL_MS, () => this.reap(), "reap"),
      this.every(RECONCILE_INTERVAL_MS, () => this.reconcile(), "reconcile"),
    );
    logger.info("notifier.started", { consumer: this.consumer });
  }

  async stop(drainTimeoutMs = 20_000): Promise<void> {
    this.abort.abort();
    const drain = Promise.allSettled([...this.loops, ...this.inFlight]);
    await Promise.race([drain, new Promise((r) => setTimeout(r, drainTimeoutMs))]);
    logger.info("notifier.stopped", { pending: this.inFlight.size });
  }

  // ---------------------------------------------------------------------------
  // Intake: stream + outbox sweeper
  // ---------------------------------------------------------------------------

  private async ensureConsumerGroup(): Promise<void> {
    try {
      await this.client.xgroup("CREATE", keys.alertStream(), ALERT_CONSUMER_GROUP, "$", "MKSTREAM");
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) throw err;
    }
  }

  private async streamLoop(signal: AbortSignal): Promise<void> {
    let reclaimCursor = "0-0";
    while (!signal.aborted) {
      try {
        // Recover messages a crashed consumer read but never acknowledged.
        const claimed = (await this.client.xautoclaim(
          keys.alertStream(),
          ALERT_CONSUMER_GROUP,
          this.consumer,
          STREAM_CLAIM_IDLE_MS,
          reclaimCursor,
          "COUNT",
          50,
        )) as [string, Array<[string, string[]]>, ...unknown[]];
        reclaimCursor = claimed[0] ?? "0-0";
        await this.handleStreamEntries(claimed[1] ?? []);

        const response = (await this.blockingClient.xreadgroup(
          "GROUP",
          ALERT_CONSUMER_GROUP,
          this.consumer,
          "COUNT",
          100,
          "BLOCK",
          STREAM_BLOCK_MS,
          "STREAMS",
          keys.alertStream(),
          ">",
        )) as Array<[string, Array<[string, string[]]>]> | null;
        for (const [, entries] of response ?? []) await this.handleStreamEntries(entries);
      } catch (err) {
        if (signal.aborted) break;
        logger.error("notifier.stream_error", { err });
        await sleep(2_000, signal);
      }
    }
  }

  private async handleStreamEntries(entries: Array<[string, string[]]>): Promise<void> {
    for (const [id, fields] of entries) {
      const map = new Map<string, string>();
      for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
      const alertId = map.get("alertId");
      if (alertId) {
        await this.fanout(alertId, "stream");
      }
      await this.client.xack(keys.alertStream(), ALERT_CONSUMER_GROUP, id);
    }
  }

  private async sweepOutbox(): Promise<void> {
    const pending = await prisma.alert.findMany({
      where: { fanoutAt: null, createdAt: { lt: new Date(Date.now() - SWEEP_GRACE_MS) } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    for (const a of pending) await this.fanout(a.id, "sweeper");
    if (pending.length) logger.info("notifier.outbox_swept", { count: pending.length });
  }

  /** Create one delivery per eligible channel and enqueue them. Idempotent. */
  async fanout(alertId: string, source: "stream" | "sweeper" | "manual"): Promise<number> {
    const alert = await prisma.alert.findUnique({
      where: { id: alertId },
      select: { id: true, organizationId: true, type: true, severity: true, fanoutAt: true },
    });
    if (!alert || alert.fanoutAt) return 0;

    const channels = await prisma.notificationChannel.findMany({
      where: { organizationId: alert.organizationId, isEnabled: true },
      select: { id: true, minSeverity: true, alertTypes: true },
    });
    const eligible = channels.filter(
      (c) => SEVERITY_RANK[alert.severity] >= SEVERITY_RANK[c.minSeverity] && (c.alertTypes.length === 0 || c.alertTypes.includes(alert.type)),
    );

    const now = new Date();
    const deliveries = await prisma.$transaction(async (tx) => {
      if (eligible.length) {
        await tx.notificationDelivery.createMany({
          data: eligible.map((c) => ({ alertId: alert.id, channelId: c.id, nextAttemptAt: now })),
          skipDuplicates: true,
        });
      }
      // Compare-and-set the outbox marker so concurrent fan-outs agree on one winner.
      await tx.alert.updateMany({ where: { id: alert.id, fanoutAt: null }, data: { fanoutAt: now } });
      return tx.notificationDelivery.findMany({ where: { alertId: alert.id, status: "PENDING" }, select: { id: true } });
    });

    await this.queue.enqueueMany(deliveries.map((d) => ({ id: d.id, dueAt: now.getTime() })));
    workerMetrics.fanouts.inc({ source }, 1);
    return deliveries.length;
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  private async dispatchLoop(signal: AbortSignal): Promise<void> {
    const { NOTIFY_CONCURRENCY: concurrency, NOTIFY_LEASE_MS: leaseMs } = env();
    while (!signal.aborted) {
      try {
        const capacity = concurrency - this.inFlight.size;
        const claimed = capacity > 0 ? await this.queue.claim(capacity, leaseMs) : [];
        for (const id of claimed) {
          const task = this.process(id).finally(() => this.inFlight.delete(task));
          this.inFlight.add(task);
        }
        if (claimed.length === 0) {
          const wait = await this.queue.msUntilNextDue();
          await sleep(Math.min(1_000, wait ?? 1_000), signal);
        } else if (this.inFlight.size >= concurrency) {
          await Promise.race([...this.inFlight, sleep(250, signal)]);
        }
      } catch (err) {
        if (signal.aborted) break;
        logger.error("notifier.dispatch_error", { err });
        await sleep(1_000, signal);
      }
    }
  }

  private async process(deliveryId: string): Promise<void> {
    const e = env();
    const delivery = await prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        channel: true,
        alert: {
          include: {
            organization: { select: { id: true, name: true } },
            budget: { include: { project: { select: { name: true } } } },
            agent: { select: { id: true, externalId: true, displayName: true, status: true } },
            securityIncident: true,
          },
        },
      },
    });

    if (!delivery || !RETRYABLE_STATES.includes(delivery.status)) {
      await this.queue.complete(deliveryId);
      return;
    }

    if (!delivery.channel.isEnabled) {
      await prisma.notificationDelivery.update({ where: { id: deliveryId }, data: { status: "SKIPPED", lastError: "Channel disabled" } });
      await this.queue.complete(deliveryId);
      return;
    }

    // Circuit open: park without consuming an attempt.
    const openUntil = await this.breaker.openUntil(delivery.channelId);
    if (openUntil) {
      await prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: "RETRY_SCHEDULED", nextAttemptAt: new Date(openUntil) },
      });
      await this.queue.reschedule(deliveryId, openUntil);
      return;
    }

    // Claim the attempt in Postgres; the attempts guard makes concurrent workers single-winner.
    const attempt = delivery.attempts + 1;
    const claimed = await prisma.notificationDelivery.updateMany({
      where: { id: deliveryId, attempts: delivery.attempts, status: { in: RETRYABLE_STATES } },
      data: { status: "SENDING", attempts: attempt, lastAttemptAt: new Date() },
    });
    if (claimed.count === 0) return;

    const started = performance.now();
    const channel = resolveChannel(delivery.channel);
    const ctx = buildNotificationContext(delivery.alert, e.APP_BASE_URL);
    const result = await dispatchToChannel(channel, ctx, deliveryId);
    const seconds = (performance.now() - started) / 1000;
    workerMetrics.deliveryLatency.observe(seconds, { channel: channel.type });

    if (result.ok) {
      await prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: "DELIVERED",
          deliveredAt: new Date(),
          lastStatusCode: result.statusCode ?? null,
          providerMessageId: result.providerMessageId ?? null,
          lastError: null,
        },
      });
      await this.breaker.recordSuccess(delivery.channelId);
      await this.queue.complete(deliveryId);
      workerMetrics.deliveries.inc({ channel: channel.type, outcome: "delivered" });
      logger.info("notifier.delivered", { deliveryId, channel: channel.type, attempt, ms: Math.round(seconds * 1000) });
      return;
    }

    const exhausted = attempt >= e.NOTIFY_MAX_ATTEMPTS;
    if (result.retryable && !exhausted) {
      const delay = nextRetryDelayMs(attempt, { baseMs: e.NOTIFY_BACKOFF_BASE_MS, maxMs: e.NOTIFY_BACKOFF_MAX_MS }, result.retryAfterMs);
      let dueAt = Date.now() + delay;
      const tripped = await this.breaker.recordFailure(delivery.channelId);
      if (tripped) {
        dueAt = Math.max(dueAt, tripped);
        workerMetrics.circuitOpens.inc({ channel: channel.type });
        logger.warn("notifier.circuit_opened", { channelId: delivery.channelId, until: new Date(tripped).toISOString() });
      }
      await prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: "RETRY_SCHEDULED",
          nextAttemptAt: new Date(dueAt),
          lastError: result.error?.slice(0, 1000) ?? "Unknown error",
          lastStatusCode: result.statusCode ?? null,
        },
      });
      await this.queue.reschedule(deliveryId, dueAt);
      workerMetrics.deliveries.inc({ channel: channel.type, outcome: "retry" });
      logger.warn("notifier.retry_scheduled", { deliveryId, channel: channel.type, attempt, delayMs: dueAt - Date.now(), error: result.error });
      return;
    }

    const reason = exhausted ? `Gave up after ${attempt} attempts: ${result.error ?? "unknown error"}` : result.error ?? "Permanent failure";
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: "DEAD", lastError: reason.slice(0, 1000), lastStatusCode: result.statusCode ?? null },
    });
    await this.queue.complete(deliveryId);
    await this.queue.deadLetter(deliveryId, reason);
    workerMetrics.deliveries.inc({ channel: channel.type, outcome: "dead" });
    logger.error("notifier.dead_lettered", { deliveryId, channel: channel.type, attempt, reason });
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  private async reap(): Promise<void> {
    const recovered = await this.queue.reapExpired();
    if (recovered > 0) logger.warn("notifier.leases_recovered", { count: recovered });
    const depth = await this.queue.depth();
    workerMetrics.queueDepth.set(depth.due, { state: "due" });
    workerMetrics.queueDepth.set(depth.inflight, { state: "inflight" });
    workerMetrics.queueDepth.set(depth.dead, { state: "dead_letter" });
  }

  /** Re-enqueue deliveries Postgres says are due but Redis no longer tracks. */
  private async reconcile(): Promise<void> {
    const leaseMs = env().NOTIFY_LEASE_MS;
    const now = Date.now();
    const overdue = await prisma.notificationDelivery.findMany({
      where: {
        OR: [
          { status: { in: ["PENDING", "RETRY_SCHEDULED"] }, nextAttemptAt: { lt: new Date(now - 30_000) } },
          { status: "SENDING", updatedAt: { lt: new Date(now - leaseMs * 2) } },
        ],
      },
      select: { id: true },
      take: 1000,
    });
    await this.queue.enqueueMany(overdue.map((d) => ({ id: d.id, dueAt: now })));
    if (overdue.length) logger.warn("notifier.reconciled", { count: overdue.length });
  }

  private async every(intervalMs: number, fn: () => Promise<void>, name: string): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        await fn();
      } catch (err) {
        logger.error(`notifier.${name}_error`, { err });
      }
      await sleep(intervalMs, signal);
    }
  }
}
