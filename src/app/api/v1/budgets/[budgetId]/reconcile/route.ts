import { withApiHandler, json } from "@/lib/http";
import { Errors } from "@/lib/errors";
import { microsToUsd } from "@/lib/money";
import { reconcileBudget } from "@/lib/services/budgets";
import { assertBudgetWritable, findVisibleBudget, snapshotOf } from "@/lib/services/budget-access";
import { recordAudit } from "@/lib/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-derive the current-period counter from the Postgres ledger. Use after an
 * incident (e.g. Redis failover) or from a scheduled job to bound drift.
 */
export const POST = withApiHandler<{ budgetId: string }>(
  { scopes: ["budgets:write"] },
  async ({ auth, params, requestId }) => {
    const budget = await findVisibleBudget(auth, params.budgetId);
    assertBudgetWritable(auth, {
      scope: budget.scope,
      projectId: budget.projectId,
      agentProjectId: budget.agent?.projectId ?? null,
    });
    if (!budget.isActive) throw Errors.conflict("Inactive budgets have no live counter to reconcile.");

    const result = await reconcileBudget(snapshotOf(budget));
    await recordAudit({
      organizationId: auth.organizationId,
      actorType: "API_KEY",
      actorId: auth.apiKeyId,
      action: "budget.reconciled",
      targetType: "budget",
      targetId: budget.id,
      before: { committedMicros: result.previousMicros?.toString() ?? null },
      after: { committedMicros: result.reconciledMicros.toString() },
      requestId,
    });

    return json({
      data: {
        budgetId: budget.id,
        periodKey: result.periodKey,
        previousUsd: result.previousMicros === null ? null : microsToUsd(result.previousMicros),
        reconciledUsd: microsToUsd(result.reconciledMicros),
        driftUsd: microsToUsd(result.driftMicros),
      },
    });
  },
);
