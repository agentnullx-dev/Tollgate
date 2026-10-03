export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half is
 * random. Keeps retries spread out (no thundering herd after an outage)
 * while guaranteeing a minimum wait that grows with each attempt.
 *
 * `failedAttempts` is the number of attempts that have already failed (>= 1).
 */
export function computeBackoffMs(failedAttempts: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(failedAttempts));
  // Clamp the exponent so 2 ** n cannot overflow to Infinity.
  const exponential = policy.baseMs * 2 ** Math.min(n - 1, 30);
  const capped = Math.min(policy.maxMs, exponential);
  const half = capped / 2;
  return Math.round(half + random() * half);
}

/** Respect a provider's Retry-After when it asks for longer than our own backoff. */
export function nextRetryDelayMs(
  failedAttempts: number,
  policy: BackoffPolicy,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const ours = computeBackoffMs(failedAttempts, policy, random);
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return ours;
  // Never wait more than 24h even if a provider says so.
  return Math.min(Math.max(ours, retryAfterMs), 86_400_000);
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date). */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Full schedule a delivery would follow if every attempt failed (for docs and the UI). */
export function backoffSchedule(maxAttempts: number, policy: BackoffPolicy): Array<{ attempt: number; minMs: number; maxMs: number }> {
  const out: Array<{ attempt: number; minMs: number; maxMs: number }> = [];
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    out.push({
      attempt: attempt + 1,
      minMs: computeBackoffMs(attempt, policy, () => 0),
      maxMs: computeBackoffMs(attempt, policy, () => 1),
    });
  }
  return out;
}
