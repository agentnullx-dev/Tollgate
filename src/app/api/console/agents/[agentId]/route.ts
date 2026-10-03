import { json, parseJsonBody } from "@/lib/http";
import { UpdateAgentSchema } from "@/lib/schemas";
import { Errors } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requirePermission, withSessionHandler } from "@/lib/session";
import { applyAgentUpdate, toAgentDTO } from "@/lib/services/agent-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Console agent update. The middleware admits org:developer and above; this
 * handler applies field-level rules against the role read fresh from Postgres:
 *
 *   enforcementMode, displayName ............ agents:toggle-mode (developer)
 *   ACTIVE <-> PAUSED ......................... agents:pause       (developer)
 *   stop (KILLED) or reactivate a stopped one  agents:kill        (admin)
 *   release from QUARANTINED .................. quarantine:release (admin)
 *   maxRequestsPerMinute, autoKillOnVelocity .. agents:limits      (admin)
 */
export const PATCH = withSessionHandler<{ agentId: string }>({ permission: "agents:toggle-mode" }, async ({ req, params, session, requestId }) => {
  const patch = await parseJsonBody(req, UpdateAgentSchema, 8_000);
  const existing = await prisma.agent.findFirst({ where: { id: params.agentId, organizationId: session.organizationId } });
  if (!existing) throw Errors.notFound("Agent", params.agentId);

  if (patch.maxRequestsPerMinute !== undefined || patch.autoKillOnVelocity !== undefined) requirePermission(session, "agents:limits");
  if (patch.status !== undefined && patch.status !== existing.status) {
    if (existing.status === "QUARANTINED") requirePermission(session, "quarantine:release");
    else if (patch.status === "KILLED" || existing.status === "KILLED") requirePermission(session, "agents:kill");
    else requirePermission(session, "agents:pause");
  }

  const updated = await applyAgentUpdate({ existing, patch, actor: { type: "USER", id: session.userId }, requestId });
  return json({ data: toAgentDTO(updated) });
});
