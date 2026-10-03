import { describe, expect, it } from "vitest";
import {
  computeStats,
  DEFAULT_DETECTOR_CONFIG,
  emptyProfile,
  evaluateSlidingWindows,
  evaluateWindow,
  ewmaStep,
  foldProfile,
  type MinuteSample,
} from "@/lib/anomaly/detector";

const cfg = { ...DEFAULT_DETECTOR_CONFIG };

function seriesFrom(values: Array<[minute: number, costMicros: number, requests?: number, tokens?: number]>): Map<number, MinuteSample> {
  const m = new Map<number, MinuteSample>();
  for (const [minute, costMicros, requests = 1, tokens = 1000] of values) m.set(minute, { minute, costMicros, requests, tokens });
  return m;
}

/** Steady agent: ~$0.05/min with deterministic jitter. */
function steady(fromMinute: number, toMinute: number, base = 50_000): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (let m = fromMinute; m <= toMinute; m++) out.push([m, base + ((m * 7919) % 11) * 2_000 - 10_000, 3, 9_000]);
  return out;
}

describe("statistics", () => {
  it("computes sample mean and standard deviation (Welford)", () => {
    const s = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.mean).toBe(5);
    expect(s.std).toBeCloseTo(2.138, 3);
  });

  it("EWMA converges to a constant input", () => {
    let mean = 0;
    let variance = 0;
    for (let i = 0; i < 500; i++) ({ mean, variance } = ewmaStep(i, mean, variance, 10, 60));
    expect(mean).toBeCloseTo(10, 6);
    expect(variance).toBeCloseTo(0, 6);
  });
});

describe("evaluateWindow", () => {
  const now = 10_000;

  it("requires warm-up history before judging", () => {
    const v = evaluateWindow(seriesFrom(steady(now - 10, now)), now, null, 10, cfg);
    expect(v.status).toBe("insufficient_history");
  });

  it("treats steady traffic as normal", () => {
    const series = seriesFrom(steady(now - 200, now));
    const profile = foldProfile(emptyProfile(now - 200), series, now - cfg.windowMinutes + 1, cfg);
    const v = evaluateWindow(series, now, profile, 201, cfg);
    expect(v.status).toBe("normal");
    expect(v.zScore).toBeLessThan(cfg.sigma);
  });

  it("flags a spike more than 3σ above baseline within the 5-minute window", () => {
    const values = steady(now - 200, now - 5);
    for (let m = now - 4; m <= now; m++) values.push([m, 2_500_000, 90, 400_000]);
    const series = seriesFrom(values);
    const profile = foldProfile(emptyProfile(now - 200), series, now - cfg.windowMinutes + 1, cfg);
    const v = evaluateWindow(series, now, profile, 201, cfg);
    expect(v.status).toBe("anomalous");
    expect(v.zScore).toBeGreaterThan(cfg.sigma);
    expect(v.windowSpendMicros).toBe(12_500_000);
    expect(v.reasons[0]).toMatch(/exceeds/);
  });

  it("ignores spikes below the materiality floor", () => {
    const values = steady(now - 200, now - 5, 500);
    for (let m = now - 4; m <= now; m++) values.push([m, 20_000]);
    const series = seriesFrom(values);
    const profile = foldProfile(emptyProfile(now - 200), series, now - cfg.windowMinutes + 1, cfg);
    const v = evaluateWindow(series, now, profile, 201, cfg);
    expect(v.status).toBe("normal");
    expect(v.reasons.join(" ")).toMatch(/materiality/);
  });

  it("does not flag an agent waking up to its usual long-term rate", () => {
    // Busy for a long time, idle for the last hour, then back to normal: rolling baseline is ~0
    // but the long-term profile remembers the normal rate.
    const values = steady(now - 1500, now - 70, 300_000);
    for (let m = now - 4; m <= now; m++) values.push([m, 320_000, 3, 9_000]);
    const series = seriesFrom(values);
    const profile = foldProfile(emptyProfile(now - 1500), series, now - cfg.windowMinutes + 1, cfg);
    const v = evaluateWindow(series, now, profile, 1501, cfg);
    expect(v.status).toBe("normal");
    expect(v.baseline?.source).toBe("long_term");
  });

  it("winsorizes anomalous minutes so a spike cannot poison the long-term baseline", () => {
    const values = steady(now - 300, now - 1);
    for (let m = now - 60; m < now - 50; m++) values.push([m, 50_000_000]);
    const series = seriesFrom(values);
    const profile = foldProfile(emptyProfile(now - 300), series, now, cfg);
    expect(profile.mean).toBeLessThan(1_000_000);
  });

  it("checks every window since the last evaluation", () => {
    const values = steady(now - 200, now);
    // A spike that ended 3 minutes ago is still caught on catch-up.
    for (let m = now - 9; m <= now - 4; m++) values.push([m, 3_000_000]);
    const series = seriesFrom(values);
    const profile = foldProfile(emptyProfile(now - 200), series, now - 15, cfg);
    const v = evaluateSlidingWindows(series, now - 10, now, profile, 201, cfg);
    expect(v.status).toBe("anomalous");
    expect(v.windowEndMinute).toBeLessThan(now);
  });

  it("reports token-per-request drift without treating it as a spend spike", () => {
    const values = steady(now - 200, now - 5);
    for (let m = now - 4; m <= now; m++) values.push([m, 60_000, 3, 200_000]);
    const series = seriesFrom(values);
    const profile = foldProfile(emptyProfile(now - 200), series, now - cfg.windowMinutes + 1, cfg);
    const v = evaluateWindow(series, now, profile, 201, cfg);
    expect(v.status).toBe("normal");
    expect(v.tokensPerRequest?.anomalous).toBe(true);
  });
});
