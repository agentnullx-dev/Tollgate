import type Redis from "ioredis";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  DEFAULT_DETECTOR_CONFIG,
  evaluateSlidingWindows,
  foldProfile,
  type DetectorConfig,
} from "@/lib/anomaly/detector";
import { activeAgentIds, loadSeries, minuteOf } from "@/lib/anomaly/metrics";
import { loadProfiles, rebuildProfile, saveProfile, type StoredProfile } from "@/lib/anomaly/profile-store";
import { recordAnomalyAndQuarantine, recordTokenDrift } from "@/lib/anomaly/quarantine";
import { LeaderLease } from "./lock";
import { workerMetrics } from "./metrics";

const BATCH_SIZE = 200;
const CATCH_UP_MINUTES = 15;

export function detectorConfigFromEnv(): DetectorConfig {
  const e = env();
  return {
    ...DEFAULT_DETECTOR_CONFIG,
    sigma: e.ANOMALY_SIGMA,
    windowMinutes: e.ANOMALY_WINDOW_MINUTES,
    baselineMinutes: e.ANOMALY_BASELINE_MINUTES,
    minHistoryMinutes: e.ANOMALY_MIN_HISTORY_MINUTES,
    minWindowSpendMicros: Math.round(e.ANOMALY_MIN_WINDOW_SPEND_USD * 1_000_000),
  };
}

export interface TickReport {
  evaluated: number;
  anomalous: number;
  quarantined: number;
  insufficientHistory: number;
  durationMs: number;
}

/**
 * Continuous statistical threat detection over live agent consumption.
 *
 * Every tick (default 15 s) the elected leader:
 *   1. lists agents with usage inside the baseline + window horizon,
 *   2. loads their per-minute spend/request/token series from Redis,
 *   3. folds closed minutes into each agent's long-term EWMA profile,
 *   4. evaluates every 5-minute window that ended since the last tick,
 *   5. on a ≥3σ spend spike, records a security incident and quarantines the
 *      agent through the shared kill-switch, so the very next /authorize call
 *      is refused.
 */
export class AnomalyEngine {
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private readonly lease: LeaderLease;

  constructor(
    private readonly client: Redis,
    private readonly config: DetectorConfig = detectorConfigFromEnv(),
    private readonly options: { tickMs: number; autoQuarantine: boolean } = {
      tickMs: env().ANOMALY_TICK_MS,
      autoQuarantine: env().ANOMALY_AUTO_QUARANTINE,
    },
  ) {
    this.lease = new LeaderLease(client, "anomaly-engine", Math.max(30_000, options.tickMs * 3));
  }

  start(): void {
    this.loop = this.run(this.abort.signal);
    logger.info("anomaly.started", { config: this.config, ...this.options });
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
    await this.lease.release().catch(() => undefined);
    workerMetrics.leader.set(0);
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const started = Date.now();
      try {
        const leader = await this.lease.tryAcquire();
        workerMetrics.leader.set(leader ? 1 : 0);
        if (leader) {
          const report = await this.tick();
          if (report.anomalous > 0 || report.evaluated > 0) logger.debug("anomaly.tick", { ...report });
        }
      } catch (err) {
        logger.error("anomaly.tick_failed", { err });
      }
      const wait = Math.max(250, this.options.tickMs - (Date.now() - started));
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
  }

  async tick(nowMs: number = Date.now()): Promise<TickReport> {
    const cfg = this.config;
    const started = performance.now();
    const nowMinute = minuteOf(nowMs);
    const lookback = cfg.baselineMinutes + cfg.windowMinutes + CATCH_UP_MINUTES;
    const ids = await activeAgentIds(this.client, nowMs - (cfg.baselineMinutes + cfg.windowMinutes) * 60_000);
    const report: TickReport = { evaluated: 0, anomalous: 0, quarantined: 0, insufficientHistory: 0, durationMs: 0 };

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      const [agents, seriesByAgent, profiles] = await Promise.all([
        prisma.agent.findMany({
          where: { id: { in: chunk } },
          select: { id: true, organizationId: true, projectId: true, externalId: true, displayName: true, status: true },
        }),
        loadSeries(this.client, chunk, nowMinute - lookback, nowMinute),
        loadProfiles(this.client, chunk),
      ]);

      for (const agent of agents) {
        const series = seriesByAgent.get(agent.id) ?? new Map();
        let stored: StoredProfile | null = profiles.get(agent.id) ?? null;
        if (!stored) stored = await rebuildProfile(agent.id, nowMinute, cfg);

        stored.profile = foldProfile(stored.profile, series, nowMinute - cfg.windowMinutes + 1, cfg);
        const history = nowMinute - stored.firstSeenMinute + 1;
        const verdict = evaluateSlidingWindows(series, stored.lastEvaluatedMinute, nowMinute, stored.profile, history, cfg, CATCH_UP_MINUTES);
        report.evaluated += 1;
        workerMetrics.anomalyEvaluations.inc({ verdict: verdict.status });

        if (verdict.status === "insufficient_history") {
          report.insufficientHistory += 1;
        } else if (verdict.status === "anomalous") {
          report.anomalous += 1;
          // Agents that are already stopped or quarantined don't need a new incident per window.
          if (agent.status === "ACTIVE" || agent.status === "PAUSED") {
            const outcome = await recordAnomalyAndQuarantine({
              agent,
              verdict,
              config: cfg,
              autoQuarantine: this.options.autoQuarantine,
            });
            if (!outcome.duplicate) {
              workerMetrics.anomalyIncidents.inc({ action: outcome.quarantined ? "quarantined" : "alert_only" });
              if (outcome.quarantined) report.quarantined += 1;
            }
          }
        } else if (verdict.tokensPerRequest?.anomalous && agent.status === "ACTIVE") {
          await recordTokenDrift({ agent, verdict });
        }

        stored.lastEvaluatedMinute = nowMinute - 1;
        await saveProfile(this.client, agent.id, stored);
      }
    }

    report.durationMs = Math.round(performance.now() - started);
    workerMetrics.anomalyTickSeconds.observe(report.durationMs / 1000);
    return report;
  }
}
