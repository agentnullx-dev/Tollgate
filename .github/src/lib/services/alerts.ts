import type { Alert, AlertSeverity, AlertType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatUsd } from "@/lib/money";
import { publishAlerts } from "@/lib/notifications/events";
import type { BudgetWindow } from "@/lib/services/budgets";

export interface AlertDraft {
  organizationId: string;
  budgetId?: string | null;
  agentId?: string | null;
  type: AlertType;
  severity: AlertSeverity;
  dedupeKey: string;
  periodKey?: string | null;
  threshold?: number | null;
  message: string;
  payload?: Prisma.InputJsonValue;
}

/**
 * Persist alerts with database-level de-duplication and publish them to the
 * alert stream for the notification worker. Only genuinely new alerts are
 * returned and published. The `fanoutAt` outbox column guarantees delivery
 * even if publishing fails.
 */
export async function emitAlerts(drafts: AlertDraft[]): Promise<Alert[]> {
  if (drafts.length === 0) return [];
  const created = await prisma.alert.createManyAndReturn({
    data: drafts.map((d) => ({
      organizationId: d.organizationId,
      budgetId: d.budgetId ?? null,
      agentId: d.agentId ?? null,
      type: d.type,
      severity: d.severity,
      dedupeKey: d.dedupeKey,
      periodKey: d.periodKey ?? null,
      threshold: d.threshold ?? null,
      message: d.message,
      payload: d.payload,
    })),
    skipDuplicates: true,
  });

  await publishAlerts(created);
  return created;
}

function severityFor(threshold: number): AlertSeverity {
  if (threshold >= 100) return "CRITICAL";
  if (threshold >= 80) return "WARNING";
  return "INFO";
}

/** Alerts for every configured threshold crossed by moving from `before` to `after`. */
export function thresholdCrossings(bw: BudgetWindow, beforeMicros: bigint, afterMicros: bigint): AlertDraft[] {
  const { budget, window } = bw;
  if (budget.limitMicros <= 0n) return [];
  const drafts: AlertDraft[] = [];
  for (const threshold of budget.alertThresholds) {
    const boundary = (budget.limitMicros * BigInt(threshold)) / 100n;
    if (beforeMicros < boundary && afterMicros >= boundary) {
      drafts.push({
        organizationId: budget.organizationId,
        budgetId: budget.id,
        agentId: budget.agentId,
        type: "BUDGET_THRESHOLD",
        severity: severityFor(threshold),
        dedupeKey: `threshold:${budget.id}:${window.key}:${threshold}`,
        periodKey: window.key,
        threshold,
        message: `${budget.name} reached ${threshold}% of its ${formatUsd(budget.limitMicros)} ${budget.period.toLowerCase()} limit (${formatUsd(afterMicros)} spent).`,
        payload: {
          limitMicros: budget.limitMicros.toString(),
          spentMicros: afterMicros.toString(),
          enforcement: budget.enforcement,
        },
      });
    }
  }
  return drafts;
}
