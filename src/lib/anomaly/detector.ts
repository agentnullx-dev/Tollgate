/**
 * Statistical spend-anomaly detector.
 *
 * Pure and dependency-free: the worker, unit tests and the dashboard's
 * client-side simulation all execute this exact code.
 *
 * Model
 * -----
 * Each agent produces a dense series of per-minute samples (spend in
 * micro-USD, requests, tokens), zero-filled for idle minutes. For the window
 * ending at minute t (default 5 minutes) we compare the window's mean spend
 * per minute against two baselines:
 *
 *   1. Rolling: the `baselineMinutes` immediately before the window (default
 *      60), never overlapping it, so the spike cannot inflate its own baseline.
 *   2. Long-term: an exponentially weighted mean/variance over every closed
 *      minute the agent has existed (≈1 day half-life), which remembers normal
 *      bursts and prevents false positives when an idle agent starts working.
 *
 * For each baseline:  threshold = μ + kσ_eff, with
 *   σ_eff = max(σ, stdFloorRatio·μ, absoluteStdFloorMicros)
 * The floors stop a near-constant baseline (σ≈0) from flagging trivial
 * changes. The window is anomalous only if its mean exceeds BOTH thresholds
 * (i.e. the more permissive one) and its total spend is above a materiality
 * floor. The reported z-score is measured against the baseline that set the
 * effective threshold.
 *
 * Long-term updates are winsorized at μ + kσ_eff so an attacker cannot
 * "train" the baseline upwards by ramping spend slowly in large steps.
 */

export interface MinuteSample {
  /** Minutes since the Unix epoch. */
  minute: number;
  costMicros: number;
  requests: number;
  tokens: number;
}

export interface DetectorConfig {
  sigma: number;
  windowMinutes: number;
  baselineMinutes: number;
  minHistoryMinutes: number;
  minWindowSpendMicros: number;
  stdFloorRatio: number;
  absoluteStdFloorMicros: number;
  /** Effective sample size of the long-term EWMA, in minutes. */
  longTermSpanMinutes: number;
  /** Minimum requests in the window before tokens-per-request is judged. */
  minWindowRequestsForTokens: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  sigma: 3,
  windowMinutes: 5,
  baselineMinutes: 60,
  minHistoryMinutes: 30,
  minWindowSpendMicros: 1_000_000,
  stdFloorRatio: 0.25,
  absoluteStdFloorMicros: 2_000,
  longTermSpanMinutes: 1440,
  minWindowRequestsForTokens: 5,
};

export const DETECTOR_VERSION = "zscore-dual-baseline/1.2";

export interface Stats {
  n: number;
  mean: number;
  std: number;
}

/** Long-term exponentially weighted profile, persisted between evaluations. */
export interface LongTermProfile {
  /** Number of minutes folded so far. */
  count: number;
  mean: number;
  variance: number;
  /** Tokens-per-request EWMA (only folded from minutes with requests). */
  tprCount: number;
  tprMean: number;
  tprVariance: number;
  /** Last minute folded into the profile. */
  lastMinute: number;
}

export function emptyProfile(startMinute: number): LongTermProfile {
  return { count: 0, mean: 0, variance: 0, tprCount: 0, tprMean: 0, tprVariance: 0, lastMinute: startMinute - 1 };
}

export function computeStats(values: readonly number[]): Stats {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, std: 0 };
  let mean = 0;
  let m2 = 0;
  // Welford's algorithm: numerically stable single pass.
  for (let i = 0; i < n; i++) {
    const x = values[i]!;
    const delta = x - mean;
    mean += delta / (i + 1);
    m2 += delta * (x - mean);
  }
  return { n, mean, std: n > 1 ? Math.sqrt(m2 / (n - 1)) : 0 };
}

export function effectiveStd(stats: Pick<Stats, "mean" | "std">, cfg: Pick<DetectorConfig, "stdFloorRatio" | "absoluteStdFloorMicros">): number {
  return Math.max(stats.std, stats.mean * cfg.stdFloorRatio, cfg.absoluteStdFloorMicros);
}

/**
 * One EWMA step (West, 1979). During warm-up the smoothing factor is raised
 * to 1/(count+1) so the first samples behave like a cumulative average.
 */
export function ewmaStep(count: number, mean: number, variance: number, x: number, span: number): { mean: number; variance: number } {
  const alpha = Math.max(2 / (span + 1), 1 / (count + 1));
  const diff = x - mean;
  const incr = alpha * diff;
  return { mean: mean + incr, variance: (1 - alpha) * (variance + diff * incr) };
}

/**
 * Fold closed minutes (strictly before `uptoMinuteExclusive`) into the
 * long-term profile. Values are winsorized at the current threshold so
 * anomalous minutes cannot drag the baseline upward.
 */
export function foldProfile(
  profile: LongTermProfile,
  series: ReadonlyMap<number, MinuteSample>,
  uptoMinuteExclusive: number,
  cfg: DetectorConfig,
): LongTermProfile {
  const next: LongTermProfile = { ...profile };
  // Bound catch-up work after long gaps: older idle minutes are folded as zeros in one go.
  const firstToFold = Math.max(next.lastMinute + 1, uptoMinuteExclusive - cfg.longTermSpanMinutes * 2);
  if (firstToFold > next.lastMinute + 1 && next.count > 0) {
    const skipped = firstToFold - (next.lastMinute + 1);
    const decay = (1 - 2 / (cfg.longTermSpanMinutes + 1)) ** skipped;
    next.mean *= decay;
    next.variance *= decay;
    next.count += skipped;
  }
  for (let m = firstToFold; m < uptoMinuteExclusive; m++) {
    const s = series.get(m);
    const cost = s?.costMicros ?? 0;
    const cap = next.count >= cfg.minHistoryMinutes ? next.mean + cfg.sigma * effectiveStd({ mean: next.mean, std: Math.sqrt(next.variance) }, cfg) : Infinity;
    const stepped = ewmaStep(next.count, next.mean, next.variance, Math.min(cost, cap), cfg.longTermSpanMinutes);
    next.mean = stepped.mean;
    next.variance = Math.max(0, stepped.variance);
    next.count += 1;

    if (s && s.requests > 0) {
      const tpr = s.tokens / s.requests;
      const t = ewmaStep(next.tprCount, next.tprMean, next.tprVariance, tpr, cfg.longTermSpanMinutes);
      next.tprMean = t.mean;
      next.tprVariance = Math.max(0, t.variance);
      next.tprCount += 1;
    }
  }
  next.lastMinute = Math.max(next.lastMinute, uptoMinuteExclusive - 1);
  return next;
}

export type VerdictStatus = "insufficient_history" | "normal" | "anomalous";

export interface BaselineView {
  source: "rolling" | "long_term";
  mean: number;
  std: number;
  effectiveStd: number;
  threshold: number;
  samples: number;
}

export interface Verdict {
  status: VerdictStatus;
  windowStartMinute: number;
  windowEndMinute: number;
  windowSpendMicros: number;
  windowMeanPerMinute: number;
  windowRequests: number;
  windowTokens: number;
  /** Baseline that set the effective (most permissive) threshold. */
  baseline: BaselineView | null;
  rolling: BaselineView | null;
  longTerm: BaselineView | null;
  thresholdPerMinute: number;
  zScore: number;
  tokensPerRequest: { window: number; mean: number; std: number; zScore: number; anomalous: boolean } | null;
  reasons: string[];
}

function baselineView(source: BaselineView["source"], stats: Stats, cfg: DetectorConfig): BaselineView {
  const eff = effectiveStd(stats, cfg);
  return { source, mean: stats.mean, std: stats.std, effectiveStd: eff, threshold: stats.mean + cfg.sigma * eff, samples: stats.n };
}

/**
 * Evaluate the window ending at `windowEndMinute` (inclusive).
 * `series` maps minute -> sample; missing minutes are idle (zero spend).
 * `historyMinutes` is how long the agent has been observed.
 */
export function evaluateWindow(
  series: ReadonlyMap<number, MinuteSample>,
  windowEndMinute: number,
  profile: LongTermProfile | null,
  historyMinutes: number,
  cfg: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): Verdict {
  const windowStart = windowEndMinute - cfg.windowMinutes + 1;
  let windowSpend = 0;
  let windowRequests = 0;
  let windowTokens = 0;
  for (let m = windowStart; m <= windowEndMinute; m++) {
    const s = series.get(m);
    if (!s) continue;
    windowSpend += s.costMicros;
    windowRequests += s.requests;
    windowTokens += s.tokens;
  }
  const windowMean = windowSpend / cfg.windowMinutes;

  const base: Verdict = {
    status: "normal",
    windowStartMinute: windowStart,
    windowEndMinute,
    windowSpendMicros: windowSpend,
    windowMeanPerMinute: windowMean,
    windowRequests,
    windowTokens,
    baseline: null,
    rolling: null,
    longTerm: null,
    thresholdPerMinute: Infinity,
    zScore: 0,
    tokensPerRequest: null,
    reasons: [],
  };

  if (historyMinutes < cfg.minHistoryMinutes) {
    return { ...base, status: "insufficient_history", reasons: [`Observed for ${historyMinutes} of ${cfg.minHistoryMinutes} required minutes.`] };
  }

  // Rolling baseline: the minutes just before the window, zero-filled, never overlapping it.
  const rollingValues: number[] = [];
  const tprValues: number[] = [];
  const rollingStart = Math.max(windowStart - cfg.baselineMinutes, windowEndMinute - historyMinutes + 1);
  for (let m = rollingStart; m < windowStart; m++) {
    const s = series.get(m);
    rollingValues.push(s?.costMicros ?? 0);
    if (s && s.requests > 0) tprValues.push(s.tokens / s.requests);
  }

  const rolling = rollingValues.length >= Math.min(cfg.baselineMinutes, cfg.minHistoryMinutes) ? baselineView("rolling", computeStats(rollingValues), cfg) : null;
  const longTerm =
    profile && profile.count >= cfg.minHistoryMinutes
      ? baselineView("long_term", { n: profile.count, mean: profile.mean, std: Math.sqrt(profile.variance) }, cfg)
      : null;

  const candidates = [rolling, longTerm].filter((b): b is BaselineView => b !== null);
  if (candidates.length === 0) {
    return { ...base, status: "insufficient_history", rolling, longTerm, reasons: ["Not enough baseline samples yet."] };
  }

  // Most permissive threshold wins: anomalous only if it exceeds every available baseline.
  const governing = candidates.reduce((a, b) => (b.threshold > a.threshold ? b : a));
  const zScore = (windowMean - governing.mean) / governing.effectiveStd;
  const reasons: string[] = [];

  let tokens: Verdict["tokensPerRequest"] = null;
  if (windowRequests >= cfg.minWindowRequestsForTokens) {
    const windowTpr = windowTokens / windowRequests;
    const tprStats =
      profile && profile.tprCount >= cfg.minHistoryMinutes
        ? { n: profile.tprCount, mean: profile.tprMean, std: Math.sqrt(profile.tprVariance) }
        : computeStats(tprValues);
    if (tprStats.n >= 5) {
      const eff = Math.max(tprStats.std, tprStats.mean * cfg.stdFloorRatio, 1);
      const z = (windowTpr - tprStats.mean) / eff;
      tokens = { window: windowTpr, mean: tprStats.mean, std: tprStats.std, zScore: z, anomalous: z > cfg.sigma };
      if (tokens.anomalous) reasons.push(`Tokens per request ${windowTpr.toFixed(0)} vs normal ${tprStats.mean.toFixed(0)} (${z.toFixed(1)}σ).`);
    }
  }

  const spendAnomalous = windowMean > governing.threshold && windowSpend >= cfg.minWindowSpendMicros;
  if (spendAnomalous) {
    reasons.unshift(
      `Spend ${(windowMean / 1e6).toFixed(4)} USD/min over ${cfg.windowMinutes} min exceeds ${(governing.threshold / 1e6).toFixed(4)} USD/min (${governing.source} baseline μ=${(governing.mean / 1e6).toFixed(4)}, σ_eff=${(governing.effectiveStd / 1e6).toFixed(4)}).`,
    );
  } else if (windowMean > governing.threshold) {
    reasons.push(`Rate exceeded the threshold but window spend ${(windowSpend / 1e6).toFixed(4)} USD is below the materiality floor.`);
  }

  return {
    ...base,
    status: spendAnomalous ? "anomalous" : "normal",
    baseline: governing,
    rolling,
    longTerm,
    thresholdPerMinute: governing.threshold,
    zScore,
    tokensPerRequest: tokens,
    reasons,
  };
}

/**
 * Evaluate every window ending in (lastEvaluatedMinute, nowMinute], so no
 * 5-minute window is skipped even if the engine was briefly paused. Returns
 * the first anomalous verdict, or the latest verdict if none fired.
 */
export function evaluateSlidingWindows(
  series: ReadonlyMap<number, MinuteSample>,
  lastEvaluatedMinute: number,
  nowMinute: number,
  profile: LongTermProfile | null,
  historyMinutesAtNow: number,
  cfg: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
  maxCatchUp = 15,
): Verdict {
  const first = Math.max(lastEvaluatedMinute + 1, nowMinute - maxCatchUp + 1);
  let latest: Verdict | null = null;
  for (let end = first; end <= nowMinute; end++) {
    const verdict = evaluateWindow(series, end, profile, historyMinutesAtNow - (nowMinute - end), cfg);
    if (verdict.status === "anomalous") return verdict;
    latest = verdict;
  }
  return latest ?? evaluateWindow(series, nowMinute, profile, historyMinutesAtNow, cfg);
}
