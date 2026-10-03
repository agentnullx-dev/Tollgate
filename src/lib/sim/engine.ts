import type {
  Agent,
  AgentEnforcementMode,
  AgentStatus,
  Alert,
  AlertSeverity,
  AlertType,
  Budget,
  BudgetEnforcement,
  LedgerEntry,
  ModelPrice,
  NotificationChannel,
  NotificationDelivery,
  Organization,
  Prisma,
  Project,
  SecurityIncident,
  UsageEvent,
} from "@prisma/client";
import { computeCostMicros } from "@/lib/money";
import { periodWindow } from "@/lib/periods";
import { canTransition, requiresReason } from "@/lib/agent-transitions";
import { nextRetryDelayMs } from "@/lib/notifications/backoff";
import {
  DEFAULT_DETECTOR_CONFIG,
  DETECTOR_VERSION,
  emptyProfile,
  evaluateWindow,
  foldProfile,
  type DetectorConfig,
  type LongTermProfile,
  type MinuteSample,
  type Verdict,
} from "@/lib/anomaly/detector";

/**
 * Client-side simulation of a live Tollgate tenant.
 *
 * Every entity is a full Prisma model row (types imported from the generated
 * client), so the dashboard cannot drift from the database schema. Business
 * rules are not re-implemented: pricing, budget windows, the agent state
 * machine, notification backoff and the anomaly detector are the same modules
 * the server runs.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SimSpeed = 1 | 10 | 60;
export type ChannelHealth = "healthy" | "degraded" | "down";
export type TrendInterval = "24h" | "7d" | "30d";

export interface GateDecision {
  id: string;
  at: Date;
  agentId: string;
  model: string;
  estimateMicros: bigint;
  costMicros: bigint | null;
  decision: "ALLOW" | "DENY";
  reason: string | null;
  overLimit: boolean;
}

export interface BudgetCounter {
  periodKey: string;
  periodStart: Date;
  periodEnd: Date | null;
  committedMicros: bigint;
  reservedMicros: bigint;
}

export interface TrendPoint {
  t: number;
  costUsd: number;
  costMicros: number;
  requests: number;
  blocked: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface AgentLiveStats {
  spendPerMinuteUsd: number;
  spendInIntervalUsd: number;
  requestsInInterval: number;
  blockedInInterval: number;
  tokensPerRequest: number;
  sparkline: number[];
  verdict: Verdict | null;
}

export interface AgentPatch {
  status?: AgentStatus;
  enforcementMode?: AgentEnforcementMode;
  maxRequestsPerMinute?: number | null;
  autoKillOnVelocity?: boolean;
  reason?: string;
  incidentResolution?: "RESOLVED" | "FALSE_POSITIVE";
}

export interface BudgetPatch {
  enforcement?: BudgetEnforcement;
  isActive?: boolean;
  limitMicros?: bigint;
}

interface Behavior {
  agentId: string;
  provider: string;
  model: string;
  ratePerMinute: number;
  inputTokens: number;
  outputTokens: number;
  cacheRatio: number;
  diurnal: number;
  runaway: { untilMs: number; rateMultiplier: number; tokenMultiplier: number } | null;
}

const FIELDS = ["cost", "requests", "blocked", "input", "cached", "output"] as const;
type Field = (typeof FIELDS)[number];

/** Dense time series with an absolute start index (minutes or hours since epoch). */
class Series {
  start: number;
  readonly data: Record<Field, number[]>;

  constructor(start: number) {
    this.start = start;
    this.data = { cost: [], requests: [], blocked: [], input: [], cached: [], output: [] };
  }

  private index(slot: number): number {
    if (slot < this.start) return -1;
    let i = slot - this.start;
    while (this.data.cost.length <= i) for (const f of FIELDS) this.data[f].push(0);
    return i;
  }

  add(slot: number, field: Field, value: number): void {
    const i = this.index(slot);
    if (i >= 0) this.data[field][i]! += value;
  }

  get(slot: number, field: Field): number {
    const i = slot - this.start;
    return i >= 0 && i < this.data[field].length ? this.data[field][i]! : 0;
  }

  sum(from: number, toInclusive: number, field: Field): number {
    let s = 0;
    for (let k = from; k <= toInclusive; k++) s += this.get(k, field);
    return s;
  }

  trim(keepFrom: number): void {
    const drop = keepFrom - this.start;
    if (drop <= 0) return;
    for (const f of FIELDS) this.data[f].splice(0, drop);
    this.start = keepFrom;
  }
}

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  uniform(): number {
    return this.next();
  }
  normal(): number {
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()));
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > l);
    return k - 1;
  }
  /** Multiplicative noise with median 1. */
  logNoise(sigma: number): number {
    return Math.exp(sigma * this.normal());
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
}

let idCounter = 0;
/** cuid-shaped identifier ("c" + time + counter + random). */
function cuid(rng: Rng): string {
  idCounter = (idCounter + 1) % 1_679_616;
  return `c${Date.now().toString(36)}${idCounter.toString(36).padStart(4, "0")}${Math.floor(rng.uniform() * 2 ** 32).toString(36).padStart(7, "0")}`.slice(0, 25);
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const minuteOf = (ms: number) => Math.floor(ms / MINUTE);
const hourOf = (ms: number) => Math.floor(ms / HOUR);
const MINUTE_RETENTION = 26 * 60;
const HOUR_RETENTION = 31 * 24;

// ---------------------------------------------------------------------------
// Static tenant definition
// ---------------------------------------------------------------------------

const PRICE_TABLE: Array<[string, string, number, number, number]> = [
  ["anthropic", "claude-opus-4-1", 15, 75, 1.5],
  ["anthropic", "claude-sonnet-4-5", 3, 15, 0.3],
  ["anthropic", "claude-haiku-4-5", 1, 5, 0.1],
  ["openai", "gpt-4.1", 2, 8, 0.5],
  ["openai", "gpt-4.1-mini", 0.4, 1.6, 0.1],
  ["google", "gemini-2.5-pro", 1.25, 10, 0.31],
];

interface AgentSpec {
  externalId: string;
  displayName: string;
  project: "prod" | "internal";
  provider: string;
  model: string;
  ratePerMinute: number;
  inputTokens: number;
  outputTokens: number;
  cacheRatio: number;
  enforcementMode: AgentEnforcementMode;
  maxRequestsPerMinute: number | null;
  autoKillOnVelocity: boolean;
  /** Minutes before "now" at which a historical runaway starts (detector will find it). */
  historicalSpikeAt?: number;
}

const AGENT_SPECS: AgentSpec[] = [
  { externalId: "support-triage", displayName: "Support triage", project: "prod", provider: "anthropic", model: "claude-haiku-4-5", ratePerMinute: 6, inputTokens: 6000, outputTokens: 600, cacheRatio: 0.4, enforcementMode: "STRICT", maxRequestsPerMinute: 240, autoKillOnVelocity: true },
  { externalId: "contract-reviewer", displayName: "Contract reviewer", project: "prod", provider: "anthropic", model: "claude-sonnet-4-5", ratePerMinute: 1.2, inputTokens: 25000, outputTokens: 2000, cacheRatio: 0.3, enforcementMode: "STRICT", maxRequestsPerMinute: 30, autoKillOnVelocity: false },
  { externalId: "code-migrator", displayName: "Code migrator", project: "prod", provider: "anthropic", model: "claude-opus-4-1", ratePerMinute: 0.5, inputTokens: 20000, outputTokens: 3000, cacheRatio: 0.5, enforcementMode: "STRICT", maxRequestsPerMinute: 60, autoKillOnVelocity: true },
  { externalId: "billing-reconciler", displayName: "Billing reconciler", project: "prod", provider: "anthropic", model: "claude-sonnet-4-5", ratePerMinute: 2, inputTokens: 12000, outputTokens: 1000, cacheRatio: 0.2, enforcementMode: "ALERT_ONLY", maxRequestsPerMinute: 60, autoKillOnVelocity: false },
  { externalId: "lead-enricher", displayName: "Lead enricher", project: "prod", provider: "openai", model: "gpt-4.1-mini", ratePerMinute: 9, inputTokens: 4000, outputTokens: 400, cacheRatio: 0.1, enforcementMode: "STRICT", maxRequestsPerMinute: 400, autoKillOnVelocity: false },
  { externalId: "web-researcher", displayName: "Web researcher", project: "internal", provider: "openai", model: "gpt-4.1", ratePerMinute: 3, inputTokens: 8000, outputTokens: 800, cacheRatio: 0.15, enforcementMode: "STRICT", maxRequestsPerMinute: 120, autoKillOnVelocity: false, historicalSpikeAt: 128 },
  { externalId: "research-summarizer", displayName: "Research summarizer", project: "internal", provider: "google", model: "gemini-2.5-pro", ratePerMinute: 0.8, inputTokens: 40000, outputTokens: 1500, cacheRatio: 0.25, enforcementMode: "STRICT", maxRequestsPerMinute: 20, autoKillOnVelocity: false },
];

interface BudgetSpec {
  name: string;
  scope: Budget["scope"];
  project?: "prod" | "internal";
  agent?: string;
  period: Budget["period"];
  enforcement: BudgetEnforcement;
  /** Target utilization at simulation start; the limit is derived from real history. */
  target: number;
  thresholds: number[];
}

const BUDGET_SPECS: BudgetSpec[] = [
  { name: "Company monthly cap", scope: "ORGANIZATION", period: "MONTHLY", enforcement: "BLOCK", target: 0.64, thresholds: [50, 80, 90, 100] },
  { name: "Production daily cap", scope: "PROJECT", project: "prod", period: "DAILY", enforcement: "BLOCK", target: 0.58, thresholds: [50, 80, 90, 100] },
  { name: "Code migrator daily", scope: "AGENT", agent: "code-migrator", period: "DAILY", enforcement: "BLOCK", target: 0.87, thresholds: [80, 90, 100] },
  { name: "Billing reconciler daily", scope: "AGENT", agent: "billing-reconciler", period: "DAILY", enforcement: "BLOCK", target: 0.985, thresholds: [80, 90, 100] },
  { name: "Lead enricher weekly", scope: "AGENT", agent: "lead-enricher", period: "WEEKLY", enforcement: "ALERT_ONLY", target: 1.04, thresholds: [80, 90, 100] },
  { name: "Research pilot", scope: "PROJECT", project: "internal", period: "MONTHLY", enforcement: "BLOCK", target: 0.41, thresholds: [50, 80, 90, 100] },
];

const DETECTOR: DetectorConfig = { ...DEFAULT_DETECTOR_CONFIG };
const BACKOFF = { baseMs: 2_000, maxMs: 30 * 60_000 };
const MAX_ATTEMPTS = 10;
const CHANNEL_SUCCESS: Record<ChannelHealth, number> = { healthy: 0.98, degraded: 0.3, down: 0 };

function diurnalFactor(ms: number, amplitude: number): number {
  const d = new Date(ms);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  // Peak around 15:00 UTC, trough around 03:00 UTC.
  const daily = 1 + amplitude * Math.cos(((hour - 15) / 24) * 2 * Math.PI);
  const weekday = d.getUTCDay();
  return daily * (weekday === 0 || weekday === 6 ? 0.55 : 1);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SimulationEngine {
  readonly organization: Organization;
  readonly projects: Project[];
  readonly modelPrices: ModelPrice[];
  agents: Agent[] = [];
  budgets: Budget[] = [];
  channels: NotificationChannel[] = [];
  alerts: Alert[] = [];
  deliveries: NotificationDelivery[] = [];
  incidents: SecurityIncident[] = [];
  ledger: LedgerEntry[] = [];
  usageEvents: UsageEvent[] = [];
  decisions: GateDecision[] = [];
  counters = new Map<string, BudgetCounter>();
  channelHealth = new Map<string, ChannelHealth>();

  now: number;
  speed: SimSpeed = 10;
  running = true;
  apiFailureRate = 0;

  private readonly rng: Rng;
  private readonly behaviors = new Map<string, Behavior>();
  private readonly minutes = new Map<string, Series>();
  private readonly hours = new Map<string, Series>();
  private readonly profiles = new Map<string, LongTermProfile>();
  private readonly firstSeenMinute = new Map<string, number>();
  private readonly verdicts = new Map<string, Verdict>();
  private readonly velocity = new Map<string, { minute: number; count: number }>();
  private lastEvaluatedMinute: number;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRealTick = 0;

  constructor(seed = 20261003, startMs: number = Date.now()) {
    this.rng = new Rng(seed);
    this.now = startMs;
    const created = new Date(startMs - 120 * 86_400_000);

    this.organization = {
      id: "org_acme",
      name: "Acme Robotics",
      slug: "acme",
      plan: "BUSINESS",
      billingStatus: "ACTIVE",
      stripeCustomerId: "cus_sim_acme",
      stripeSubscriptionId: "sub_sim_acme",
      stripePriceId: "price_sim_business_monthly",
      currentPeriodEnd: new Date(startMs + 18 * 86_400_000),
      billingSyncedAt: new Date(startMs - 12 * 86_400_000),
      createdAt: created,
      updatedAt: created,
    };
    this.projects = [
      { id: "prj_prod", organizationId: this.organization.id, name: "Production agents", slug: "production-agents", environment: "production", archivedAt: null, createdAt: created, updatedAt: created },
      { id: "prj_internal", organizationId: this.organization.id, name: "Internal tools", slug: "internal-tools", environment: "production", archivedAt: null, createdAt: created, updatedAt: created },
    ];
    this.modelPrices = PRICE_TABLE.map(([provider, model, i, o, c]) => ({
      id: `mp_${provider}_${model}`,
      provider,
      model,
      inputMicrosPerMTok: BigInt(Math.round(i * 1e6)),
      outputMicrosPerMTok: BigInt(Math.round(o * 1e6)),
      cachedInputMicrosPerMTok: BigInt(Math.round(c * 1e6)),
      effectiveFrom: new Date("2025-01-01T00:00:00Z"),
      createdAt: created,
    }));

    this.buildAgents(created);
    this.buildChannels(created);
    this.lastEvaluatedMinute = minuteOf(startMs) - MINUTE_RETENTION;
    this.generateHourlyHistory();
    this.generateMinuteHistory();
    this.buildBudgets(created);
  }

  // ---- subscription (useSyncExternalStore) ---------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  start(): void {
    if (this.timer) return;
    this.lastRealTick = performance.now();
    this.timer = setInterval(() => this.tick(), 500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.lastRealTick = performance.now();
    this.emit();
  }

  setSpeed(speed: SimSpeed): void {
    this.speed = speed;
    this.emit();
  }

  setApiFailureRate(rate: number): void {
    this.apiFailureRate = Math.max(0, Math.min(1, rate));
    this.emit();
  }

  setChannelHealth(channelId: string, health: ChannelHealth): void {
    this.channelHealth.set(channelId, health);
    this.emit();
  }

  // ---- construction --------------------------------------------------------

  private buildAgents(created: Date): void {
    for (const spec of AGENT_SPECS) {
      const id = `agt_${spec.externalId.replace(/-/g, "_")}`;
      const agent: Agent = {
        id,
        organizationId: this.organization.id,
        projectId: spec.project === "prod" ? "prj_prod" : "prj_internal",
        externalId: spec.externalId,
        displayName: spec.displayName,
        status: "ACTIVE",
        enforcementMode: spec.enforcementMode,
        quarantinedAt: null,
        maxRequestsPerMinute: spec.maxRequestsPerMinute,
        autoKillOnVelocity: spec.autoKillOnVelocity,
        killedAt: null,
        killReason: null,
        lastSeenAt: null,
        createdAt: created,
        updatedAt: created,
      };
      this.agents.push(agent);
      this.behaviors.set(id, {
        agentId: id,
        provider: spec.provider,
        model: spec.model,
        ratePerMinute: spec.ratePerMinute,
        inputTokens: spec.inputTokens,
        outputTokens: spec.outputTokens,
        cacheRatio: spec.cacheRatio,
        diurnal: 0.45,
        runaway: null,
      });
      this.minutes.set(id, new Series(minuteOf(this.now) - MINUTE_RETENTION));
      this.hours.set(id, new Series(hourOf(this.now) - HOUR_RETENTION));
      this.firstSeenMinute.set(id, minuteOf(created.getTime()));
    }
  }

  private buildChannels(created: Date): void {
    const make = (type: NotificationChannel["type"], name: string, hint: string, minSeverity: AlertSeverity, health: ChannelHealth): NotificationChannel => {
      const channel: NotificationChannel = {
        id: `nch_${type.toLowerCase()}`,
        organizationId: this.organization.id,
        type,
        name,
        targetCiphertext: "v1.simulated.simulated.simulated",
        targetHint: hint,
        secretCiphertext: null,
        minSeverity,
        alertTypes: [],
        isEnabled: true,
        createdAt: created,
        updatedAt: created,
      };
      this.channelHealth.set(channel.id, health);
      return channel;
    };
    this.channels = [
      make("SLACK", "#ai-spend-alerts", "hooks.slack.com/…/Xb4Q", "WARNING", "healthy"),
      make("TEAMS", "FinOps channel", "acme.webhook.office.com/…/7f2a", "WARNING", "degraded"),
      make("EMAIL", "On-call email", "2 recipients", "CRITICAL", "healthy"),
    ];
  }

  private priceFor(b: Behavior): ModelPrice {
    return this.modelPrices.find((p) => p.provider === b.provider && p.model === b.model)!;
  }

  /** Expected requests per minute for an agent at a given time (before noise). */
  private rateAt(b: Behavior, ms: number): number {
    const runaway = b.runaway && ms < b.runaway.untilMs ? b.runaway.rateMultiplier : 1;
    return b.ratePerMinute * diurnalFactor(ms, b.diurnal) * runaway;
  }

  /** Hourly history for 31 days, excluding the last 26 hours (generated per minute). */
  private generateHourlyHistory(): void {
    const nowHour = hourOf(this.now);
    const minuteHorizonHour = hourOf(this.now - MINUTE_RETENTION * MINUTE);
    for (const agent of this.agents) {
      const b = this.behaviors.get(agent.id)!;
      const price = this.priceFor(b);
      const hours = this.hours.get(agent.id)!;
      for (let h = nowHour - HOUR_RETENTION + 1; h < minuteHorizonHour; h++) {
        const ms = h * HOUR + HOUR / 2;
        const growth = 1 - (nowHour - h) * 0.0004;
        const requests = this.rng.poisson(this.rateAt(b, ms) * 60 * growth);
        if (requests === 0) {
          hours.add(h, "requests", 0);
          continue;
        }
        const totalIn = Math.round(requests * b.inputTokens * this.rng.logNoise(0.12));
        const cached = Math.round(totalIn * b.cacheRatio);
        const input = totalIn - cached;
        const output = Math.round(requests * b.outputTokens * this.rng.logNoise(0.15));
        const cost = Number(computeCostMicros(price, { inputTokens: input, outputTokens: output, cachedInputTokens: cached }));
        hours.add(h, "requests", requests);
        hours.add(h, "input", input);
        hours.add(h, "cached", cached);
        hours.add(h, "output", output);
        hours.add(h, "cost", cost);
      }
    }
  }

  /**
   * The last 26 hours, minute by minute, with the anomaly detector running
   * exactly as the worker would. A scripted historical runaway is caught by
   * the real detector and produces a real incident.
   */
  private generateMinuteHistory(): void {
    const nowMinute = minuteOf(this.now);
    const startMinute = nowMinute - MINUTE_RETENTION + 1;
    const spikes = new Map<string, number>();
    for (const spec of AGENT_SPECS) {
      if (spec.historicalSpikeAt) spikes.set(`agt_${spec.externalId.replace(/-/g, "_")}`, nowMinute - spec.historicalSpikeAt);
    }
    for (const agent of this.agents) this.profiles.set(agent.id, emptyProfile(startMinute));

    for (let m = startMinute; m <= nowMinute; m++) {
      const ms = m * MINUTE + (m === nowMinute ? this.now % MINUTE : MINUTE / 2);
      for (const agent of this.agents) {
        const b = this.behaviors.get(agent.id)!;
        const spikeStart = spikes.get(agent.id);
        if (spikeStart !== undefined && m === spikeStart) {
          b.runaway = { untilMs: (spikeStart + 12) * MINUTE, rateMultiplier: 28, tokenMultiplier: 2.4 };
        }
        const fraction = m === nowMinute ? (this.now % MINUTE) / MINUTE : 1;
        const requests = this.rng.poisson(this.rateAt(b, ms) * fraction);
        for (let r = 0; r < requests; r++) this.simulateRequest(agent, new Date(m * MINUTE + Math.floor(this.rng.uniform() * MINUTE * fraction)), false);
      }
      if (m < nowMinute) this.evaluateClosedMinute(m + 1, false);
    }
    for (const b of this.behaviors.values()) b.runaway = null;
    this.lastEvaluatedMinute = nowMinute - 1;
  }

  private buildBudgets(created: Date): void {
    const nowDate = new Date(this.now);
    for (const spec of BUDGET_SPECS) {
      const agentId = spec.agent ? `agt_${spec.agent.replace(/-/g, "_")}` : null;
      const projectId = spec.project === "prod" ? "prj_prod" : spec.project === "internal" ? "prj_internal" : agentId ? this.agents.find((a) => a.id === agentId)!.projectId : null;
      const budget: Budget = {
        id: `bud_${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        organizationId: this.organization.id,
        scope: spec.scope,
        projectId,
        agentId,
        name: spec.name,
        period: spec.period,
        limitMicros: 0n,
        enforcement: spec.enforcement,
        alertThresholds: spec.thresholds,
        isActive: true,
        managedBy: null,
        createdAt: created,
        updatedAt: created,
      };
      const window = periodWindow(budget.period, nowDate, budget.createdAt, nowDate);
      const committed = this.spendSince(budget, window.start.getTime());
      const rawLimit = Number(committed) / spec.target;
      const step = rawLimit > 1_000_000_000 ? 50_000_000 : rawLimit > 100_000_000 ? 5_000_000 : 1_000_000;
      budget.limitMicros = BigInt(Math.max(5_000_000, Math.ceil(rawLimit / step) * step));
      this.budgets.push(budget);
      this.counters.set(budget.id, { periodKey: window.key, periodStart: window.start, periodEnd: window.end, committedMicros: committed, reservedMicros: 0n });
    }
  }

  private agentsInScope(budget: Budget): Agent[] {
    return this.agents.filter((a) =>
      budget.scope === "ORGANIZATION" ? true : budget.scope === "PROJECT" ? a.projectId === budget.projectId : a.id === budget.agentId,
    );
  }

  /** Settled spend for a budget's scope since `fromMs`, from minute data when available, else hourly. */
  private spendSince(budget: Budget, fromMs: number): bigint {
    let total = 0;
    const fromMinute = minuteOf(fromMs);
    const nowMinute = minuteOf(this.now);
    for (const a of this.agentsInScope(budget)) {
      const minutes = this.minutes.get(a.id)!;
      const hours = this.hours.get(a.id)!;
      const minuteFloor = Math.max(fromMinute, minutes.start);
      total += minutes.sum(minuteFloor, nowMinute, "cost");
      if (fromMinute < minutes.start) {
        // Older part from hourly series (minute data begins mid-hour; avoid double counting).
        const lastHourlyHour = Math.floor(minutes.start / 60) - 1;
        total += hours.sum(Math.floor(fromMinute / 60), lastHourlyHour, "cost");
      }
    }
    return BigInt(Math.round(total));
  }

  // ---- live loop -------------------------------------------------------------

  tick(): void {
    const real = performance.now();
    const elapsed = Math.min(2_000, real - this.lastRealTick);
    this.lastRealTick = real;
    if (!this.running) return;

    const from = this.now;
    const to = from + elapsed * this.speed;
    // Advance in steps of at most 10 simulated seconds so minute boundaries are handled precisely.
    let t = from;
    while (t < to) {
      const stepEnd = Math.min(to, t + 10_000, (minuteOf(t) + 1) * MINUTE);
      this.advance(t, stepEnd);
      t = stepEnd;
    }
    this.now = to;
    this.processDeliveries();
    this.trim();
    this.emit();
  }

  private advance(fromMs: number, toMs: number): void {
    const dtMinutes = (toMs - fromMs) / MINUTE;
    for (const agent of this.agents) {
      const b = this.behaviors.get(agent.id)!;
      const n = this.rng.poisson(this.rateAt(b, fromMs) * dtMinutes);
      for (let i = 0; i < n; i++) this.simulateRequest(agent, new Date(fromMs + this.rng.uniform() * (toMs - fromMs)), true);
    }
    const closedUpTo = minuteOf(toMs);
    if (closedUpTo > this.lastEvaluatedMinute + 1) {
      for (let m = this.lastEvaluatedMinute + 1; m < closedUpTo; m++) this.evaluateClosedMinute(m + 1, true);
      this.lastEvaluatedMinute = closedUpTo - 1;
    }
  }

  /** Mirrors POST /authorize followed by POST /usage. */
  private simulateRequest(agent: Agent, at: Date, live: boolean): void {
    const b = this.behaviors.get(agent.id)!;
    const price = this.priceFor(b);
    const runaway = b.runaway && at.getTime() < b.runaway.untilMs ? b.runaway.tokenMultiplier : 1;
    const minute = minuteOf(at.getTime());
    const hour = hourOf(at.getTime());
    const series = this.minutes.get(agent.id)!;
    const hourly = this.hours.get(agent.id)!;

    const estIn = Math.round(b.inputTokens * runaway * 1.15);
    const estimate = computeCostMicros(price, { inputTokens: estIn, outputTokens: Math.round(b.outputTokens * runaway * 2), cachedInputTokens: 0 });

    const decide = (decision: "ALLOW" | "DENY", reason: string | null, costMicros: bigint | null, overLimit = false) => {
      if (!live) return;
      this.decisions.unshift({ id: cuid(this.rng), at, agentId: agent.id, model: b.model, estimateMicros: estimate, costMicros, decision, reason, overLimit });
      if (this.decisions.length > 60) this.decisions.length = 60;
    };
    const block = (reason: string) => {
      series.add(minute, "blocked", 1);
      hourly.add(hour, "blocked", 1);
      decide("DENY", reason, null);
    };

    if (agent.status !== "ACTIVE") {
      block(agent.status === "PAUSED" ? "Agent paused" : agent.status === "QUARANTINED" ? "Agent quarantined" : "Agent stopped");
      return;
    }

    // Velocity guard
    const v = this.velocity.get(agent.id);
    const count = v && v.minute === minute ? v.count + 1 : 1;
    this.velocity.set(agent.id, { minute, count });
    if (live && agent.maxRequestsPerMinute !== null && count > agent.maxRequestsPerMinute) {
      if (agent.autoKillOnVelocity) {
        this.applyTransition(agent, "KILLED", `Auto-stopped: ${count} requests in one minute exceeded the limit of ${agent.maxRequestsPerMinute}.`);
        this.raiseAlert({ type: "AGENT_KILLED", severity: "CRITICAL", agentId: agent.id, dedupeKey: `killed:${agent.id}:${minute}`, message: `${agent.displayName} was stopped automatically after ${count} requests in one minute.` });
      } else {
        this.raiseAlert({ type: "VELOCITY_LIMIT", severity: "CRITICAL", agentId: agent.id, dedupeKey: `velocity:${agent.id}:${minute}`, message: `${agent.displayName} exceeded ${agent.maxRequestsPerMinute} requests per minute.` });
      }
      block("Rate limit");
      return;
    }

    // Budgets: atomic check across every applicable budget
    let overLimit = false;
    if (live) {
      const strict = agent.enforcementMode === "STRICT";
      for (const budget of this.applicableBudgets(agent)) {
        const c = this.counterFor(budget, at);
        if (c.committedMicros + c.reservedMicros + estimate <= budget.limitMicros) continue;
        if (strict && budget.enforcement === "BLOCK") {
          this.raiseAlert({ type: "BUDGET_BLOCKED", severity: "CRITICAL", agentId: agent.id, budgetId: budget.id, periodKey: c.periodKey, dedupeKey: `blocked:${budget.id}:${c.periodKey}`, message: `${budget.name} blocked a request from ${agent.displayName}: limit ${usd(budget.limitMicros)} reached.` });
          block(`${budget.name} at limit`);
          return;
        }
        overLimit = true;
        this.raiseAlert({
          type: "BUDGET_LIMIT_BYPASSED",
          severity: "WARNING",
          agentId: agent.id,
          budgetId: budget.id,
          periodKey: c.periodKey,
          dedupeKey: `bypassed:${budget.id}:${c.periodKey}:${agent.id}`,
          message: `${agent.displayName} went past ${budget.name} (${usd(budget.limitMicros)}) and was allowed because ${strict ? "the budget only alerts" : "the agent runs in alert-only mode"}.`,
          payload: { spentMicros: (c.committedMicros + estimate).toString(), agentEnforcementMode: agent.enforcementMode },
        });
        break;
      }
    }

    // Settle actual usage
    const totalIn = Math.max(1, Math.round(b.inputTokens * runaway * this.rng.logNoise(0.25)));
    const cached = Math.min(totalIn, Math.round(totalIn * b.cacheRatio * this.rng.uniform() * 2));
    const input = totalIn - cached;
    const output = Math.max(1, Math.round(b.outputTokens * runaway * this.rng.logNoise(0.35)));
    const cost = computeCostMicros(price, { inputTokens: input, outputTokens: output, cachedInputTokens: cached });

    series.add(minute, "requests", 1);
    series.add(minute, "input", input);
    series.add(minute, "cached", cached);
    series.add(minute, "output", output);
    series.add(minute, "cost", Number(cost));
    hourly.add(hour, "requests", 1);
    hourly.add(hour, "input", input);
    hourly.add(hour, "cached", cached);
    hourly.add(hour, "output", output);
    hourly.add(hour, "cost", Number(cost));
    agent.lastSeenAt = at;

    if (!live) return;

    for (const budget of this.applicableBudgets(agent)) {
      const c = this.counterFor(budget, at);
      const before = c.committedMicros;
      c.committedMicros += cost;
      for (const t of budget.alertThresholds) {
        const boundary = (budget.limitMicros * BigInt(t)) / 100n;
        if (before < boundary && c.committedMicros >= boundary) {
          this.raiseAlert({
            type: "BUDGET_THRESHOLD",
            severity: t >= 100 ? "CRITICAL" : t >= 80 ? "WARNING" : "INFO",
            budgetId: budget.id,
            agentId: budget.agentId,
            periodKey: c.periodKey,
            threshold: t,
            dedupeKey: `threshold:${budget.id}:${c.periodKey}:${t}`,
            message: `${budget.name} reached ${t}% of its ${usd(budget.limitMicros)} ${budget.period.toLowerCase()} limit (${usd(c.committedMicros)} spent).`,
            payload: { limitMicros: budget.limitMicros.toString(), spentMicros: c.committedMicros.toString(), enforcement: budget.enforcement },
          });
        }
      }
    }

    const event: UsageEvent = {
      id: cuid(this.rng),
      organizationId: agent.organizationId,
      projectId: agent.projectId,
      agentId: agent.id,
      apiKeyId: "key_sim",
      idempotencyKey: `sim-${at.getTime()}-${Math.floor(this.rng.uniform() * 1e9)}`,
      reservationId: `res_${Math.floor(this.rng.uniform() * 1e12).toString(16)}`,
      provider: b.provider,
      model: b.model,
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
      costMicros: cost,
      latencyMs: Math.round(400 + this.rng.uniform() * 6000 * Math.sqrt(output / 500)),
      status: this.rng.uniform() > 0.985 ? "ERROR" : "SUCCESS",
      traceId: null,
      metadata: null,
      occurredAt: at,
      createdAt: at,
    };
    this.usageEvents.unshift(event);
    if (this.usageEvents.length > 300) this.usageEvents.length = 300;
    decide("ALLOW", null, cost, overLimit);
  }

  private applicableBudgets(agent: Agent): Budget[] {
    return this.budgets.filter(
      (b) => b.isActive && (b.scope === "ORGANIZATION" || (b.scope === "PROJECT" && b.projectId === agent.projectId) || (b.scope === "AGENT" && b.agentId === agent.id)),
    );
  }

  /** Current-period counter; rolls over (and re-derives from the series) when the period changes. */
  counterFor(budget: Budget, at: Date = new Date(this.now)): BudgetCounter {
    const w = periodWindow(budget.period, at, budget.createdAt, at);
    const existing = this.counters.get(budget.id);
    if (existing && existing.periodKey === w.key) return existing;
    const fresh: BudgetCounter = { periodKey: w.key, periodStart: w.start, periodEnd: w.end, committedMicros: this.spendSince(budget, w.start.getTime()), reservedMicros: 0n };
    this.counters.set(budget.id, fresh);
    return fresh;
  }

  // ---- anomaly detection (identical math to the worker) --------------------

  private minuteSamples(agentId: string, fromMinute: number, toMinute: number): Map<number, MinuteSample> {
    const s = this.minutes.get(agentId)!;
    const out = new Map<number, MinuteSample>();
    for (let m = fromMinute; m <= toMinute; m++) {
      const requests = s.get(m, "requests");
      const cost = s.get(m, "cost");
      if (requests === 0 && cost === 0) continue;
      out.set(m, { minute: m, costMicros: cost, requests, tokens: s.get(m, "input") + s.get(m, "cached") + s.get(m, "output") });
    }
    return out;
  }

  /** Evaluate the window ending at the minute just closed (`closedUpTo - 1`). */
  private evaluateClosedMinute(closedUpTo: number, live: boolean): void {
    const end = closedUpTo - 1;
    const lookbackFrom = end - DETECTOR.baselineMinutes - DETECTOR.windowMinutes;
    for (const agent of this.agents) {
      const series = this.minuteSamples(agent.id, lookbackFrom, end);
      const profile = foldProfile(this.profiles.get(agent.id)!, series, end - DETECTOR.windowMinutes + 1, DETECTOR);
      this.profiles.set(agent.id, profile);
      const history = Math.min(end - this.firstSeenMinute.get(agent.id)! + 1, profile.count + DETECTOR.windowMinutes);
      const verdict = evaluateWindow(series, end, profile, history, DETECTOR);
      this.verdicts.set(agent.id, verdict);
      if (verdict.status === "anomalous" && (agent.status === "ACTIVE" || agent.status === "PAUSED")) {
        this.quarantine(agent, verdict, live);
      }
    }
  }

  private quarantine(agent: Agent, verdict: Verdict, live: boolean): void {
    const at = new Date((verdict.windowEndMinute + 1) * MINUTE);
    const reason = `Auto-quarantined: spend ${(verdict.windowMeanPerMinute / 1e6).toFixed(4)} USD/min over ${DETECTOR.windowMinutes} min is ${verdict.zScore.toFixed(1)}σ above baseline.`;
    this.applyTransition(agent, "QUARANTINED", reason, at);
    const incident: SecurityIncident = {
      id: cuid(this.rng),
      organizationId: agent.organizationId,
      agentId: agent.id,
      type: "SPEND_ANOMALY",
      severity: "CRITICAL",
      status: "OPEN",
      dedupeKey: `anomaly:${agent.id}:${verdict.windowEndMinute}`,
      detector: "anomaly-engine",
      detectorVersion: DETECTOR_VERSION,
      windowStart: new Date(verdict.windowStartMinute * MINUTE),
      windowEnd: at,
      windowSpendMicros: BigInt(Math.round(verdict.windowSpendMicros)),
      baselineMeanMicros: verdict.baseline?.mean ?? 0,
      baselineStdMicros: verdict.baseline?.effectiveStd ?? 0,
      thresholdMicros: verdict.thresholdPerMinute,
      zScore: verdict.zScore,
      actionTaken: "QUARANTINED",
      evidence: {
        detectorVersion: DETECTOR_VERSION,
        sigma: DETECTOR.sigma,
        windowMinutes: DETECTOR.windowMinutes,
        baselineMinutes: DETECTOR.baselineMinutes,
        windowRequests: verdict.windowRequests,
        windowTokens: verdict.windowTokens,
        governingBaseline: verdict.baseline?.source ?? null,
        rollingMeanMicros: verdict.rolling?.mean ?? null,
        longTermMeanMicros: verdict.longTerm?.mean ?? null,
        tokensPerRequestZ: verdict.tokensPerRequest?.zScore ?? null,
        reasons: verdict.reasons,
      } satisfies Prisma.JsonObject,
      resolvedAt: null,
      resolvedById: null,
      resolutionNote: null,
      createdAt: at,
      updatedAt: at,
    };
    this.incidents.unshift(incident);
    this.ledger.unshift({
      id: cuid(this.rng),
      organizationId: agent.organizationId,
      projectId: agent.projectId,
      agentId: agent.id,
      usageEventId: null,
      securityIncidentId: incident.id,
      type: "SECURITY_INCIDENT",
      amountMicros: 0n,
      description: `Security incident ${incident.id}: spend anomaly (${verdict.zScore.toFixed(1)}σ). Action: QUARANTINED.`,
      createdAt: at,
    });
    this.raiseAlert(
      {
        type: "AGENT_QUARANTINED",
        severity: "CRITICAL",
        agentId: agent.id,
        securityIncidentId: incident.id,
        dedupeKey: `incident:${incident.id}`,
        message: `${agent.displayName} was quarantined: spend of ${usd(BigInt(Math.round(verdict.windowSpendMicros)))} in ${DETECTOR.windowMinutes} minutes is ${verdict.zScore.toFixed(1)} standard deviations above normal.`,
        payload: { zScore: verdict.zScore },
      },
      at,
      live,
    );
    const b = this.behaviors.get(agent.id);
    if (b) b.runaway = null;
  }

  private applyTransition(agent: Agent, to: AgentStatus, reason: string | null, at: Date = new Date(this.now)): void {
    if (!canTransition(agent.status, to)) throw new Error(`An agent cannot move from ${agent.status} to ${to}.`);
    agent.status = to;
    agent.updatedAt = at;
    if (to === "KILLED") {
      agent.killedAt = at;
      agent.killReason = reason;
      agent.quarantinedAt = null;
    } else if (to === "QUARANTINED") {
      agent.quarantinedAt = at;
      agent.killedAt = at;
      agent.killReason = reason;
    } else {
      agent.killedAt = null;
      agent.killReason = null;
      agent.quarantinedAt = null;
    }
  }

  // ---- alerts & notification deliveries ----------------------------------------

  private raiseAlert(
    a: {
      type: AlertType;
      severity: AlertSeverity;
      dedupeKey: string;
      message: string;
      agentId?: string | null;
      budgetId?: string | null;
      periodKey?: string;
      threshold?: number;
      securityIncidentId?: string;
      payload?: Prisma.JsonValue;
    },
    at: Date = new Date(this.now),
    live = true,
  ): void {
    if (this.alerts.some((x) => x.dedupeKey === a.dedupeKey)) return;
    const alert: Alert = {
      id: cuid(this.rng),
      organizationId: this.organization.id,
      budgetId: a.budgetId ?? null,
      agentId: a.agentId ?? null,
      type: a.type,
      severity: a.severity,
      dedupeKey: a.dedupeKey,
      periodKey: a.periodKey ?? null,
      threshold: a.threshold ?? null,
      message: a.message,
      payload: a.payload ?? null,
      acknowledgedAt: null,
      acknowledgedById: null,
      securityIncidentId: a.securityIncidentId ?? null,
      fanoutAt: at,
      createdAt: at,
    };
    this.alerts.unshift(alert);
    if (this.alerts.length > 200) this.alerts.length = 200;

    const rank = { INFO: 0, WARNING: 1, CRITICAL: 2 } as const;
    for (const ch of this.channels) {
      if (!ch.isEnabled || rank[alert.severity] < rank[ch.minSeverity]) continue;
      if (ch.alertTypes.length && !ch.alertTypes.includes(alert.type)) continue;
      const historical = !live;
      this.deliveries.unshift({
        id: cuid(this.rng),
        alertId: alert.id,
        channelId: ch.id,
        status: historical ? "DELIVERED" : "PENDING",
        attempts: historical ? (ch.type === "TEAMS" ? 3 : 1) : 0,
        nextAttemptAt: at,
        lastAttemptAt: historical ? at : null,
        lastError: historical && ch.type === "TEAMS" ? "HTTP 503: Service Unavailable" : null,
        lastStatusCode: historical ? 200 : null,
        deliveredAt: historical ? new Date(at.getTime() + (ch.type === "TEAMS" ? 9_000 : 600)) : null,
        providerMessageId: historical ? `msg_${Math.floor(this.rng.uniform() * 1e10).toString(36)}` : null,
        createdAt: at,
        updatedAt: at,
      });
    }
    if (this.deliveries.length > 600) this.deliveries.length = 600;
  }

  /** Mirrors the worker's dispatcher: send, then backoff/retry, then dead-letter. */
  private processDeliveries(): void {
    for (const d of this.deliveries) {
      if (d.status !== "PENDING" && d.status !== "RETRY_SCHEDULED") continue;
      if (d.nextAttemptAt.getTime() > this.now) continue;
      const health = this.channelHealth.get(d.channelId) ?? "healthy";
      const channel = this.channels.find((c) => c.id === d.channelId);
      if (!channel?.isEnabled) {
        d.status = "SKIPPED";
        d.lastError = "Channel disabled";
        continue;
      }
      d.attempts += 1;
      d.lastAttemptAt = new Date(this.now);
      d.updatedAt = new Date(this.now);
      if (this.rng.uniform() < CHANNEL_SUCCESS[health]) {
        d.status = "DELIVERED";
        d.deliveredAt = new Date(this.now);
        d.lastStatusCode = channel.type === "TEAMS" ? 202 : 200;
        d.lastError = null;
        d.providerMessageId = `msg_${Math.floor(this.rng.uniform() * 1e10).toString(36)}`;
        continue;
      }
      const rateLimited = health === "degraded" && this.rng.uniform() < 0.3;
      d.lastStatusCode = rateLimited ? 429 : health === "down" ? null : 503;
      d.lastError = rateLimited ? "HTTP 429: rate limited (Retry-After: 30)" : health === "down" ? "TypeError: fetch failed: connect ECONNREFUSED" : "HTTP 503: Service Unavailable";
      if (d.attempts >= MAX_ATTEMPTS) {
        d.status = "DEAD";
        d.lastError = `Gave up after ${d.attempts} attempts: ${d.lastError}`;
        continue;
      }
      d.status = "RETRY_SCHEDULED";
      d.nextAttemptAt = new Date(this.now + nextRetryDelayMs(d.attempts, BACKOFF, rateLimited ? 30_000 : undefined, () => this.rng.uniform()));
    }
  }

  private trim(): void {
    const nowMinute = minuteOf(this.now);
    for (const s of this.minutes.values()) if (nowMinute - s.start > MINUTE_RETENTION + 120) s.trim(nowMinute - MINUTE_RETENTION);
    const nowHour = hourOf(this.now);
    for (const s of this.hours.values()) if (nowHour - s.start > HOUR_RETENTION + 24) s.trim(nowHour - HOUR_RETENTION);
  }

  // ---- mutations (applied by the mock transport after simulated latency) ---------

  updateAgent(agentId: string, patch: AgentPatch): Agent {
    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`Agent ${agentId} was not found.`);
    if (patch.status && patch.status !== agent.status) {
      if (patch.status === "QUARANTINED") throw new Error("Only the anomaly engine can quarantine an agent.");
      if (!canTransition(agent.status, patch.status)) throw new Error(`An agent cannot move from ${agent.status} to ${patch.status}.`);
      if (requiresReason(agent.status, patch.status) && !patch.reason?.trim()) throw new Error("A reason is required for this change.");
      const releasing = agent.status === "QUARANTINED";
      this.applyTransition(agent, patch.status, patch.reason ?? null);
      if (releasing) {
        for (const inc of this.incidents) {
          if (inc.agentId === agent.id && (inc.status === "OPEN" || inc.status === "ACKNOWLEDGED")) {
            inc.status = patch.incidentResolution ?? "RESOLVED";
            inc.resolvedAt = new Date(this.now);
            inc.resolutionNote = patch.reason ?? null;
            inc.resolvedById = "usr_dev_admin";
            inc.updatedAt = new Date(this.now);
          }
        }
        const b = this.behaviors.get(agent.id);
        if (b) b.runaway = null;
      }
      if (patch.status === "KILLED") {
        this.raiseAlert({ type: "AGENT_KILLED", severity: "CRITICAL", agentId: agent.id, dedupeKey: `killed:${agent.id}:manual:${this.now}`, message: `${agent.displayName} was stopped manually: ${patch.reason}.` });
      }
    }
    if (patch.enforcementMode) agent.enforcementMode = patch.enforcementMode;
    if (patch.maxRequestsPerMinute !== undefined) {
      agent.maxRequestsPerMinute = patch.maxRequestsPerMinute;
      if (patch.maxRequestsPerMinute === null) agent.autoKillOnVelocity = false;
    }
    if (patch.autoKillOnVelocity !== undefined) agent.autoKillOnVelocity = patch.autoKillOnVelocity;
    agent.updatedAt = new Date(this.now);
    this.emit();
    return { ...agent };
  }

  updateBudget(budgetId: string, patch: BudgetPatch): Budget {
    const budget = this.budgets.find((b) => b.id === budgetId);
    if (!budget) throw new Error(`Budget ${budgetId} was not found.`);
    if (patch.enforcement) budget.enforcement = patch.enforcement;
    if (patch.isActive !== undefined) budget.isActive = patch.isActive;
    if (patch.limitMicros !== undefined) {
      if (patch.limitMicros <= 0n) throw new Error("The limit must be greater than zero.");
      budget.limitMicros = patch.limitMicros;
    }
    budget.updatedAt = new Date(this.now);
    this.emit();
    return { ...budget };
  }

  acknowledgeAlert(alertId: string): void {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (alert && !alert.acknowledgedAt) {
      alert.acknowledgedAt = new Date(this.now);
      alert.acknowledgedById = "usr_dev_admin";
    }
    this.emit();
  }

  acknowledgeIncident(incidentId: string): void {
    const inc = this.incidents.find((i) => i.id === incidentId);
    if (inc && inc.status === "OPEN") {
      inc.status = "ACKNOWLEDGED";
      inc.updatedAt = new Date(this.now);
    }
    this.emit();
  }

  /** Make an agent misbehave: multiply its request rate and request size. */
  injectRunaway(agentId: string, minutes = 15, rateMultiplier = 30, tokenMultiplier = 2.5): void {
    const b = this.behaviors.get(agentId);
    if (!b) return;
    b.runaway = { untilMs: this.now + minutes * MINUTE, rateMultiplier, tokenMultiplier };
    this.emit();
  }

  isRunaway(agentId: string): boolean {
    const b = this.behaviors.get(agentId);
    return !!b?.runaway && this.now < b.runaway.untilMs;
  }

  // ---- read models -------------------------------------------------------

  modelOf(agentId: string): { provider: string; model: string } {
    const b = this.behaviors.get(agentId)!;
    return { provider: b.provider, model: b.model };
  }

  verdictFor(agentId: string): Verdict | null {
    return this.verdicts.get(agentId) ?? null;
  }

  private agentIdsFor(projectId: string | null): string[] {
    return this.agents.filter((a) => !projectId || a.projectId === projectId).map((a) => a.id);
  }

  /** Aggregated trend for the selected interval: 15-min buckets (24h), hourly (7d), 6-hourly (30d). */
  trend(interval: TrendInterval, projectId: string | null): TrendPoint[] {
    const ids = this.agentIdsFor(projectId);
    const points: TrendPoint[] = [];
    const add = (t: number, read: (f: Field) => number) => {
      const cost = read("cost");
      points.push({
        t,
        costMicros: cost,
        costUsd: cost / 1e6,
        requests: read("requests"),
        blocked: read("blocked"),
        inputTokens: read("input"),
        cachedTokens: read("cached"),
        outputTokens: read("output"),
      });
    };

    if (interval === "24h") {
      const nowMinute = minuteOf(this.now);
      const bucket = 15;
      const end = Math.floor(nowMinute / bucket) * bucket;
      for (let start = end - 95 * bucket; start <= end; start += bucket) {
        add(start * MINUTE, (f) => ids.reduce((s, id) => s + this.minutes.get(id)!.sum(start, start + bucket - 1, f), 0));
      }
      return points;
    }

    const bucketHours = interval === "7d" ? 1 : 6;
    const count = interval === "7d" ? 168 : 120;
    const nowHour = hourOf(this.now);
    const end = Math.floor(nowHour / bucketHours) * bucketHours;
    for (let start = end - (count - 1) * bucketHours; start <= end; start += bucketHours) {
      add(start * HOUR, (f) => ids.reduce((s, id) => s + this.hours.get(id)!.sum(start, start + bucketHours - 1, f), 0));
    }
    return points;
  }

  agentStats(agentId: string, interval: TrendInterval): AgentLiveStats {
    const minutes = this.minutes.get(agentId)!;
    const hours = this.hours.get(agentId)!;
    const nowMinute = minuteOf(this.now);
    const nowHour = hourOf(this.now);
    const [spend, requests, blocked] =
      interval === "24h"
        ? (["cost", "requests", "blocked"] as const).map((f) => minutes.sum(nowMinute - 1439, nowMinute, f))
        : (["cost", "requests", "blocked"] as const).map((f) => hours.sum(nowHour - (interval === "7d" ? 167 : 719), nowHour, f));
    const lastHourRequests = minutes.sum(nowMinute - 59, nowMinute, "requests");
    const lastHourTokens = (["input", "cached", "output"] as const).reduce((s, f) => s + minutes.sum(nowMinute - 59, nowMinute, f), 0);
    const sparkline: number[] = [];
    for (let m = nowMinute - 29; m <= nowMinute; m++) sparkline.push(minutes.get(m, "cost") / 1e6);
    return {
      spendPerMinuteUsd: minutes.sum(nowMinute - 4, nowMinute, "cost") / 5 / 1e6,
      spendInIntervalUsd: (spend ?? 0) / 1e6,
      requestsInInterval: requests ?? 0,
      blockedInInterval: blocked ?? 0,
      tokensPerRequest: lastHourRequests ? lastHourTokens / lastHourRequests : 0,
      sparkline,
      verdict: this.verdicts.get(agentId) ?? null,
    };
  }

  /** Org-wide spend rate over the last 5 minutes, USD per minute. */
  spendRateUsdPerMinute(projectId: string | null): number {
    const nowMinute = minuteOf(this.now);
    return this.agentIdsFor(projectId).reduce((s, id) => s + this.minutes.get(id)!.sum(nowMinute - 4, nowMinute, "cost"), 0) / 5 / 1e6;
  }
}

function usd(micros: bigint): string {
  const v = Number(micros) / 1e6;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
