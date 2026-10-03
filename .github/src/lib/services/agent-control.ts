import type { ActorType, Agent, AgentStatus, Prisma } from "@prisma/client";
import { recordAudit, toAuditJson } from "@/lib/services/audit";
import { invalidateAgentCache } from "@/lib/services/agents";
import { canTransition } from "@/lib/agent-transitions";

export { canTransition };

/**
 * The one place an agent's run state changes. Every kill-switch path goes
 * through here: the PATCH /agents API, the gateway's velocity auto-stop, and
 * the anomaly engine's quarantine. The authorize endpoint enforces the result
 * on the very next request once the agent cache entry is invalidated.
 * Transition rules live in `@/lib/agent-transitions` (shared with the UI).
 */
export class InvalidTransitionError extends Error {
  constructor(readonly from: AgentStatus, readonly to: AgentStatus) {
    super(`An agent cannot move from ${from} to ${to}.`);
    this.name = "InvalidTransitionError";
  }
}

export interface StatusTransitionInput {
  agentId: string;
  organizationId: string;
  to: AgentStatus;
  reason?: string | null;
  actor: { type: ActorType; id?: string | null };
  requestId?: string;
  /** Only transition when the current status is one of these (compare-and-set). */
  expectFrom?: AgentStatus[];
}

export interface StatusTransitionResult {
  changed: boolean;
  previous: Agent | null;
  agent: Agent | null;
}

/**
 * Transition inside a caller-supplied transaction. The update is guarded on
 * the status we read, so two concurrent transitions cannot both win.
 * Callers must call `afterAgentTransition` once the transaction commits.
 */
export async function transitionAgentStatus(
  tx: Prisma.TransactionClient,
  input: StatusTransitionInput,
): Promise<StatusTransitionResult> {
  const before = await tx.agent.findFirst({ where: { id: input.agentId, organizationId: input.organizationId } });
  if (!before) return { changed: false, previous: null, agent: null };
  if (input.expectFrom && !input.expectFrom.includes(before.status)) return { changed: false, previous: before, agent: before };
  if (before.status === input.to) return { changed: false, previous: before, agent: before };
  if (!canTransition(before.status, input.to)) throw new InvalidTransitionError(before.status, input.to);

  const now = new Date();
  const reason = input.reason?.trim() || null;
  const data: Prisma.AgentUpdateManyMutationInput =
    input.to === "KILLED"
      ? { status: "KILLED", killedAt: now, killReason: reason, quarantinedAt: null }
      : input.to === "QUARANTINED"
        ? { status: "QUARANTINED", quarantinedAt: now, killedAt: now, killReason: reason }
        : { status: input.to, killedAt: null, killReason: null, quarantinedAt: null };

  const updated = await tx.agent.updateMany({ where: { id: before.id, status: before.status }, data });
  if (updated.count === 0) {
    // Lost a race with another transition; report the winner's state.
    const current = await tx.agent.findUnique({ where: { id: before.id } });
    return { changed: false, previous: before, agent: current };
  }

  const after = await tx.agent.findUniqueOrThrow({ where: { id: before.id } });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      action: `agent.status.${input.to.toLowerCase()}`,
      targetType: "agent",
      targetId: before.id,
      before: toAuditJson({ status: before.status, killReason: before.killReason }),
      after: toAuditJson({ status: after.status, reason }),
      requestId: input.requestId,
    },
    tx,
  );
  return { changed: true, previous: before, agent: after };
}

/** Post-commit side effects: make the gateway see the new state immediately. */
export async function afterAgentTransition(agent: Pick<Agent, "projectId" | "externalId"> | null): Promise<void> {
  if (agent) await invalidateAgentCache(agent.projectId, agent.externalId);
}
