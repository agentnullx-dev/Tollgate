import type { AgentEnforcementMode, AgentStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { redis, keys } from "@/lib/redis";
import { env } from "@/lib/env";

export interface AgentSnapshot {
  id: string;
  organizationId: string;
  projectId: string;
  externalId: string;
  displayName: string | null;
  status: AgentStatus;
  enforcementMode: AgentEnforcementMode;
  maxRequestsPerMinute: number | null;
  autoKillOnVelocity: boolean;
}

function toSnapshot(row: {
  id: string;
  organizationId: string;
  projectId: string;
  externalId: string;
  displayName: string | null;
  status: AgentStatus;
  enforcementMode: AgentEnforcementMode;
  maxRequestsPerMinute: number | null;
  autoKillOnVelocity: boolean;
}): AgentSnapshot {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    externalId: row.externalId,
    displayName: row.displayName,
    status: row.status,
    enforcementMode: row.enforcementMode,
    maxRequestsPerMinute: row.maxRequestsPerMinute,
    autoKillOnVelocity: row.autoKillOnVelocity,
  };
}

/**
 * Find or auto-register an agent by its external key. Agents appear in the
 * dashboard the first time they call the gateway, so teams don't need a
 * separate provisioning step.
 */
export async function resolveAgent(input: {
  organizationId: string;
  projectId: string;
  externalId: string;
  displayName?: string;
}): Promise<AgentSnapshot> {
  const r = redis();
  const cacheKey = keys.agentCache(input.projectId, input.externalId);
  const cached = await r.get(cacheKey);
  if (cached) return JSON.parse(cached) as AgentSnapshot;

  let row;
  try {
    row = await prisma.agent.upsert({
      where: { projectId_externalId: { projectId: input.projectId, externalId: input.externalId } },
      create: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        externalId: input.externalId,
        displayName: input.displayName ?? null,
      },
      update: {},
    });
  } catch (err) {
    // Two concurrent first-calls can race on the unique index; the loser reads the winner's row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      row = await prisma.agent.findUniqueOrThrow({
        where: { projectId_externalId: { projectId: input.projectId, externalId: input.externalId } },
      });
    } else {
      throw err;
    }
  }

  const snapshot = toSnapshot(row);
  await r.set(cacheKey, JSON.stringify(snapshot), "EX", env().CACHE_TTL_SECONDS);
  return snapshot;
}

export async function invalidateAgentCache(projectId: string, externalId: string): Promise<void> {
  await redis().del(keys.agentCache(projectId, externalId));
}

export interface VelocityResult {
  allowed: boolean;
  count: number;
  limit: number | null;
  minute: number;
}

/** Fixed one-minute window counter used to catch runaway agent loops. */
export async function checkVelocity(agent: AgentSnapshot, now = Date.now()): Promise<VelocityResult> {
  const minute = Math.floor(now / 60_000);
  if (agent.maxRequestsPerMinute === null) {
    return { allowed: true, count: 0, limit: null, minute };
  }
  const key = keys.velocity(agent.id, minute);
  const results = await redis().multi().incr(key).expire(key, 120).exec();
  const count = Number(results?.[0]?.[1] ?? 0);
  return { allowed: count <= agent.maxRequestsPerMinute, count, limit: agent.maxRequestsPerMinute, minute };
}

export async function touchAgents(agentIds: string[], at: Date = new Date()): Promise<void> {
  if (agentIds.length === 0) return;
  await prisma.agent.updateMany({ where: { id: { in: agentIds } }, data: { lastSeenAt: at } });
}
