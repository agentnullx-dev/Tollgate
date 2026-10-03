import { createHmac } from "node:crypto";
import type { HttpRequestSpec, NotificationContext } from "../types";

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Generic JSON webhook. Receivers verify
 * `x-tollgate-signature: sha256=HMAC_SHA256(secret, "<x-tollgate-timestamp>.<raw body>")`
 * and should reject timestamps older than five minutes.
 */
export function renderWebhook(ctx: NotificationContext, deliveryId: string, secret: string | null, now: Date = new Date()): HttpRequestSpec {
  const body = JSON.stringify({
    type: "alert.created",
    deliveryId,
    sentAt: now.toISOString(),
    test: ctx.isTest,
    alert: {
      id: ctx.alertId,
      type: ctx.type,
      severity: ctx.severity,
      title: ctx.title,
      message: ctx.summary,
      occurredAt: ctx.occurredAt.toISOString(),
      organization: ctx.organizationName,
      facts: ctx.facts,
      utilization: ctx.utilization,
      incident: ctx.incident,
      url: ctx.actionUrl,
    },
  });
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "x-tollgate-timestamp": timestamp,
    "x-tollgate-delivery": deliveryId,
    "idempotency-key": deliveryId,
  };
  if (secret) headers["x-tollgate-signature"] = `sha256=${signWebhook(secret, timestamp, body)}`;
  return { kind: "http", body, headers };
}
