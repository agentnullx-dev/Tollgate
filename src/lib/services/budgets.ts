import { randomUUID } from "node:crypto";
import type { BudgetEnforcement, BudgetPeriod, BudgetScope, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { redis, keys, sumReservationMembers } from "@/lib/redis";
import { env } from "@/lib/env";
import { periodWindow, type PeriodWindow } from "@/lib/periods";
import { logger } from "@/lib/logger";

export interface BudgetSnapshot {
  id: string;
  organizationId: string;
  scope: BudgetScope;
  projectId: string | null;
  agentId: string | null;
  name: string;
  period: BudgetPeriod;
  limitMicros: bigint;
  enforcement: BudgetEnforcement;
  alertThresholds: number[];
  createdAt: Date;
}

interface SerializedBudget extends Omit<BudgetSnapshot, "limitMicros" | "createdAt"> {
  limitMicros: string;
  createdAt: string;
}

export interface BudgetWindow {
  budget: BudgetSnapshot;
  window: PeriodWindow;
}

// ---------------------------------------------------------------------------
// Loading & caching
// ---------------------------------------------------------------------------

function serialize(b: BudgetSnapshot): SerializedBudget {
  return { ...b, limitMicros: b.limitMicros.toString(), createdAt: b.createdAt.toISOString() };
}

function deserialize(b: SerializedBudget): BudgetSnapshot {
  return { ...b, limitMicros: BigInt(b.limitMicros), createdAt: new Date(b.createdAt) };
}

export async function loadActiveBudgets(organizationId: string): Promise<BudgetSnapshot[]> {
  const r = redis();
  const cacheKey = keys.budgetCache(organizationId);
  const cached = await r.get(cacheKey);
  if (cached) return (JSON.parse(cached) as SerializedBudget[]).map(deserialize);

  const rows = await prisma.budget.findMany({ where: { organizationId, isActive: true } });
  const snapshots: BudgetSnapshot[] = rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    scope: row.scope,
    projectId: row.projectId,
    agentId: row.agentId,
    name: row.name,
    period: row.period,
    limitMicros: row.limitMicros,
    enforcement: row.enforcement,
    alertThresholds: row.alertThresholds,
    createdAt: row.createdAt,
  }));
  await r.set(cacheKey, JSON.stringify(snapshots.map(serialize)), "EX", env().CACHE_TTL_SECONDS);
  return snapshots;
}

export async function invalidateBudgetCache(organizationId: string): Promise<void> {
  await redis().del(keys.budgetCache(organizationId));
}

/** Budgets that govern a request from `agentId` inside `projectId`. */
export function applicableBudgets(budgets: BudgetSnapshot[], projectId: string, agentId: string): BudgetSnapshot[] {
  return budgets.filter((b) => {
    switch (b.scope) {
      case "ORGANIZATION":
        return true;
      case "PROJECT":
        return b.projectId === projectId;
      case "AGENT":
        return b.agentId === agentId;
      default:
        return false;
    }
  });
}

export function windowsFor(budgets: BudgetSnapshot[], at: Date, now: Date = new Date()): BudgetWindow[] {
  return budgets.map((budget) => ({ budget, window: periodWindow(budget.period, at, budget.createdAt, now) }));
}

// ---------------------------------------------------------------------------
// Counter self-healing (Postgres is the source of truth, Redis is the hot path)
// ---------------------------------------------------------------------------

function scopeWhere(budget: BudgetSnapshot): Prisma.UsageEventWhereInput {
  switch (budget.scope) {
    case "ORGANIZATION":
      return { organizationId: budget.organizationId };
    case "PROJECT":
      return { organizationId: budget.organizationId, projectId: budget.projectId ?? "__none__" };
    case "AGENT":
      return { organizationId: budget.organizationId, agentId: budget.agentId ?? "__none__" };
    default:
      return { id: "__none__" };
  }
}

export async function sumSpendFromDb(budget: BudgetSnapshot, window: PeriodWindow): Promise<bigint> {
  const result = await prisma.usageEvent.aggregate({
    _sum: { costMicros: true },
    where: {
      ...scopeWhere(budget),
      occurredAt: { gte: window.start, ...(window.end ? { lt: window.end } : {}) },
    },
  });
  return result._sum.costMicros ?? 0n;
}

/**
 * Ensure each committed counter exists. Missing counters (eviction, Redis
 * restart, new period) are rebuilt from the ledger with SET NX, so concurrent
 * rebuilders cannot double count.
 */
export async function ensureCommittedCounters(windows: BudgetWindow[]): Promise<void> {
  if (windows.length === 0) return;
  const r = redis();
  const pipeline = r.pipeline();
  for (const { budget, window } of windows) pipeline.exists(keys.committed(budget.id, window.key));
  const results = (await pipeline.exec()) ?? [];

  const missing = windows.filter((_, i) => Number(results[i]?.[1] ?? 0) === 0);
  if (missing.length === 0) return;

  await Promise.all(
    missing.map(async ({ budget, window }) => {
      const total = await sumSpendFromDb(budget, window);
      await r.set(keys.committed(budget.id, window.key), total.toString(), "EX", window.ttlSeconds, "NX");
      logger.info("budget.counter_rebuilt", { budgetId: budget.id, periodKey: window.key, micros: total });
    }),
  );
}

export interface ReconcileResult {
  periodKey: string;
  previousMicros: bigint | null;
  reconciledMicros: bigint;
  driftMicros: bigint;
}

/** Force the current-period counter to match Postgres exactly. */
export async function reconcileBudget(budget: BudgetSnapshot, now: Date = new Date()): Promise<ReconcileResult> {
  const window = periodWindow(budget.period, now, budget.createdAt, now);
  const key = keys.committed(budget.id, window.key);
  const r = redis();
  const previousRaw = await r.get(key);
  const reconciled = await sumSpendFromDb(budget, window);
  await r.set(key, reconciled.toString(), "EX", window.ttlSeconds);
  const previous = previousRaw === null ? null : BigInt(previousRaw);
  return {
    periodKey: window.key,
    previousMicros: previous,
    reconciledMicros: reconciled,
    driftMicros: previous === null ? reconciled : reconciled - previous,
  };
}

// ---------------------------------------------------------------------------
// Reservation (pre-flight) and settlement (post-flight)
// ---------------------------------------------------------------------------

export interface ReservationRecord {
  reservationId: string;
  estimateMicros: string;
  projectId: string;
  agentId: string;
  refs: Array<{ budgetId: string; periodKey: string }>;
  createdAt: string;
}

export interface BudgetViolation {
  window: BudgetWindow;
  committedMicros: bigint;
  reservedMicros: bigint;
}

export type ReserveResult =
  | { allowed: true; reservationId: string; expiresAt: Date; softViolation: BudgetViolation | null }
  | {
      allowed: false;
      blocking: BudgetWindow;
      committedMicros: bigint;
      reservedMicros: bigint;
    };

export async function reserveSpend(input: {
  windows: BudgetWindow[];
  estimateMicros: bigint;
  projectId: string;
  agentId: string;
  /** False for alert-only agents: budgets are evaluated but never block. */
  enforce?: boolean;
  now?: Date;
}): Promise<ReserveResult> {
  const enforce = input.enforce ?? true;
  const now = input.now ?? new Date();
  const ttl = env().RESERVATION_TTL_SECONDS;
  const reservationId = `res_${randomUUID().replace(/-/g, "")}`;
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const n = input.windows.length;

  await ensureCommittedCounters(input.windows);

  const record: ReservationRecord = {
    reservationId,
    estimateMicros: input.estimateMicros.toString(),
    projectId: input.projectId,
    agentId: input.agentId,
    refs: input.windows.map(({ budget, window }) => ({ budgetId: budget.id, periodKey: window.key })),
    createdAt: now.toISOString(),
  };

  const redisKeys: string[] = [
    ...input.windows.map(({ budget, window }) => keys.committed(budget.id, window.key)),
    ...input.windows.map(({ budget, window }) => keys.reserved(budget.id, window.key)),
    keys.reservation(reservationId),
  ];
  const args: (string | number)[] = [
    n,
    input.estimateMicros.toString(),
    now.getTime(),
    expiresAt.getTime(),
    reservationId,
    ttl,
    JSON.stringify(record),
    ...input.windows.map(({ budget }) => budget.limitMicros.toString()),
    ...input.windows.map(({ budget }) => (enforce && budget.enforcement === "BLOCK" ? "1" : "0")),
    ...input.windows.map(({ window }) => window.ttlSeconds),
  ];

  const [allowed, blockingIndex, committed, reserved] = await redis().tgAuthorize(redisKeys.length, ...redisKeys, ...args);

  if (allowed === 1) {
    const softWindow = blockingIndex ? input.windows[blockingIndex - 1] : undefined;
    return {
      allowed: true,
      reservationId,
      expiresAt,
      softViolation: softWindow
        ? { window: softWindow, committedMicros: BigInt(committed ?? 0), reservedMicros: BigInt(reserved ?? 0) }
        : null,
    };
  }
  const blocking = input.windows[(blockingIndex ?? 1) - 1];
  if (!blocking) throw new Error("Authorize script returned an out-of-range budget index.");
  return {
    allowed: false,
    blocking,
    committedMicros: BigInt(committed ?? 0),
    reservedMicros: BigInt(reserved ?? 0),
  };
}

export async function loadReservation(reservationId: string): Promise<ReservationRecord | null> {
  const raw = await redis().get(keys.reservation(reservationId));
  return raw ? (JSON.parse(raw) as ReservationRecord) : null;
}

export interface SettleOutcome {
  window: BudgetWindow;
  beforeMicros: bigint;
  afterMicros: bigint;
}

/**
 * Commit actual spend to every applicable counter and release the original
 * reservation (if any) in one atomic step.
 */
export async function settleSpend(input: {
  windows: BudgetWindow[];
  costMicros: bigint;
  reservation: ReservationRecord | null;
}): Promise<SettleOutcome[]> {
  const { windows, costMicros, reservation } = input;
  if (windows.length === 0 && !reservation) return [];

  const member = reservation ? `${reservation.reservationId}:${reservation.estimateMicros}` : "";
  const releaseKeys = reservation ? reservation.refs.map((ref) => keys.reserved(ref.budgetId, ref.periodKey)) : [];

  const redisKeys = [
    reservation ? keys.reservation(reservation.reservationId) : "tg:res:none",
    ...windows.map(({ budget, window }) => keys.committed(budget.id, window.key)),
    ...releaseKeys,
  ];
  const args: (string | number)[] = [
    windows.length,
    releaseKeys.length,
    costMicros.toString(),
    member,
    ...windows.map(({ window }) => window.ttlSeconds),
  ];

  const after = await redis().tgSettle(redisKeys.length, ...redisKeys, ...args);
  return windows.map((window, i) => {
    const afterMicros = BigInt(after[i] ?? 0);
    return { window, afterMicros, beforeMicros: afterMicros - costMicros };
  });
}

// ---------------------------------------------------------------------------
// Live utilization (dashboard / budgets API)
// ---------------------------------------------------------------------------

export interface LiveUtilization {
  periodKey: string;
  periodStart: Date;
  periodEnd: Date | null;
  committedMicros: bigint;
  reservedMicros: bigint;
}

export async function liveUtilization(
  budgets: BudgetSnapshot[],
  now: Date = new Date(),
): Promise<Map<string, LiveUtilization>> {
  const windows = windowsFor(budgets, now, now);
  await ensureCommittedCounters(windows);

  const pipeline = redis().pipeline();
  for (const { budget, window } of windows) {
    pipeline.get(keys.committed(budget.id, window.key));
    pipeline.zrangebyscore(keys.reserved(budget.id, window.key), now.getTime(), "+inf");
  }
  const results = (await pipeline.exec()) ?? [];

  const out = new Map<string, LiveUtilization>();
  windows.forEach(({ budget, window }, i) => {
    const committedRaw = results[i * 2]?.[1] as string | null | undefined;
    const reservedMembers = (results[i * 2 + 1]?.[1] as string[] | undefined) ?? [];
    out.set(budget.id, {
      periodKey: window.key,
      periodStart: window.start,
      periodEnd: window.end,
      committedMicros: committedRaw ? BigInt(committedRaw) : 0n,
      reservedMicros: sumReservationMembers(reservedMembers),
    });
  });
  return out;
}
