import { withApiHandler, json, parseQuery } from "@/lib/http";
import { IncidentQuerySchema } from "@/lib/schemas";
import { hasScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { microsToUsd } from "@/lib/money";
import type { SecurityIncidentDTO } from "@/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Security incidents raised by the anomaly engine, newest first. */
export const GET = withApiHandler({ scopes: ["usage:read"] }, async ({ req, auth }) => {
  const q = parseQuery(req, IncidentQuerySchema);
  const rows = await prisma.securityIncident.findMany({
    where: {
      organizationId: auth.organizationId,
      ...(hasScope(auth, "org:admin") ? {} : { agent: { projectId: auth.projectId } }),
      ...(q.status ? { status: q.status } : {}),
      ...(q.agentId ? { agentId: q.agentId } : {}),
    },
    include: { agent: { select: { externalId: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
    take: q.limit,
  });

  const data: SecurityIncidentDTO[] = rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentName: r.agent.displayName ?? r.agent.externalId,
    type: r.type,
    severity: r.severity,
    status: r.status,
    windowStart: r.windowStart.toISOString(),
    windowEnd: r.windowEnd.toISOString(),
    windowSpendUsd: microsToUsd(r.windowSpendMicros),
    baselineMeanPerMinuteUsd: r.baselineMeanMicros / 1_000_000,
    baselineStdPerMinuteUsd: r.baselineStdMicros / 1_000_000,
    thresholdPerMinuteUsd: r.thresholdMicros / 1_000_000,
    zScore: r.zScore,
    actionTaken: r.actionTaken,
    detectorVersion: r.detectorVersion,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolutionNote: r.resolutionNote,
  }));
  return json({ data });
});
