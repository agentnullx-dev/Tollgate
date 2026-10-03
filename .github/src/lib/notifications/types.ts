import type { AlertSeverity, AlertType, NotificationChannelType } from "@prisma/client";

export interface NotificationFact {
  label: string;
  value: string;
}

export interface UtilizationSnapshot {
  ratio: number;
  spentUsd: number;
  limitUsd: number;
}

export interface IncidentSnapshot {
  zScore: number;
  windowMinutes: number;
  windowSpendUsd: number;
  baselineMeanPerMinuteUsd: number;
  thresholdPerMinuteUsd: number;
  actionTaken: string;
}

/** Channel-neutral description of one alert, rendered per channel. */
export interface NotificationContext {
  alertId: string;
  organizationName: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  summary: string;
  facts: NotificationFact[];
  utilization: UtilizationSnapshot | null;
  incident: IncidentSnapshot | null;
  actionUrl: string;
  actionLabel: string;
  occurredAt: Date;
  isTest: boolean;
}

export interface HttpRequestSpec {
  kind: "http";
  body: string;
  headers: Record<string, string>;
}

export interface EmailMessageSpec {
  kind: "email";
  subject: string;
  html: string;
  text: string;
}

export type RenderedNotification = HttpRequestSpec | EmailMessageSpec;

export interface DeliveryResult {
  ok: boolean;
  statusCode?: number;
  /** True when a later attempt can reasonably succeed (timeouts, 429, 5xx). */
  retryable: boolean;
  /** Server-mandated delay (Retry-After). */
  retryAfterMs?: number;
  providerMessageId?: string;
  error?: string;
}

export interface ResolvedChannel {
  id: string;
  organizationId: string;
  type: NotificationChannelType;
  name: string;
  /** Decrypted webhook URL, or decrypted JSON array of recipients for EMAIL. */
  target: string;
  /** Decrypted HMAC secret for WEBHOOK channels. */
  secret: string | null;
}

export const SEVERITY_RANK: Record<AlertSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  CRITICAL: "#C2352B",
  WARNING: "#D99A1E",
  INFO: "#45526A",
};

export const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  CRITICAL: "Critical",
  WARNING: "Warning",
  INFO: "Info",
};
