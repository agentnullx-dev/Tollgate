import { Prisma, type Agent, type Alert, type SecurityIncident } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { publishAlerts } from "@/lib/notifications/events";
import { afterAgentTransition, transitionAgentStatus } from "@/lib/services/agent-control";
import { recordAudit } from "@/lib/services/audit";
import { DETECTOR_VERSION, type DetectorConfig, type Verdict } from "./detector";

export interface QuarantineOutcome {
  incident: SecurityIncident | null;
  alert: Alert | null;
  quarantined: boolean;
  duplicate: boolean;
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Record a security incident for an anomalous verdict and, when enabled,
 * quarantine the agent through the shared kill-switch state machine.
 *
 * Everything that must be consistent happens in one database transaction:
 *   1. agent ACTIVE/PAUSED -> QUARANTINED (compare-and-set)
 *   2. security_incidents row with full statistical evidence
 *   3. immutable ledger entry of type SECURITY_INCIDENT
 *   4. audit log entry (actor SYSTEM / anomaly-engine)
 *   5. AGENT_QUARANTINED (or ANOMALY_DETECTED) alert linked to the incident
 * The dedupe key makes the whole operation idempotent across replicas.
 */
export async function recordAnomalyAndQuarantine(input: {
  agent: Pick<Agent, "id" | "organizationId" | "projectId" | "externalId" | "displayName" | "status">;
  verdict: Verdict;
  config: DetectorConfig;
  autoQuarantine: boolean;
  detector?: string;
}): Promise<QuarantineOutcome> {
  const { agent, verdict, config } = input;
  const dedupeKey = `anomaly:${agent.id}:${verdict.windowEndMinute}`;
  const existing = await prisma.securityIncident.findUnique({ where: { dedupeKey } });
  if (existing) return { incident: existing, alert: null, quarantined: false, duplicate: true };

  const name = agent.displayName ?? agent.externalId;
  const windowStart = new Date(verdict.windowStartMinute * 60_000);
  const windowEnd = new Date((verdict.windowEndMinute + 1) * 60_000);
  const spendUsd = verdict.windowSpendMicros / 1e6;
  const reason = `Auto-quarantined: spend ${round(verdict.windowMeanPerMinute / 1e6)} USD/min over ${config.windowMinutes} min is ${round(verdict.zScore, 1)}σ above baseline.`;

  const evidence = {
    detectorVersion: DETECTOR_VERSION,
    sigma: config.sigma,
    windowMinutes: config.windowMinutes,
    baselineMinutes: config.baselineMinutes,
    windowSpendUsd: round(spendUsd, 6),
    windowMeanPerMinuteUsd: round(verdict.windowMeanPerMinute / 1e6, 6),
    windowRequests: verdict.windowRequests,
    windowTokens: verdict.windowTokens,
    governingBaseline: verdict.baseline,
    rollingBaseline: verdict.rolling,
    longTermBaseline: verdict.longTerm,
    tokensPerRequest: verdict.tokensPerRequest,
    reasons: verdict.reasons,
  } as unknown as Prisma.InputJsonValue;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        let quarantined = false;
        let actionTaken = "ALERT_ONLY";
        if (input.autoQuarantine && (agent.status === "ACTIVE" || agent.status === "PAUSED")) {
          const transition = await transitionAgentStatus(tx, {
            agentId: agent.id,
            organizationId: agent.organizationId,
            to: "QUARANTINED",
            reason,
            actor: { type: "SYSTEM", id: input.detector ?? "anomaly-engine" },
            expectFrom: ["ACTIVE", "PAUSED"],
          });
          quarantined = transition.changed;
          actionTaken = quarantined ? "QUARANTINED" : "ALREADY_RESTRICTED";
        } else if (agent.status === "KILLED" || agent.status === "QUARANTINED") {
          actionTaken = "ALREADY_RESTRICTED";
        }

        const incident = await tx.securityIncident.create({
          data: {
            organizationId: agent.organizationId,
            agentId: agent.id,
            type: "SPEND_ANOMALY",
            severity: "CRITICAL",
            dedupeKey,
            detector: input.detector ?? "anomaly-engine",
            detectorVersion: DETECTOR_VERSION,
            windowStart,
            windowEnd,
            windowSpendMicros: BigInt(Math.round(verdict.windowSpendMicros)),
            baselineMeanMicros: verdict.baseline?.mean ?? 0,
            baselineStdMicros: verdict.baseline?.effectiveStd ?? 0,
            thresholdMicros: verdict.thresholdPerMinute,
            zScore: verdict.zScore,
            actionTaken,
            evidence,
          },
        });

        // Zero-amount ledger marker: places the incident on the financial timeline
        // without altering any spend totals.
        await tx.ledgerEntry.create({
          data: {
            organizationId: agent.organizationId,
            projectId: agent.projectId,
            agentId: agent.id,
            securityIncidentId: incident.id,
            type: "SECURITY_INCIDENT",
            amountMicros: 0n,
            description: `Security incident ${incident.id}: spend anomaly (${round(verdict.zScore, 1)}σ, ${round(spendUsd, 4)} USD in ${config.windowMinutes} min). Action: ${actionTaken}.`,
          },
        });

        await recordAudit(
          {
            organizationId: agent.organizationId,
            actorType: "SYSTEM",
            actorId: input.detector ?? "anomaly-engine",
            action: "security.incident.opened",
            targetType: "security_incident",
            targetId: incident.id,
            after: { agentId: agent.id, zScore: round(verdict.zScore, 3), actionTaken },
          },
          tx,
        );

        const alert = await tx.alert.create({
          data: {
            organizationId: agent.organizationId,
            agentId: agent.id,
            securityIncidentId: incident.id,
            type: quarantined ? "AGENT_QUARANTINED" : "ANOMALY_DETECTED",
            severity: "CRITICAL",
            dedupeKey: `incident:${incident.id}`,
            message: quarantined
              ? `${name} was quarantined: spend of ${round(spendUsd, 2)} USD in ${config.windowMinutes} minutes is ${round(verdict.zScore, 1)} standard deviations above normal.`
              : `${name} spent ${round(spendUsd, 2)} USD in ${config.windowMinutes} minutes, ${round(verdict.zScore, 1)} standard deviations above normal.`,
            payload: { zScore: round(verdict.zScore, 3), windowSpendMicros: String(Math.round(verdict.windowSpendMicros)) },
          },
        });

        return { incident, alert, quarantined };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
    );

    if (result.quarantined) await afterAgentTransition(agent);
    await publishAlerts([result.alert]);
    logger.warn("anomaly.incident_recorded", {
      agentId: agent.id,
      incidentId: result.incident.id,
      zScore: verdict.zScore,
      quarantined: result.quarantined,
    });
    return { ...result, duplicate: false };
  } catch (err) {
    // Another replica recorded the same window first.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const incident = await prisma.securityIncident.findUnique({ where: { dedupeKey } });
      return { incident, alert: null, quarantined: false, duplicate: true };
    }
    throw err;
  }
}

/** Token-size drift without a spend spike: raise a warning alert, no quarantine. */
export async function recordTokenDrift(input: {
  agent: Pick<Agent, "id" | "organizationId" | "externalId" | "displayName">;
  verdict: Verdict;
}): Promise<void> {
  const t = input.verdict.tokensPerRequest;
  if (!t) return;
  const name = input.agent.displayName ?? input.agent.externalId;
  try {
    const alert = await prisma.alert.create({
      data: {
        organizationId: input.agent.organizationId,
        agentId: input.agent.id,
        type: "ANOMALY_DETECTED",
        severity: "WARNING",
        // One warning per agent per hour.
        dedupeKey: `tpr:${input.agent.id}:${Math.floor(input.verdict.windowEndMinute / 60)}`,
        message: `${name} is sending unusually large requests: ${Math.round(t.window)} tokens per request against a normal ${Math.round(t.mean)} (${t.zScore.toFixed(1)}σ).`,
        payload: { tokensPerRequest: Math.round(t.window), baseline: Math.round(t.mean), zScore: round(t.zScore, 3) },
      },
    });
    await publishAlerts([alert]);
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
}
