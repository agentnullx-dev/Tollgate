import type { Agent } from "@prisma/client";
import { withApiHandler, json, parseJsonBody } from "@/lib/http";
import { UpdateAgentSchema } from "@/lib/schemas";
import { Errors } from "@/lib/errors";
import { hasScope, type AuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { applyAgentUpdate, toAgentDTO } from "@/lib/services/agent-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { agentId: string };

async function findAgent(auth: AuthContext, agentId: string): Promise<Agent> {
  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      organizationId: auth.organizationId,
      ...(hasScope(auth, "org:admin") ? {} : { projectId: auth.projectId }),
    },
  });
  if (!agent) throw Errors.notFound("Agent", agentId);
  return agent;
}

export const GET = withApiHandler<Params>({ scopes: ["usage:read"] }, async ({ auth, params }) => {
  const agent = await findAgent(auth, params.agentId);
  return json({ data: toAgentDTO(agent) });
});

/**
 * Kill switch, enforcement mode and guardrail configuration. Changes take
 * effect on the very next authorize call. Releasing a QUARANTINED agent
 * requires the org:admin scope and a reason.
 */
export const PATCH = withApiHandler<Params>({ scopes: ["agents:write"] }, async ({ req, auth, params, requestId }) => {
  const patch = await parseJsonBody(req, UpdateAgentSchema, 8_000);
  const existing = await findAgent(auth, params.agentId);
  if (patch.status !== undefined && patch.status !== existing.status && existing.status === "QUARANTINED" && !hasScope(auth, "org:admin")) {
    throw Errors.forbidden("Releasing a quarantined agent requires an API key with the org:admin scope.");
  }
  const updated = await applyAgentUpdate({ existing, patch, actor: { type: "API_KEY", id: auth.apiKeyId }, requestId });
  return json({ data: toAgentDTO(updated) });
});
