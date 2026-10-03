import { withApiHandler, json, parseJsonBody } from "@/lib/http";
import { UpdateBudgetSchema } from "@/lib/schemas";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/errors";
import { liveUtilization, invalidateBudgetCache, type LiveUtilization } from "@/lib/services/budgets";
import {
  assertBudgetWritable,
  findVisibleBudget,
  snapshotOf,
  toBudgetDTO,
} from "@/lib/services/budget-access";
import { recordAudit, toAuditJson } from "@/lib/services/audit";
import { applyBudgetUpdate } from "@/lib/services/budget-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { budgetId: string };

export const GET = withApiHandler<Params>({ scopes: ["budgets:read"] }, async ({ auth, params }) => {
  const budget = await findVisibleBudget(auth, params.budgetId);
  const live = budget.isActive ? await liveUtilization([snapshotOf(budget)]) : new Map<string, LiveUtilization>();
  return json({ data: toBudgetDTO(budget, live.get(budget.id)) });
});

export const PATCH = withApiHandler<Params>({ scopes: ["budgets:write"] }, async ({ req, auth, params, requestId }) => {
  const patch = await parseJsonBody(req, UpdateBudgetSchema, 16_000);
  const existing = await findVisibleBudget(auth, params.budgetId);
  assertBudgetWritable(auth, {
    scope: existing.scope,
    projectId: existing.projectId,
    agentProjectId: existing.agent?.projectId ?? null,
  });
  const updated = await applyBudgetUpdate({ existing, patch, actor: { type: "API_KEY", id: auth.apiKeyId }, requestId });
  const live = updated.isActive ? await liveUtilization([snapshotOf(updated)]) : new Map<string, LiveUtilization>();
  return json({ data: toBudgetDTO(updated, live.get(updated.id)) });
});

export const DELETE = withApiHandler<Params>({ scopes: ["budgets:write"] }, async ({ auth, params, requestId }) => {
  const existing = await findVisibleBudget(auth, params.budgetId);
  assertBudgetWritable(auth, {
    scope: existing.scope,
    projectId: existing.projectId,
    agentProjectId: existing.agent?.projectId ?? null,
  });
  if (existing.managedBy) throw Errors.conflict("This budget follows your subscription plan and cannot be deleted.");

  await prisma.$transaction(async (tx) => {
    await tx.budget.delete({ where: { id: existing.id } });
    await recordAudit(
      {
        organizationId: auth.organizationId,
        actorType: "API_KEY",
        actorId: auth.apiKeyId,
        action: "budget.deleted",
        targetType: "budget",
        targetId: existing.id,
        before: toAuditJson(snapshotOf(existing)),
        requestId,
      },
      tx,
    );
  });

  await invalidateBudgetCache(auth.organizationId);
  return new Response(null, { status: 204 });
});

