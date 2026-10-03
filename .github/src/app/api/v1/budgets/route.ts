import { withApiHandler, json, parseJsonBody } from "@/lib/http";
import { CreateBudgetSchema } from "@/lib/schemas";
import { Errors } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { usdToMicros } from "@/lib/money";
import { liveUtilization, invalidateBudgetCache } from "@/lib/services/budgets";
import {
  assertBudgetWritable,
  budgetInclude,
  snapshotOf,
  toBudgetDTO,
  visibleBudgetsWhere,
} from "@/lib/services/budget-access";
import { recordAudit, toAuditJson } from "@/lib/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BUDGETS_PER_ORG = 200;

/** List budgets with live current-period utilization (committed + in-flight). */
export const GET = withApiHandler({ scopes: ["budgets:read"] }, async ({ req, auth }) => {
  const includeInactive = req.nextUrl.searchParams.get("includeInactive") === "true";
  const rows = await prisma.budget.findMany({
    where: { AND: [visibleBudgetsWhere(auth), includeInactive ? {} : { isActive: true }] },
    include: budgetInclude,
    orderBy: [{ scope: "asc" }, { createdAt: "asc" }],
  });

  const active = rows.filter((r) => r.isActive);
  const live = await liveUtilization(active.map(snapshotOf));
  return json({ data: rows.map((row) => toBudgetDTO(row, live.get(row.id))) });
});

export const POST = withApiHandler({ scopes: ["budgets:write"] }, async ({ req, auth, requestId }) => {
  const input = await parseJsonBody(req, CreateBudgetSchema, 16_000);

  let projectId: string | null = null;
  let agentId: string | null = null;
  let agentProjectId: string | null = null;

  if (input.scope === "PROJECT") {
    if (!input.projectId) throw Errors.badRequest("Project budgets require projectId.");
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, organizationId: auth.organizationId, archivedAt: null },
      select: { id: true },
    });
    if (!project) throw Errors.notFound("Project", input.projectId);
    projectId = project.id;
  }

  if (input.scope === "AGENT") {
    if (!input.agentId) throw Errors.badRequest("Agent budgets require agentId.");
    const agent = await prisma.agent.findFirst({
      where: { id: input.agentId, organizationId: auth.organizationId },
      select: { id: true, projectId: true },
    });
    if (!agent) throw Errors.notFound("Agent", input.agentId);
    if (input.projectId && input.projectId !== agent.projectId) {
      throw Errors.badRequest("projectId does not match the agent's project.");
    }
    agentId = agent.id;
    agentProjectId = agent.projectId;
    projectId = agent.projectId;
  }

  assertBudgetWritable(auth, { scope: input.scope, projectId, agentProjectId });

  const count = await prisma.budget.count({ where: { organizationId: auth.organizationId } });
  if (count >= MAX_BUDGETS_PER_ORG) {
    throw Errors.conflict(`Organizations can have at most ${MAX_BUDGETS_PER_ORG} budgets. Delete unused budgets first.`);
  }

  const created = await prisma.$transaction(async (tx) => {
    const budget = await tx.budget.create({
      data: {
        organizationId: auth.organizationId,
        scope: input.scope,
        projectId,
        agentId,
        name: input.name,
        period: input.period,
        limitMicros: usdToMicros(input.limitUsd),
        enforcement: input.enforcement,
        alertThresholds: input.alertThresholds,
      },
      include: budgetInclude,
    });
    await recordAudit(
      {
        organizationId: auth.organizationId,
        actorType: "API_KEY",
        actorId: auth.apiKeyId,
        action: "budget.created",
        targetType: "budget",
        targetId: budget.id,
        after: toAuditJson(snapshotOf(budget)),
        requestId,
      },
      tx,
    );
    return budget;
  });

  await invalidateBudgetCache(auth.organizationId);
  const live = await liveUtilization([snapshotOf(created)]);
  return json({ data: toBudgetDTO(created, live.get(created.id)) }, { status: 201 });
});
