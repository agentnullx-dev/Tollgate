import { createHash } from "node:crypto";
import { PrismaClient, type AgentEnforcementMode, type BudgetPeriod, type BudgetScope, type NotificationChannelType } from "@prisma/client";
import { sealChannelTarget } from "../src/lib/notifications/channels";

const prisma = new PrismaClient();

const DEV_KEY = process.env.SEED_API_KEY ?? "tg_live_0123456789ab_devdevdevdevdevdevdevdevdevdevde";
const KEY_PATTERN = /^tg_live_([a-f0-9]{12})_([A-Za-z0-9_-]{32})$/;

const usd = (v: number) => BigInt(Math.round(v * 1_000_000));

// Illustrative list prices in USD per million tokens. Verify against each
// provider's current pricing page before relying on them for billing.
const PRICES: Array<{ provider: string; model: string; input: number; output: number; cached: number }> = [
  { provider: "anthropic", model: "claude-opus-4-1", input: 15, output: 75, cached: 1.5 },
  { provider: "anthropic", model: "claude-sonnet-4-5", input: 3, output: 15, cached: 0.3 },
  { provider: "anthropic", model: "claude-haiku-4-5", input: 1, output: 5, cached: 0.1 },
  { provider: "openai", model: "gpt-4.1", input: 2, output: 8, cached: 0.5 },
  { provider: "openai", model: "gpt-4.1-mini", input: 0.4, output: 1.6, cached: 0.1 },
  { provider: "google", model: "gemini-2.5-pro", input: 1.25, output: 10, cached: 0.31 },
  { provider: "google", model: "gemini-2.5-flash", input: 0.3, output: 2.5, cached: 0.075 },
];

const AGENTS: Array<{
  externalId: string;
  displayName: string;
  rpm: number;
  autoKill: boolean;
  model: string;
  provider: string;
  weight: number;
  mode: AgentEnforcementMode;
}> = [
  { externalId: "support-triage", displayName: "Support triage", rpm: 120, autoKill: true, model: "claude-haiku-4-5", provider: "anthropic", weight: 1.0, mode: "STRICT" },
  { externalId: "contract-reviewer", displayName: "Contract reviewer", rpm: 30, autoKill: false, model: "claude-sonnet-4-5", provider: "anthropic", weight: 0.6, mode: "STRICT" },
  { externalId: "code-migrator", displayName: "Code migrator", rpm: 60, autoKill: true, model: "claude-opus-4-1", provider: "anthropic", weight: 0.25, mode: "STRICT" },
  { externalId: "lead-enricher", displayName: "Lead enricher", rpm: 200, autoKill: false, model: "gpt-4.1-mini", provider: "openai", weight: 1.4, mode: "ALERT_ONLY" },
  { externalId: "research-summarizer", displayName: "Research summarizer", rpm: 40, autoKill: false, model: "gemini-2.5-pro", provider: "google", weight: 0.4, mode: "STRICT" },
];

/** Deterministic PRNG so the seeded history is stable between runs. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const match = KEY_PATTERN.exec(DEV_KEY);
  if (!match?.[1]) throw new Error("SEED_API_KEY must match tg_live_<12 hex>_<32 base64url chars>.");
  const prefix = match[1];

  for (const p of PRICES) {
    const effectiveFrom = new Date("2025-01-01T00:00:00Z");
    await prisma.modelPrice.upsert({
      where: { provider_model_effectiveFrom: { provider: p.provider, model: p.model, effectiveFrom } },
      create: {
        provider: p.provider,
        model: p.model,
        inputMicrosPerMTok: usd(p.input),
        outputMicrosPerMTok: usd(p.output),
        cachedInputMicrosPerMTok: usd(p.cached),
        effectiveFrom,
      },
      update: {
        inputMicrosPerMTok: usd(p.input),
        outputMicrosPerMTok: usd(p.output),
        cachedInputMicrosPerMTok: usd(p.cached),
      },
    });
  }

  const user = await prisma.user.upsert({
    where: { email: "dev@acme.test" },
    create: { email: "dev@acme.test", name: "Dev Admin", emailVerified: new Date() },
    update: {},
  });

  const org = await prisma.organization.upsert({
    where: { slug: "acme" },
    create: { name: "Acme Robotics", slug: "acme", plan: "TEAM" },
    update: {},
  });

  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
    create: { userId: user.id, organizationId: org.id, role: "OWNER" },
    update: { role: "OWNER" },
  });

  // One user per role so RBAC can be exercised locally (sign in with AUTH_DEV_LOGIN=true).
  for (const extra of [
    { email: "developer@acme.test", name: "Dana Developer", role: "DEVELOPER" as const },
    { email: "viewer@acme.test", name: "Victor Viewer", role: "VIEWER" as const },
  ]) {
    const u = await prisma.user.upsert({
      where: { email: extra.email },
      create: { email: extra.email, name: extra.name, emailVerified: new Date() },
      update: {},
    });
    await prisma.membership.upsert({
      where: { userId_organizationId: { userId: u.id, organizationId: org.id } },
      create: { userId: u.id, organizationId: org.id, role: extra.role },
      update: { role: extra.role },
    });
  }

  const project = await prisma.project.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: "production-agents" } },
    create: { organizationId: org.id, name: "Production agents", slug: "production-agents" },
    update: {},
  });

  await prisma.apiKey.upsert({
    where: { prefix },
    create: {
      organizationId: org.id,
      projectId: project.id,
      name: "Local development key",
      prefix,
      hashedKey: createHash("sha256").update(DEV_KEY).digest("hex"),
      scopes: ["org:admin"],
      createdById: user.id,
    },
    update: {
      hashedKey: createHash("sha256").update(DEV_KEY).digest("hex"),
      revokedAt: null,
    },
  });

  const agents = [];
  for (const a of AGENTS) {
    const agent = await prisma.agent.upsert({
      where: { projectId_externalId: { projectId: project.id, externalId: a.externalId } },
      create: {
        organizationId: org.id,
        projectId: project.id,
        externalId: a.externalId,
        displayName: a.displayName,
        maxRequestsPerMinute: a.rpm,
        autoKillOnVelocity: a.autoKill,
        enforcementMode: a.mode,
      },
      update: {},
    });
    agents.push({ ...a, id: agent.id });
  }

  const existingBudgets = await prisma.budget.count({ where: { organizationId: org.id } });
  if (existingBudgets === 0) {
    const budgetDefs: Array<{
      name: string;
      scope: BudgetScope;
      period: BudgetPeriod;
      limit: number;
      projectId?: string;
      agentId?: string;
      enforcement?: "BLOCK" | "ALERT_ONLY";
    }> = [
      { name: "Company monthly cap", scope: "ORGANIZATION", period: "MONTHLY", limit: 2500 },
      { name: "Production daily cap", scope: "PROJECT", period: "DAILY", limit: 140, projectId: project.id },
      { name: "Code migrator daily", scope: "AGENT", period: "DAILY", limit: 45, projectId: project.id, agentId: agents[2]!.id },
      { name: "Lead enricher weekly", scope: "AGENT", period: "WEEKLY", limit: 60, projectId: project.id, agentId: agents[3]!.id, enforcement: "ALERT_ONLY" },
    ];
    for (const b of budgetDefs) {
      await prisma.budget.create({
        data: {
          organizationId: org.id,
          scope: b.scope,
          projectId: b.projectId ?? null,
          agentId: b.agentId ?? null,
          name: b.name,
          period: b.period,
          limitMicros: usd(b.limit),
          enforcement: b.enforcement ?? "BLOCK",
          // Backdate so lifetime and weekly windows include seeded history.
          createdAt: new Date(Date.now() - 30 * 86_400_000),
        },
      });
    }
  }

  // Notification channels. Email goes to Mailpit in local development (http://localhost:8025).
  const channelCount = await prisma.notificationChannel.count({ where: { organizationId: org.id } });
  if (channelCount === 0) {
    const defs: Array<{ type: NotificationChannelType; name: string; target: string | string[]; secret?: string; minSeverity: "INFO" | "WARNING" | "CRITICAL" }> = [
      { type: "EMAIL", name: "On-call email", target: (process.env.SEED_ALERT_EMAILS ?? "oncall@acme.test,finops@acme.test").split(","), minSeverity: "WARNING" },
    ];
    if (process.env.SEED_SLACK_WEBHOOK_URL) defs.push({ type: "SLACK", name: "#ai-spend-alerts", target: process.env.SEED_SLACK_WEBHOOK_URL, minSeverity: "WARNING" });
    if (process.env.SEED_TEAMS_WEBHOOK_URL) defs.push({ type: "TEAMS", name: "FinOps channel", target: process.env.SEED_TEAMS_WEBHOOK_URL, minSeverity: "WARNING" });
    if (process.env.SEED_WEBHOOK_URL) {
      defs.push({ type: "WEBHOOK", name: "Incident pipeline", target: process.env.SEED_WEBHOOK_URL, secret: process.env.SEED_WEBHOOK_SECRET, minSeverity: "CRITICAL" });
    }
    for (const d of defs) {
      await prisma.notificationChannel.create({
        data: {
          organizationId: org.id,
          type: d.type,
          name: d.name,
          minSeverity: d.minSeverity,
          alertTypes: [],
          ...sealChannelTarget(org.id, d.type, d.target, d.secret ?? null),
        },
      });
    }
    console.log(`Created ${defs.length} notification channel(s).`);
  }

  const existingEvents = await prisma.usageEvent.count({ where: { projectId: project.id } });
  if (existingEvents === 0) {
    const rand = mulberry32(42);
    const priceMap = new Map(PRICES.map((p) => [`${p.provider}/${p.model}`, p]));
    const now = Date.now();
    let created = 0;

    for (let day = 13; day >= 0; day--) {
      for (const agent of agents) {
        const calls = Math.floor((8 + rand() * 18) * agent.weight);
        for (let i = 0; i < calls; i++) {
          const occurredAt = new Date(now - day * 86_400_000 - Math.floor(rand() * 20 * 3_600_000));
          if (occurredAt.getTime() > now) continue;
          const price = priceMap.get(`${agent.provider}/${agent.model}`)!;
          const inputTokens = Math.floor(2_000 + rand() * 40_000);
          const cachedInputTokens = Math.floor(rand() * inputTokens * 0.5);
          const outputTokens = Math.floor(300 + rand() * 4_000);
          const total =
            BigInt(inputTokens) * usd(price.input) +
            BigInt(outputTokens) * usd(price.output) +
            BigInt(cachedInputTokens) * usd(price.cached);
          const costMicros = (total + 999_999n) / 1_000_000n;
          const idempotencyKey = `seed-${agent.externalId}-${day}-${i}`;

          await prisma.usageEvent.create({
            data: {
              organizationId: org.id,
              projectId: project.id,
              agentId: agent.id,
              idempotencyKey,
              provider: agent.provider,
              model: agent.model,
              inputTokens,
              outputTokens,
              cachedInputTokens,
              costMicros,
              latencyMs: Math.floor(400 + rand() * 9_000),
              status: rand() > 0.97 ? "ERROR" : "SUCCESS",
              occurredAt,
              ledgerEntry: {
                create: {
                  organizationId: org.id,
                  projectId: project.id,
                  agentId: agent.id,
                  type: "USAGE_DEBIT",
                  amountMicros: costMicros,
                  description: `${agent.provider}/${agent.model}`,
                },
              },
            },
          });
          created++;
        }
      }
    }
    await prisma.agent.updateMany({ where: { projectId: project.id }, data: { lastSeenAt: new Date() } });
    console.log(`Seeded ${created} historical usage events.`);
  }

  console.log("\nTollgate seed complete.");
  console.log(`  Organization: ${org.name} (${org.id})`);
  console.log(`  Project:      ${project.name} (${project.id})`);
  console.log(`  API key:      ${DEV_KEY}`);
  console.log("  Redis counters rebuild automatically from Postgres on first request.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
