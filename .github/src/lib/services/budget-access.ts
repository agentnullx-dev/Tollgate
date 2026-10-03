import type { Budget, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/errors";
import { hasScope, type AuthContext } from "@/lib/auth";
import { microsToUsd } from "@/lib/money";
import type { BudgetSnapshot, LiveUtilization } from "@/lib/services/budgets";
import type { BudgetDTO } from "@/types/api";

export const budgetInclude = {
  project: { select: { name: true } },
  agent: { select: { externalId: true, displayName: true, projectId: true } },
} satisfies Prisma.BudgetInclude;

export type BudgetWithRelations = Prisma.BudgetGetPayload<{ include: typeof budgetInclude }>;

/** Budgets visible to an API key: everything for org admins, otherwise org-wide plus its own project. */
export function visibleBudgetsWhere(auth: AuthContext): Prisma.BudgetWhereInput {
  if (hasScope(auth, "org:admin")) return { organizationId: auth.organizationId };
  return {
    organizationId: auth.organizationId,
    OR: [
      { scope: "ORGANIZATION" },
      { scope: "PROJECT", projectId: auth.projectId },
      { scope: "AGENT", agent: { projectId: auth.projectId } },
    ],
  };
}

export async function findVisibleBudget(auth: AuthContext, budgetId: string): Promise<BudgetWithRelations> {
  const budget = await prisma.budget.findFirst({
    where: { AND: [{ id: budgetId }, visibleBudgetsWhere(auth)] },
    include: budgetInclude,
  });
  if (!budget) throw Errors.notFound("Budget", budgetId);
  return budget;
}

/** Project-scoped keys may only manage budgets for their own project and its agents. */
export function assertBudgetWritable(
  auth: AuthContext,
  target: { scope: Budget["scope"]; projectId: string | null; agentProjectId: string | null },
): void {
  if (hasScope(auth, "org:admin")) return;
  if (target.scope === "ORGANIZATION") {
    throw Errors.forbidden("Organization-wide budgets require an API key with the org:admin scope.");
  }
  const owningProject = target.scope === "AGENT" ? target.agentProjectId : target.projectId;
  if (owningProject !== auth.projectId) {
    throw Errors.forbidden("This API key can only manage budgets for its own project.");
  }
}

export function snapshotOf(row: Budget): BudgetSnapshot {
  return {
    id: row.id,
    organizationId: row.organizationId,
    scope: row.scope,
    projectId: row.projectId,
    agentId: row.agentId,
    name: row.name,
    period: row.period,
    limitMicros: row.limitMicros,
    enforcement: row.enforcement,
    alertThresholds: row.alertThresholds,
    createdAt: row.createdAt,
  };
}

export function toBudgetDTO(row: BudgetWithRelations, live?: LiveUtilization): BudgetDTO {
  const limitUsd = microsToUsd(row.limitMicros);
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    projectId: row.projectId,
    projectName: row.project?.name ?? null,
    agentId: row.agentId,
    agentName: row.agent ? row.agent.displayName ?? row.agent.externalId : null,
    period: row.period,
    enforcement: row.enforcement,
    alertThresholds: row.alertThresholds,
    isActive: row.isActive,
    limitMicros: row.limitMicros.toString(),
    limitUsd,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    current: live
      ? {
          periodKey: live.periodKey,
          periodStart: live.periodStart.toISOString(),
          periodEnd: live.periodEnd?.toISOString() ?? null,
          committedUsd: microsToUsd(live.committedMicros),
          reservedUsd: microsToUsd(live.reservedMicros),
          utilization:
            row.limitMicros > 0n
              ? Number(((live.committedMicros + live.reservedMicros) * 10_000n) / row.limitMicros) / 10_000
              : 0,
        }
      : null,
  };
}
