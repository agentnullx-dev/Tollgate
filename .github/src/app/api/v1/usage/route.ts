import { Prisma } from "@prisma/client";
import { withApiHandler, json, parseJsonBody, parseQuery } from "@/lib/http";
import { UsageIngestRequestSchema, UsageQuerySchema } from "@/lib/schemas";
import { Errors } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { redis, keys } from "@/lib/redis";
import { recordAgentUsage } from "@/lib/anomaly/metrics";
import { logger } from "@/lib/logger";
import { computeCostMicros, microsToUsd } from "@/lib/money";
import { getModelPricing } from "@/lib/services/pricing";
import { resolveAgent, touchAgents, type AgentSnapshot } from "@/lib/services/agents";
import {
  applicableBudgets,
  ensureCommittedCounters,
  loadActiveBudgets,
  loadReservation,
  settleSpend,
  windowsFor,
  type ReservationRecord,
} from "@/lib/services/budgets";
import { emitAlerts, thresholdCrossings, type AlertDraft } from "@/lib/services/alerts";
import type {
  IngestEventResult,
  IngestResponse,
  UsageAgentRow,
  UsageDayRow,
  UsageModelRow,
  UsageQueryResponse,
  UsageTotals,
} from "@/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FUTURE_SKEW_MS = 5 * 60_000;
const MAX_EVENT_AGE_MS = 35 * 86_400_000;

/**
 * Batch usage ingestion (post-flight). Each event is:
 *  1. validated and priced from the model price table,
 *  2. written with its ledger debit in a single atomic insert, de-duplicated by
 *     (projectId, idempotencyKey) so client retries are always safe,
 *  3. settled in Redis: the pre-flight reservation is released and the actual
 *     cost is committed to every applicable budget counter,
 *  4. checked for threshold crossings, which raise de-duplicated alerts.
 *
 * Returns 200 when every event was accepted or was a duplicate, 207 when some
 * events were rejected (per-event results explain why).
 */
export const POST = withApiHandler({ scopes: ["usage:write"] }, async ({ req, auth, requestId }) => {
  const { events } = await parseJsonBody(req, UsageIngestRequestSchema, 2_000_000);

  const now = new Date();
  const budgets = await loadActiveBudgets(auth.organizationId);
  const agents = new Map<string, AgentSnapshot>();
  const touchedAgentIds = new Set<string>();
  const anomalySamples: Array<{ agentId: string; costMicros: bigint; requests: number; tokens: number }> = [];
  const alertDrafts = new Map<string, AlertDraft>();
  const results: IngestEventResult[] = [];
  let totalCost = 0n;

  const reject = (index: number, idempotencyKey: string, code: string, message: string) => {
    results.push({ index, idempotencyKey, status: "rejected", error: { code, message } });
  };

  for (const [index, event] of events.entries()) {
    const occurredAt = event.occurredAt ?? now;
    if (occurredAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
      reject(index, event.idempotencyKey, "INVALID_TIMESTAMP", "occurredAt cannot be more than 5 minutes in the future.");
      continue;
    }
    if (occurredAt.getTime() < now.getTime() - MAX_EVENT_AGE_MS) {
      reject(index, event.idempotencyKey, "INVALID_TIMESTAMP", "occurredAt cannot be older than 35 days.");
      continue;
    }

    const pricing = await getModelPricing(event.provider, event.model);
    if (!pricing) {
      reject(index, event.idempotencyKey, "UNKNOWN_MODEL", `No pricing is configured for ${event.provider}/${event.model}.`);
      continue;
    }

    let agent = agents.get(event.agentKey);
    if (!agent) {
      agent = await resolveAgent({
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        externalId: event.agentKey,
      });
      agents.set(event.agentKey, agent);
    }

    const costMicros = computeCostMicros(pricing, {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cachedInputTokens: event.cachedInputTokens,
    });

    const windows = windowsFor(applicableBudgets(budgets, auth.projectId, agent.id), occurredAt, now);
    await ensureCommittedCounters(windows);

    let reservation: ReservationRecord | null = null;
    if (event.reservationId) {
      const found = await loadReservation(event.reservationId);
      // Reservations are only honoured inside the project that created them.
      if (found && found.projectId === auth.projectId && found.agentId === agent.id) reservation = found;
    }

    let usageEventId: string;
    try {
      const created = await prisma.usageEvent.create({
        data: {
          organizationId: auth.organizationId,
          projectId: auth.projectId,
          agentId: agent.id,
          apiKeyId: auth.apiKeyId,
          idempotencyKey: event.idempotencyKey,
          reservationId: event.reservationId ?? null,
          provider: event.provider,
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedInputTokens: event.cachedInputTokens,
          costMicros,
          latencyMs: event.latencyMs ?? null,
          status: event.status,
          traceId: event.traceId ?? null,
          metadata: event.metadata ?? undefined,
          occurredAt,
          ledgerEntry: {
            create: {
              organizationId: auth.organizationId,
              projectId: auth.projectId,
              agentId: agent.id,
              type: "USAGE_DEBIT",
              amountMicros: costMicros,
              description: `${event.provider}/${event.model}: ${event.inputTokens + event.cachedInputTokens} in, ${event.outputTokens} out`,
            },
          },
        },
        select: { id: true },
      });
      usageEventId = created.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await prisma.usageEvent.findUnique({
          where: { projectId_idempotencyKey: { projectId: auth.projectId, idempotencyKey: event.idempotencyKey } },
          select: { id: true, costMicros: true },
        });
        results.push({
          index,
          idempotencyKey: event.idempotencyKey,
          status: "duplicate",
          usageEventId: existing?.id,
          costMicros: existing?.costMicros.toString(),
          costUsd: existing ? microsToUsd(existing.costMicros) : undefined,
        });
        continue;
      }
      throw err;
    }

    try {
      const outcomes = await settleSpend({ windows, costMicros, reservation });
      for (const outcome of outcomes) {
        for (const draft of thresholdCrossings(outcome.window, outcome.beforeMicros, outcome.afterMicros)) {
          alertDrafts.set(draft.dedupeKey, draft);
        }
      }
    } catch (err) {
      // Postgres already holds the authoritative record. Drop the affected
      // counters so the next request rebuilds them from the ledger.
      logger.error("usage.settle_failed", { requestId, usageEventId, err });
      await redis()
        .del(...windows.map(({ budget, window }) => keys.committed(budget.id, window.key)))
        .catch((delErr) => logger.error("usage.counter_invalidation_failed", { requestId, err: delErr }));
    }

    touchedAgentIds.add(agent.id);
    anomalySamples.push({
      agentId: agent.id,
      costMicros,
      requests: 1,
      tokens: event.inputTokens + event.outputTokens + event.cachedInputTokens,
    });
    totalCost += costMicros;
    results.push({
      index,
      idempotencyKey: event.idempotencyKey,
      status: "accepted",
      usageEventId,
      costMicros: costMicros.toString(),
      costUsd: microsToUsd(costMicros),
    });
  }

  await touchAgents([...touchedAgentIds], now);
  // Feed the anomaly engine. Bucketed by ingestion time: the detector watches live consumption.
  await recordAgentUsage(redis(), anomalySamples, now.getTime()).catch((err) =>
    logger.warn("usage.anomaly_metrics_failed", { requestId, err }),
  );
  const raised = await emitAlerts([...alertDrafts.values()]);

  const summary = {
    received: events.length,
    accepted: results.filter((r) => r.status === "accepted").length,
    duplicate: results.filter((r) => r.status === "duplicate").length,
    rejected: results.filter((r) => r.status === "rejected").length,
    totalCostUsd: microsToUsd(totalCost),
  };
  const body: IngestResponse = {
    summary,
    results: results.sort((a, b) => a.index - b.index),
    alertsRaised: raised.length,
  };
  return json(body, { status: summary.rejected > 0 ? 207 : 200 });
});

// ---------------------------------------------------------------------------
// GET /api/v1/usage?from&to&groupBy=day|agent|model&agentId
// ---------------------------------------------------------------------------

function toTotals(sum: {
  costMicros: bigint | null;
  inputTokens: number | bigint | null;
  outputTokens: number | bigint | null;
  requests: number | bigint;
}): UsageTotals {
  const cost = sum.costMicros ?? 0n;
  return {
    requests: Number(sum.requests),
    inputTokens: Number(sum.inputTokens ?? 0),
    outputTokens: Number(sum.outputTokens ?? 0),
    costMicros: cost.toString(),
    costUsd: microsToUsd(cost),
  };
}

export const GET = withApiHandler({ scopes: ["usage:read"] }, async ({ req, auth }) => {
  const query = parseQuery(req, UsageQuerySchema);

  if (query.agentId) {
    const agent = await prisma.agent.findFirst({
      where: { id: query.agentId, projectId: auth.projectId },
      select: { id: true },
    });
    if (!agent) throw Errors.notFound("Agent", query.agentId);
  }

  const where: Prisma.UsageEventWhereInput = {
    projectId: auth.projectId,
    occurredAt: { gte: query.from, lt: query.to },
    ...(query.agentId ? { agentId: query.agentId } : {}),
  };

  const aggregate = await prisma.usageEvent.aggregate({
    where,
    _sum: { costMicros: true, inputTokens: true, outputTokens: true },
    _count: { _all: true },
  });
  const totals = toTotals({ ...aggregate._sum, requests: aggregate._count._all });

  let rows: UsageQueryResponse["rows"];

  if (query.groupBy === "day") {
    const agentFilter = query.agentId ? Prisma.sql`AND "agentId" = ${query.agentId}` : Prisma.empty;
    const dayRows = await prisma.$queryRaw<
      Array<{ bucket: Date; cost: bigint; input: bigint; output: bigint; requests: bigint }>
    >`
      SELECT date_trunc('day', "occurredAt") AS bucket,
             COALESCE(SUM("costMicros"), 0)::bigint   AS cost,
             COALESCE(SUM("inputTokens"), 0)::bigint  AS input,
             COALESCE(SUM("outputTokens"), 0)::bigint AS output,
             COUNT(*)::bigint                         AS requests
      FROM "usage_events"
      WHERE "projectId" = ${auth.projectId}
        AND "occurredAt" >= ${query.from}
        AND "occurredAt" < ${query.to}
        ${agentFilter}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const byDate = new Map(dayRows.map((r) => [r.bucket.toISOString().slice(0, 10), r]));
    const filled: UsageDayRow[] = [];
    const cursor = new Date(Date.UTC(query.from.getUTCFullYear(), query.from.getUTCMonth(), query.from.getUTCDate()));
    while (cursor < query.to) {
      const date = cursor.toISOString().slice(0, 10);
      const r = byDate.get(date);
      filled.push({
        date,
        ...toTotals({
          costMicros: r?.cost ?? 0n,
          inputTokens: r?.input ?? 0n,
          outputTokens: r?.output ?? 0n,
          requests: r?.requests ?? 0n,
        }),
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    rows = filled;
  } else if (query.groupBy === "agent") {
    const grouped = await prisma.usageEvent.groupBy({
      by: ["agentId"],
      where,
      _sum: { costMicros: true, inputTokens: true, outputTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { costMicros: "desc" } },
      take: 200,
    });
    const agentRows = await prisma.agent.findMany({
      where: { id: { in: grouped.map((g) => g.agentId) } },
      select: { id: true, externalId: true, displayName: true },
    });
    const byId = new Map(agentRows.map((a) => [a.id, a]));
    rows = grouped.map((g): UsageAgentRow => {
      const agent = byId.get(g.agentId);
      return {
        agentId: g.agentId,
        externalId: agent?.externalId ?? "unknown",
        displayName: agent?.displayName ?? null,
        ...toTotals({ ...g._sum, requests: g._count._all }),
      };
    });
  } else {
    const grouped = await prisma.usageEvent.groupBy({
      by: ["provider", "model"],
      where,
      _sum: { costMicros: true, inputTokens: true, outputTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { costMicros: "desc" } },
      take: 200,
    });
    rows = grouped.map(
      (g): UsageModelRow => ({
        provider: g.provider,
        model: g.model,
        ...toTotals({ ...g._sum, requests: g._count._all }),
      }),
    );
  }

  const body: UsageQueryResponse = {
    range: { from: query.from.toISOString(), to: query.to.toISOString() },
    groupBy: query.groupBy,
    totals,
    rows,
  };
  return json(body);
});
