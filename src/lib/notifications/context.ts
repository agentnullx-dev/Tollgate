import type { Agent, Alert, Budget, Organization, Project, SecurityIncident } from "@prisma/client";
import { microsToUsd } from "@/lib/money";
import type { NotificationContext, NotificationFact } from "./types";

export type AlertWithRelations = Alert & {
  organization: Pick<Organization, "id" | "name">;
  budget: (Budget & { project: Pick<Project, "name"> | null }) | null;
  agent: Pick<Agent, "id" | "externalId" | "displayName" | "status"> | null;
  securityIncident: SecurityIncident | null;
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdPrecise = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function formatUsdValue(v: number): string {
  return Math.abs(v) < 1 && v !== 0 ? usdPrecise.format(v) : usd.format(v);
}

function payloadObject(alert: Alert): Record<string, unknown> {
  return alert.payload && typeof alert.payload === "object" && !Array.isArray(alert.payload)
    ? (alert.payload as Record<string, unknown>)
    : {};
}

function micros(value: unknown): bigint | null {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.round(value));
  return null;
}

function agentLabel(alert: AlertWithRelations): string {
  return alert.agent ? alert.agent.displayName ?? alert.agent.externalId : "An agent";
}

function periodText(period: Budget["period"]): string {
  switch (period) {
    case "DAILY":
      return "daily";
    case "WEEKLY":
      return "weekly";
    case "MONTHLY":
      return "monthly";
    case "TOTAL":
      return "lifetime";
  }
}

function scopeText(budget: AlertWithRelations["budget"]): string {
  if (!budget) return "";
  if (budget.scope === "ORGANIZATION") return "Whole organization";
  if (budget.scope === "PROJECT") return `Project: ${budget.project?.name ?? budget.projectId}`;
  return "Single agent";
}

/** Build the channel-neutral context for an alert. Pure: no I/O. */
export function buildNotificationContext(alert: AlertWithRelations, appBaseUrl: string): NotificationContext {
  const payload = payloadObject(alert);
  const facts: NotificationFact[] = [];
  const base = appBaseUrl.replace(/\/+$/, "");
  let title: string;
  let summary = alert.message;
  let actionUrl = `${base}/dashboard#alerts`;
  let actionLabel = "Open alerts";
  let utilization: NotificationContext["utilization"] = null;
  let incident: NotificationContext["incident"] = null;

  const budget = alert.budget;
  if (budget) {
    const limit = budget.limitMicros;
    const spent = micros(payload.spentMicros) ?? micros(payload.committedMicros);
    const limitUsd = microsToUsd(limit);
    facts.push({ label: "Budget", value: budget.name });
    facts.push({ label: "Scope", value: scopeText(budget) });
    facts.push({ label: "Limit", value: `${formatUsdValue(limitUsd)} ${periodText(budget.period)}` });
    if (spent !== null) {
      const spentUsd = microsToUsd(spent);
      utilization = { ratio: limit > 0n ? spentUsd / limitUsd : 0, spentUsd, limitUsd };
      facts.push({ label: "Spent this period", value: formatUsdValue(spentUsd) });
    }
    facts.push({ label: "Enforcement", value: budget.enforcement === "BLOCK" ? "Blocks at limit" : "Alerts only" });
    if (alert.periodKey) facts.push({ label: "Period", value: alert.periodKey });
    actionUrl = `${base}/dashboard#budgets`;
    actionLabel = "Review budget";
  }

  switch (alert.type) {
    case "BUDGET_THRESHOLD":
      title = `${budget?.name ?? "Budget"} reached ${alert.threshold ?? 0}% of its limit`;
      break;
    case "BUDGET_BLOCKED":
      title = `${budget?.name ?? "A budget"} is blocking requests`;
      if (alert.agent) facts.push({ label: "Blocked agent", value: agentLabel(alert) });
      break;
    case "BUDGET_LIMIT_BYPASSED":
      title = `${budget?.name ?? "A budget"} exceeded by an alert-only agent`;
      if (alert.agent) facts.push({ label: "Agent", value: agentLabel(alert) });
      summary = `${alert.message} The request was allowed because the agent runs in alert-only mode.`;
      break;
    case "VELOCITY_LIMIT":
      title = `${agentLabel(alert)} hit its request rate limit`;
      if (typeof payload.count === "number") facts.push({ label: "Requests in one minute", value: String(payload.count) });
      if (typeof payload.limit === "number") facts.push({ label: "Limit per minute", value: String(payload.limit) });
      actionUrl = `${base}/dashboard#agents`;
      actionLabel = "Review agent";
      break;
    case "AGENT_KILLED":
      title = `${agentLabel(alert)} was stopped`;
      actionUrl = `${base}/dashboard#agents`;
      actionLabel = "Review agent";
      break;
    case "AGENT_QUARANTINED":
    case "ANOMALY_DETECTED": {
      title =
        alert.type === "AGENT_QUARANTINED"
          ? `${agentLabel(alert)} was quarantined after a spend spike`
          : `Unusual usage from ${agentLabel(alert)}`;
      const inc = alert.securityIncident;
      if (inc) {
        const ev = inc.evidence && typeof inc.evidence === "object" && !Array.isArray(inc.evidence) ? (inc.evidence as Record<string, unknown>) : {};
        const windowMinutes = typeof ev.windowMinutes === "number" ? ev.windowMinutes : 5;
        incident = {
          zScore: inc.zScore,
          windowMinutes,
          windowSpendUsd: microsToUsd(inc.windowSpendMicros),
          baselineMeanPerMinuteUsd: inc.baselineMeanMicros / 1_000_000,
          thresholdPerMinuteUsd: inc.thresholdMicros / 1_000_000,
          actionTaken: inc.actionTaken,
        };
        facts.push({ label: "Spend in window", value: `${formatUsdValue(incident.windowSpendUsd)} over ${windowMinutes} min` });
        facts.push({ label: "Normal rate", value: `${formatUsdValue(incident.baselineMeanPerMinuteUsd)} per min` });
        facts.push({ label: "Trigger rate", value: `${formatUsdValue(incident.thresholdPerMinuteUsd)} per min` });
        facts.push({ label: "Deviation", value: `${inc.zScore.toFixed(1)} standard deviations` });
        facts.push({ label: "Action", value: inc.actionTaken === "QUARANTINED" ? "Agent quarantined" : "Alert only" });
        facts.push({ label: "Incident", value: inc.id });
      }
      if (alert.agent) facts.unshift({ label: "Agent", value: `${agentLabel(alert)} (${alert.agent.externalId})` });
      actionUrl = `${base}/dashboard#incidents`;
      actionLabel = alert.type === "AGENT_QUARANTINED" ? "Review incident" : "Review agent";
      break;
    }
    case "BILLING_SUSPENDED":
    case "BILLING_RESTORED": {
      title =
        alert.type === "BILLING_SUSPENDED"
          ? `${alert.organization.name}: agents stopped for non-payment`
          : `${alert.organization.name}: billing restored, agents restarted`;
      const agents = typeof payload.agentsStopped === "number" ? payload.agentsStopped : typeof payload.agentsRestored === "number" ? payload.agentsRestored : null;
      if (agents !== null) facts.push({ label: alert.type === "BILLING_SUSPENDED" ? "Agents stopped" : "Agents restarted", value: String(agents) });
      if (typeof payload.invoiceId === "string") facts.push({ label: "Invoice", value: payload.invoiceId });
      actionUrl = `${base}/dashboard#agents`;
      actionLabel = alert.type === "BILLING_SUSPENDED" ? "Review billing" : "Open console";
      break;
    }
    default: {
      const exhaustive: never = alert.type;
      title = String(exhaustive);
    }
  }

  return {
    alertId: alert.id,
    organizationName: alert.organization.name,
    type: alert.type,
    severity: alert.severity,
    title,
    summary,
    facts,
    utilization,
    incident,
    actionUrl,
    actionLabel,
    occurredAt: alert.createdAt,
    isTest: payload.test === true,
  };
}

/** A realistic context used by the "send test" endpoint. */
export function buildTestContext(organizationName: string, appBaseUrl: string): NotificationContext {
  return {
    alertId: "test",
    organizationName,
    type: "BUDGET_THRESHOLD",
    severity: "WARNING",
    title: "Test: Company monthly cap reached 80% of its limit",
    summary: "This is a test notification from Tollgate. Real alerts look exactly like this one.",
    facts: [
      { label: "Budget", value: "Company monthly cap" },
      { label: "Scope", value: "Whole organization" },
      { label: "Limit", value: "$2,500.00 monthly" },
      { label: "Spent this period", value: "$2,012.40" },
      { label: "Enforcement", value: "Blocks at limit" },
    ],
    utilization: { ratio: 0.805, spentUsd: 2012.4, limitUsd: 2500 },
    incident: null,
    actionUrl: `${appBaseUrl.replace(/\/+$/, "")}/dashboard#budgets`,
    actionLabel: "Review budget",
    occurredAt: new Date(),
    isTest: true,
  };
}
