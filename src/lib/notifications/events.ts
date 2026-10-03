import type { Alert } from "@prisma/client";
import { redis, keys } from "@/lib/redis";
import { logger } from "@/lib/logger";

export const ALERT_CONSUMER_GROUP = "notifier";
const STREAM_MAXLEN = 100_000;

/**
 * Publish newly created alerts to the alert stream for low-latency fan-out.
 * Failure here never loses an alert: the worker's outbox sweeper picks up any
 * alert whose `fanoutAt` is still null.
 */
export async function publishAlerts(alerts: Pick<Alert, "id" | "organizationId" | "type" | "severity">[]): Promise<void> {
  if (alerts.length === 0) return;
  try {
    const pipeline = redis().pipeline();
    for (const a of alerts) {
      pipeline.xadd(keys.alertStream(), "MAXLEN", "~", STREAM_MAXLEN, "*", "alertId", a.id, "organizationId", a.organizationId, "type", a.type, "severity", a.severity);
    }
    await pipeline.exec();
  } catch (err) {
    logger.warn("alerts.publish_failed", { err, count: alerts.length });
  }
}
