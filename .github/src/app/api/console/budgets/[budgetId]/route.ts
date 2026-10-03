import { json, parseJsonBody } from "@/lib/http";
import { UpdateBudgetSchema } from "@/lib/schemas";
import { Errors } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { withSessionHandler } from "@/lib/session";
import { applyBudgetUpdate } from "@/lib/services/budget-admin";
import { budgetInclude, snapshotOf, toBudgetDTO } from "@/lib/services/budget-access";
import { liveUtilization, type LiveUtilization } from "@/lib/services/budgets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Change limits, enforcement and on/off state. org:admin only. */
export const PATCH = withSessionHandler<{ budgetId: string }>({ permission: "budgets:write" }, async ({ req, params, session, requestId }) => {
  const patch = await parseJsonBody(req, UpdateBudgetSchema, 16_000);
  const existing = await prisma.budget.findFirst({
    where: { id: params.budgetId, organizationId: session.organizationId },
    include: budgetInclude,
  });
  if (!existing) throw Errors.notFound("Budget", params.budgetId);
  const updated = await applyBudgetUpdate({ existing, patch, actor: { type: "USER", id: session.userId }, requestId });
  const live = updated.isActive ? await liveUtilization([snapshotOf(updated)]) : new Map<string, LiveUtilization>();
  return json({ data: toBudgetDTO(updated, live.get(updated.id)) });
});
