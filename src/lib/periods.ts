import type { BudgetPeriod } from "@prisma/client";

export interface PeriodWindow {
  /** Stable identifier for the period, used in Redis keys and alert de-duplication. */
  key: string;
  start: Date;
  /** Exclusive end; null for lifetime (TOTAL) budgets. */
  end: Date | null;
  /** Lifetime for Redis counters belonging to this window. */
  ttlSeconds: number;
}

const DAY_MS = 86_400_000;
const GRACE_SECONDS = 2 * 86_400;
const TOTAL_TTL_SECONDS = 400 * 86_400;

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function ttlUntil(end: Date, now: Date): number {
  return Math.max(60, Math.ceil((end.getTime() - now.getTime()) / 1000) + GRACE_SECONDS);
}

/**
 * Resolve the budget window containing `at`. All windows are computed in UTC.
 * Weekly windows start on Monday (ISO-8601).
 */
export function periodWindow(period: BudgetPeriod, at: Date, budgetCreatedAt: Date, now: Date = new Date()): PeriodWindow {
  switch (period) {
    case "DAILY": {
      const start = utcMidnight(at);
      const end = new Date(start.getTime() + DAY_MS);
      return { key: `d:${isoDate(start)}`, start, end, ttlSeconds: ttlUntil(end, now) };
    }
    case "WEEKLY": {
      const midnight = utcMidnight(at);
      const daysSinceMonday = (midnight.getUTCDay() + 6) % 7;
      const start = new Date(midnight.getTime() - daysSinceMonday * DAY_MS);
      const end = new Date(start.getTime() + 7 * DAY_MS);
      return { key: `w:${isoDate(start)}`, start, end, ttlSeconds: ttlUntil(end, now) };
    }
    case "MONTHLY": {
      const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
      const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
      return { key: `m:${start.toISOString().slice(0, 7)}`, start, end, ttlSeconds: ttlUntil(end, now) };
    }
    case "TOTAL":
      return { key: "all", start: budgetCreatedAt, end: null, ttlSeconds: TOTAL_TTL_SECONDS };
    default: {
      const exhaustive: never = period;
      throw new Error(`Unsupported budget period: ${String(exhaustive)}`);
    }
  }
}
