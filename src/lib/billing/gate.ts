import type { BillingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { redis, keys } from "@/lib/redis";
import { env } from "@/lib/env";

/**
 * Organization-level billing gate read by /authorize on every request.
 * Suspension is enforced here first, so it also covers agents that register
 * for the first time while the account is suspended.
 */
export async function getBillingStatus(organizationId: string): Promise<BillingStatus> {
  const r = redis();
  const key = keys.billingGate(organizationId);
  const cached = await r.get(key);
  if (cached) return cached as BillingStatus;
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { billingStatus: true } });
  const status = org?.billingStatus ?? "ACTIVE";
  await r.set(key, status, "EX", env().CACHE_TTL_SECONDS);
  return status;
}

export async function invalidateBillingStatus(organizationId: string): Promise<void> {
  await redis().del(keys.billingGate(organizationId));
}
