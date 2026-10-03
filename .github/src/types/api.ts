// Wire-format types shared by the API routes and the dashboard.
// Monetary values are exposed twice: exact `*Micros` strings for systems of
// record, and `*Usd` numbers for display.

export type AgentStatus = "ACTIVE" | "PAUSED" | "KILLED" | "QUARANTINED";
export type AgentEnforcementMode = "STRICT" | "ALERT_ONLY";
export type BudgetScope = "ORGANIZATION" | "PROJECT" | "AGENT";
export type BudgetPeriod = "DAILY" | "WEEKLY" | "MONTHLY" | "TOTAL";
export type BudgetEnforcement = "BLOCK" | "ALERT_ONLY";
export type AlertType =
  | "BUDGET_THRESHOLD"
  | "BUDGET_BLOCKED"
  | "BUDGET_LIMIT_BYPASSED"
  | "VELOCITY_LIMIT"
  | "AGENT_KILLED"
  | "AGENT_QUARANTINED"
  | "ANOMALY_DETECTED"
  | "BILLING_SUSPENDED"
  | "BILLING_RESTORED";
export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export type DenyReasonCode =
  | "AGENT_KILLED"
  | "AGENT_PAUSED"
  | "AGENT_QUARANTINED"
  | "VELOCITY_LIMIT"
  | "BUDGET_EXCEEDED"
  | "BILLING_SUSPENDED";

export interface AuthorizeResponse {
  decision: "ALLOW" | "DENY";
  reservationId: string | null;
  expiresAt: string | null;
  estimatedCostMicros: string;
  estimatedCostUsd: number;
  reason: {
    code: DenyReasonCode;
    message: string;
    budgetId?: string;
    budgetName?: string;
    periodKey?: string;
    limitUsd?: number;
    committedUsd?: number;
    reservedUsd?: number;
    headroomUsd?: number;
    requestsThisMinute?: number;
    limitPerMinute?: number;
  } | null;
  agent: { id: string; externalId: string; status: AgentStatus; enforcementMode: AgentEnforcementMode };
  /** Set when the request was allowed past a limit (alert-only agent or budget). */
  overLimit?: { budgetId: string; budgetName: string } | null;
  budgetsEvaluated?: Array<{ budgetId: string; name: string; periodKey: string; enforcement: BudgetEnforcement }>;
}

export type IngestResultStatus = "accepted" | "duplicate" | "rejected";

export interface IngestEventResult {
  index: number;
  idempotencyKey: string;
  status: IngestResultStatus;
  usageEventId?: string;
  costMicros?: string;
  costUsd?: number;
  error?: { code: string; message: string };
}

export interface IngestResponse {
  summary: { received: number; accepted: number; duplicate: number; rejected: number; totalCostUsd: number };
  results: IngestEventResult[];
  alertsRaised: number;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: string;
  costUsd: number;
}

export interface UsageDayRow extends UsageTotals {
  date: string;
}

export interface UsageAgentRow extends UsageTotals {
  agentId: string;
  externalId: string;
  displayName: string | null;
}

export interface UsageModelRow extends UsageTotals {
  provider: string;
  model: string;
}

export interface UsageQueryResponse {
  range: { from: string; to: string };
  groupBy: "day" | "agent" | "model";
  totals: UsageTotals;
  rows: UsageDayRow[] | UsageAgentRow[] | UsageModelRow[];
}

export interface BudgetDTO {
  id: string;
  name: string;
  scope: BudgetScope;
  projectId: string | null;
  projectName: string | null;
  agentId: string | null;
  agentName: string | null;
  period: BudgetPeriod;
  enforcement: BudgetEnforcement;
  alertThresholds: number[];
  isActive: boolean;
  limitMicros: string;
  limitUsd: number;
  createdAt: string;
  updatedAt: string;
  current: {
    periodKey: string;
    periodStart: string;
    periodEnd: string | null;
    committedUsd: number;
    reservedUsd: number;
    utilization: number;
  } | null;
}

export interface AgentDTO {
  id: string;
  externalId: string;
  displayName: string | null;
  projectId: string;
  status: AgentStatus;
  enforcementMode: AgentEnforcementMode;
  maxRequestsPerMinute: number | null;
  autoKillOnVelocity: boolean;
  quarantinedAt: string | null;
  killedAt: string | null;
  killReason: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlertDTO {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  budgetId: string | null;
  agentId: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export type IncidentStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "FALSE_POSITIVE";

export interface SecurityIncidentDTO {
  id: string;
  agentId: string;
  agentName: string;
  type: "SPEND_ANOMALY" | "TOKEN_ANOMALY";
  severity: AlertSeverity;
  status: IncidentStatus;
  windowStart: string;
  windowEnd: string;
  windowSpendUsd: number;
  baselineMeanPerMinuteUsd: number;
  baselineStdPerMinuteUsd: number;
  thresholdPerMinuteUsd: number;
  zScore: number;
  actionTaken: string;
  detectorVersion: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}
