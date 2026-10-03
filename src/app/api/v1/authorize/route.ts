import { withApiHandler, json, parseJsonBody } from "@/lib/http";
import { AuthorizeRequestSchema } from "@/lib/schemas";
import { Errors } from "@/lib/errors";
import { computeCostMicros, microsToUsd, formatUsd } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getModelPricing } from "@/lib/services/pricing";
import { resolveAgent, checkVelocity, type AgentSnapshot } from "@/lib/services/agents";
import { applicableBudgets, loadActiveBudgets, reserveSpend, windowsFor } from "@/lib/services/budgets";
import { emitAlerts } from "@/lib/services/alerts";
import { afterAgentTransition, transitionAgentStatus } from "@/lib/services/agent-control";
import { getBillingStatus } from "@/lib/billing/gate";
import type { AuthorizeResponse, DenyReasonCode } from "@/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function agentView(agent: AgentSnapshot): AuthorizeResponse["agent"] {
  return { id: agent.id, externalId: agent.externalId, status: agent.status, enforcementMode: agent.enforcementMode };
}

function deny(
  agent: AgentSnapshot,
  estimateMicros: bigint,
  code: DenyReasonCode,
  message: string,
  extra: Partial<NonNullable<AuthorizeResponse["reason"]>> = {},
) {
  const body: AuthorizeResponse = {
    decision: "DENY",
    reservationId: null,
    expiresAt: null,
    estimatedCostMicros: estimateMicros.toString(),
    estimatedCostUsd: microsToUsd(estimateMicros),
    reason: { code, message, ...extra },
    agent: agentView(agent),
  };
  return json(body, { status: 200 });
}

const STATUS_DENIALS: Record<Exclude<AgentSnapshot["status"], "ACTIVE">, { code: DenyReasonCode; message: string }> = {
  PAUSED: { code: "AGENT_PAUSED", message: "This agent is paused. Resume it to allow new requests." },
  KILLED: { code: "AGENT_KILLED", message: "This agent has been stopped. Reactivate it to resume traffic." },
  QUARANTINED: {
    code: "AGENT_QUARANTINED",
    message: "This agent was quarantined after anomalous spend. An administrator must review the incident and release it.",
  },
};

/**
 * Pre-flight authorization. Call this before every LLM request.
 *
 * Denials are business outcomes, not transport errors: they return HTTP 200
 * with `decision: "DENY"` so SDKs can distinguish "blocked by policy" from
 * "gateway unreachable" and choose fail-open or fail-closed behaviour.
 */
export const POST = withApiHandler({ scopes: ["gateway:authorize"] }, async ({ req, auth, requestId }) => {
  const body = await parseJsonBody(req, AuthorizeRequestSchema, 64_000);

  const pricing = await getModelPricing(body.provider, body.model);
  if (!pricing) throw Errors.unknownModel(body.provider, body.model);

  const agent = await resolveAgent({
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    externalId: body.agentKey,
    displayName: body.agentName,
  });

  // Worst-case estimate: full prompt plus the maximum completion the caller allows.
  const estimateMicros = computeCostMicros(pricing, {
    inputTokens: body.estimatedInputTokens,
    outputTokens: body.maxOutputTokens,
    cachedInputTokens: body.estimatedCachedInputTokens,
  });

  // 0. Organization billing gate: covers every agent, including ones registering right now.
  if ((await getBillingStatus(auth.organizationId)) === "SUSPENDED") {
    return deny(
      agent,
      estimateMicros,
      "BILLING_SUSPENDED",
      "This organization is suspended for non-payment. Requests resume automatically once the outstanding invoice is paid.",
    );
  }

  // 1. Kill switch, pause and quarantine.
  if (agent.status !== "ACTIVE") {
    const d = STATUS_DENIALS[agent.status];
    return deny(agent, estimateMicros, d.code, d.message);
  }

  // 2. Runaway-loop guard.
  const velocity = await checkVelocity(agent);
  if (!velocity.allowed && velocity.limit !== null) {
    let autoKilled = false;
    if (agent.autoKillOnVelocity) {
      const reason = `Auto-stopped: ${velocity.count} requests in one minute exceeded the limit of ${velocity.limit}.`;
      const result = await prisma.$transaction((tx) =>
        transitionAgentStatus(tx, {
          agentId: agent.id,
          organizationId: auth.organizationId,
          to: "KILLED",
          reason,
          actor: { type: "SYSTEM", id: "velocity-guard" },
          requestId,
          expectFrom: ["ACTIVE"],
        }),
      );
      autoKilled = result.changed;
      if (autoKilled) await afterAgentTransition(agent);
    }

    await emitAlerts([
      {
        organizationId: auth.organizationId,
        agentId: agent.id,
        type: autoKilled ? "AGENT_KILLED" : "VELOCITY_LIMIT",
        severity: "CRITICAL",
        dedupeKey: autoKilled ? `killed:${agent.id}:${velocity.minute}` : `velocity:${agent.id}:${velocity.minute}`,
        message: autoKilled
          ? `${agent.displayName ?? agent.externalId} was stopped automatically after ${velocity.count} requests in one minute.`
          : `${agent.displayName ?? agent.externalId} exceeded ${velocity.limit} requests per minute.`,
        payload: { count: velocity.count, limit: velocity.limit },
      },
    ]);

    return deny(
      { ...agent, status: autoKilled ? "KILLED" : agent.status },
      estimateMicros,
      "VELOCITY_LIMIT",
      `Request rate exceeded ${velocity.limit} per minute.${autoKilled ? " The agent has been stopped." : ""}`,
      { requestsThisMinute: velocity.count, limitPerMinute: velocity.limit },
    );
  }

  // 3. Budget enforcement: atomic check-and-reserve across every applicable budget.
  //    Alert-only agents are evaluated and reserved the same way but never blocked.
  const now = new Date();
  const strict = agent.enforcementMode === "STRICT";
  const budgets = applicableBudgets(await loadActiveBudgets(auth.organizationId), auth.projectId, agent.id);
  const windows = windowsFor(budgets, now, now);
  const result = await reserveSpend({
    windows,
    estimateMicros,
    projectId: auth.projectId,
    agentId: agent.id,
    enforce: strict,
    now,
  });

  if (!result.allowed) {
    const { budget, window } = result.blocking;
    const headroom = budget.limitMicros - result.committedMicros - result.reservedMicros;
    await emitAlerts([
      {
        organizationId: auth.organizationId,
        budgetId: budget.id,
        agentId: agent.id,
        type: "BUDGET_BLOCKED",
        severity: "CRITICAL",
        dedupeKey: `blocked:${budget.id}:${window.key}`,
        periodKey: window.key,
        message: `${budget.name} blocked a request from ${agent.displayName ?? agent.externalId}: limit ${formatUsd(budget.limitMicros)} reached.`,
        payload: {
          committedMicros: result.committedMicros.toString(),
          reservedMicros: result.reservedMicros.toString(),
          estimateMicros: estimateMicros.toString(),
        },
      },
    ]);
    logger.info("authorize.denied", { requestId, budgetId: budget.id, agentId: agent.id });

    return deny(agent, estimateMicros, "BUDGET_EXCEEDED", `${budget.name} does not have enough headroom for this request.`, {
      budgetId: budget.id,
      budgetName: budget.name,
      periodKey: window.key,
      limitUsd: microsToUsd(budget.limitMicros),
      committedUsd: microsToUsd(result.committedMicros),
      reservedUsd: microsToUsd(result.reservedMicros),
      headroomUsd: microsToUsd(headroom > 0n ? headroom : 0n),
    });
  }

  // A limit was crossed but nothing blocked: the agent is alert-only or the budget is alert-only.
  if (result.softViolation) {
    const { budget, window } = result.softViolation.window;
    await emitAlerts([
      {
        organizationId: auth.organizationId,
        budgetId: budget.id,
        agentId: agent.id,
        type: "BUDGET_LIMIT_BYPASSED",
        severity: "WARNING",
        dedupeKey: `bypassed:${budget.id}:${window.key}:${agent.id}`,
        periodKey: window.key,
        message: `${agent.displayName ?? agent.externalId} went past ${budget.name} (${formatUsd(budget.limitMicros)}) and was allowed because ${
          strict ? "the budget only alerts" : "the agent runs in alert-only mode"
        }.`,
        payload: {
          committedMicros: result.softViolation.committedMicros.toString(),
          reservedMicros: result.softViolation.reservedMicros.toString(),
          spentMicros: (result.softViolation.committedMicros + result.softViolation.reservedMicros + estimateMicros).toString(),
          agentEnforcementMode: agent.enforcementMode,
        },
      },
    ]);
  }

  const response: AuthorizeResponse = {
    decision: "ALLOW",
    reservationId: result.reservationId,
    expiresAt: result.expiresAt.toISOString(),
    estimatedCostMicros: estimateMicros.toString(),
    estimatedCostUsd: microsToUsd(estimateMicros),
    reason: null,
    agent: agentView(agent),
    overLimit: result.softViolation
      ? { budgetId: result.softViolation.window.budget.id, budgetName: result.softViolation.window.budget.name }
      : null,
    budgetsEvaluated: windows.map(({ budget, window }) => ({
      budgetId: budget.id,
      name: budget.name,
      periodKey: window.key,
      enforcement: strict ? budget.enforcement : "ALERT_ONLY",
    })),
  };
  return json(response, { status: 200 });
});
