import type { AgentStatus } from "@prisma/client";

/**
 * Agent run-state machine (pure; shared by the server and the dashboard simulation).
 *
 *   ACTIVE      -> PAUSED | KILLED | QUARANTINED
 *   PAUSED      -> ACTIVE | KILLED | QUARANTINED
 *   KILLED      -> ACTIVE
 *   QUARANTINED -> ACTIVE | KILLED     (release requires org:admin and a reason)
 */
export const AGENT_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  ACTIVE: ["PAUSED", "KILLED", "QUARANTINED"],
  PAUSED: ["ACTIVE", "KILLED", "QUARANTINED"],
  KILLED: ["ACTIVE"],
  QUARANTINED: ["ACTIVE", "KILLED"],
};

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}

export function requiresReason(from: AgentStatus, to: AgentStatus): boolean {
  return to === "KILLED" || from === "QUARANTINED";
}
