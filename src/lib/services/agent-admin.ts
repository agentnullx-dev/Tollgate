import type { ActorType, Agent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/errors";
import type { UpdateAgentInput } from "@/lib/schemas";
import { emitAlerts } from "@/lib/services/alerts";
import { recordAudit, toAuditJson } from "@/lib/services/audit";
import { afterAgentTransition, InvalidTransitionError, transitionAgentStatus } from "@/lib/services/agent-control";
import type { AgentDTO } from "@/types/api";

export function toAgentDTO(agent: Agent): AgentDTO {
  return {
    id: agent.id,
    externalId: agent.externalId,
    displayName: agent.displayName,
    projectId: agent.projectId,
    status: agent.status,
    enforcementMode: agent.enforcementMode,
    maxRequestsPerMinute: agent.maxRequestsPerMinute,
    autoKillOnVelocity: agent.autoKillOnVelocity,
    quarantinedAt: agent.quarantinedAt?.toISOString() ?? null,
    killedAt: agent.killedAt?.toISOString() ?? null,
    killReason: agent.killReason,
    lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

/**
 * Apply an agent update. Authorization (scopes or roles) is the caller's job;
 * this enforces business rules shared by every entry point:
 *   - status changes go through the kill-switch state machine,
 *   - releasing a quarantine needs a reason and closes open incidents,
 *   - agents cannot be reactivated while the organization is billing-suspended.
 */
export async function applyAgentUpdate(input: {
  existing: Agent;
  patch: UpdateAgentInput;
  actor: { type: ActorType; id: string };
  requestId: string;
}): Promise<Agent> {
  const { existing, patch, actor, requestId } = input;
  const statusChanged = patch.status !== undefined && patch.status !== existing.status;
  const releasingQuarantine = statusChanged && existing.status === "QUARANTINED";

  if (releasingQuarantine && !patch.reason) throw Errors.badRequest("A reason is required to release a quarantined agent.");
  if (statusChanged && patch.status === "ACTIVE") {
    const org = await prisma.organization.findUnique({ where: { id: existing.organizationId }, select: { billingStatus: true } });
    if (org?.billingStatus === "SUSPENDED") {
      throw Errors.conflict("This organization is suspended for non-payment. Agents restart automatically once the invoice is paid.");
    }
  }

  const updated = await prisma
    .$transaction(async (tx) => {
      if (statusChanged && patch.status) {
        await transitionAgentStatus(tx, {
          agentId: existing.id,
          organizationId: existing.organizationId,
          to: patch.status,
          reason: patch.reason ?? null,
          actor,
          requestId,
          expectFrom: [existing.status],
        });
        if (releasingQuarantine) {
          await tx.securityIncident.updateMany({
            where: { agentId: existing.id, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
            data: {
              status: patch.incidentResolution ?? "RESOLVED",
              resolvedAt: new Date(),
              resolvedById: actor.id,
              resolutionNote: patch.reason ?? null,
            },
          });
        }
      }

      const modeChanged = patch.enforcementMode !== undefined && patch.enforcementMode !== existing.enforcementMode;
      const configChanged =
        patch.displayName !== undefined || patch.maxRequestsPerMinute !== undefined || patch.autoKillOnVelocity !== undefined || modeChanged;
      if (!configChanged) return tx.agent.findUniqueOrThrow({ where: { id: existing.id } });

      const agent = await tx.agent.update({
        where: { id: existing.id },
        data: {
          ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
          ...(patch.maxRequestsPerMinute !== undefined ? { maxRequestsPerMinute: patch.maxRequestsPerMinute } : {}),
          ...(patch.maxRequestsPerMinute === null ? { autoKillOnVelocity: false } : {}),
          ...(patch.autoKillOnVelocity !== undefined && patch.maxRequestsPerMinute !== null ? { autoKillOnVelocity: patch.autoKillOnVelocity } : {}),
          ...(patch.enforcementMode !== undefined ? { enforcementMode: patch.enforcementMode } : {}),
        },
      });
      await recordAudit(
        {
          organizationId: existing.organizationId,
          actorType: actor.type,
          actorId: actor.id,
          action: modeChanged ? `agent.enforcement.${patch.enforcementMode!.toLowerCase()}` : "agent.updated",
          targetType: "agent",
          targetId: agent.id,
          before: toAuditJson({
            enforcementMode: existing.enforcementMode,
            maxRequestsPerMinute: existing.maxRequestsPerMinute,
            autoKillOnVelocity: existing.autoKillOnVelocity,
            displayName: existing.displayName,
          }),
          after: toAuditJson({
            enforcementMode: agent.enforcementMode,
            maxRequestsPerMinute: agent.maxRequestsPerMinute,
            autoKillOnVelocity: agent.autoKillOnVelocity,
            displayName: agent.displayName,
          }),
          requestId,
        },
        tx,
      );
      return agent;
    })
    .catch((err) => {
      if (err instanceof InvalidTransitionError) throw Errors.conflict(err.message, { from: err.from, to: err.to });
      throw err;
    });

  await afterAgentTransition(updated);

  if (statusChanged && patch.status === "KILLED" && updated.status === "KILLED") {
    await emitAlerts([
      {
        organizationId: existing.organizationId,
        agentId: updated.id,
        type: "AGENT_KILLED",
        severity: "CRITICAL",
        dedupeKey: `killed:${updated.id}:manual:${updated.killedAt?.getTime() ?? Date.now()}`,
        message: `${updated.displayName ?? updated.externalId} was stopped manually: ${patch.reason ?? "no reason given"}.`,
      },
    ]);
  }
  return updated;
}
