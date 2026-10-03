import type { ActorType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/errors";
import { usdToMicros } from "@/lib/money";
import type { UpdateBudgetInput } from "@/lib/schemas";
import { recordAudit, toAuditJson } from "@/lib/services/audit";
import { invalidateBudgetCache } from "@/lib/services/budgets";
import { budgetInclude, snapshotOf, type BudgetWithRelations } from "@/lib/services/budget-access";

/**
 * Apply a budget update. Budgets managed by billing follow the subscription:
 * their limit, enforcement and on/off state cannot be edited by hand.
 */
export async function applyBudgetUpdate(input: {
  existing: BudgetWithRelations;
  patch: UpdateBudgetInput;
  actor: { type: ActorType; id: string };
  requestId: string;
}): Promise<BudgetWithRelations> {
  const { existing, patch, actor, requestId } = input;
  if (existing.managedBy && (patch.limitUsd !== undefined || patch.enforcement !== undefined || patch.isActive !== undefined)) {
    throw Errors.conflict("This budget follows your subscription plan. Change the plan to change its limit.", { managedBy: existing.managedBy });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const budget = await tx.budget.update({
      where: { id: existing.id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.limitUsd !== undefined ? { limitMicros: usdToMicros(patch.limitUsd) } : {}),
        ...(patch.enforcement !== undefined ? { enforcement: patch.enforcement } : {}),
        ...(patch.alertThresholds !== undefined ? { alertThresholds: patch.alertThresholds } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      include: budgetInclude,
    });
    await recordAudit(
      {
        organizationId: existing.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "budget.updated",
        targetType: "budget",
        targetId: budget.id,
        before: toAuditJson(snapshotOf(existing)),
        after: toAuditJson(snapshotOf(budget)),
        requestId,
      },
      tx,
    );
    return budget;
  });

  await invalidateBudgetCache(existing.organizationId);
  return updated;
}
