# Phase 1: Market gap analysis

## Where the pain is in 2026

The defining shift of 2025–2026 is that LLM usage moved from chat features to
autonomous agents: coding agents, support triage, research pipelines, browser
agents and back-office automations that call models in loops, call tools, and
spawn sub-agents. Three properties of agentic workloads create problems that
the existing tooling was not built for:

1. **Spend is decided at runtime by the agent, not by the developer.** A retry
   loop, a recursive planner or a tool that returns an error forever can burn
   through a month of budget overnight.
2. **Costs are spread across providers and teams.** Most companies route to two
   or three model vendors, and finance wants spend attributed to the team, the
   product and the individual agent.
3. **Data sensitivity rose with autonomy.** Agents read tickets, contracts and
   code, so anything sitting in the request path is now a security review.

## Three candidate niches

### 1. Spend governance and runaway protection for AI agents

* **Pain.** Provider consoles offer organisation-wide limits and alerts that are
  coarse and arrive after the money is spent. Observability platforms (tracing
  and evaluation tools) record what happened; they are not designed to *refuse*
  the next request. Some AI gateways offer per-key budgets, but they require
  routing every token through a proxy and typically check spend that is
  already settled, so many concurrent requests can pass a check that each of
  them individually satisfies and overshoot the limit together.
* **Gap.** A provider-agnostic *control plane* that answers one question in a
  few milliseconds before every model call: "may this agent spend up to $X
  right now?", across nested budgets (organisation, project, agent), counting
  money that is already in flight, with kill switches and loop detection.
* **Buyers.** Engineering leads running agents in production and the finance or
  FinOps people who get the bill.

### 2. Compliance evidence for AI deployers

* **Pain.** EU AI Act obligations for deployers are phasing in through 2026 and
  2027 (with timelines subject to ongoing EU simplification proposals), and
  procurement teams already ask for model inventories, usage logs and human
  oversight records.
* **Gap.** Lightweight evidence collection: which models are used where, by
  which system, with what oversight, exported in the shape auditors ask for.
* **Why not now.** Real demand, but long sales cycles, regulatory uncertainty
  and a buyer (legal/compliance) that is slow to adopt developer tooling.

### 3. Local-first PII redaction for prompts

* **Pain.** Teams want to send customer data to frontier models without the raw
  identifiers leaving their network.
* **Gap.** A small on-premises or edge service that detects and tokenises PII
  before the call and restores it in the response.
* **Why not now.** Detection quality is the whole product, cloud providers are
  bundling redaction features, and differentiation erodes quickly.

## Scoring

| Criterion (1–5)                 | Spend governance | Compliance evidence | PII redaction |
|---------------------------------|:---------------:|:-------------------:|:-------------:|
| Pain intensity                  | 5               | 4                   | 3             |
| Willingness to pay (clear ROI)  | 5               | 3                   | 3             |
| Time to value                   | 5               | 2                   | 4             |
| Defensibility                   | 4               | 3                   | 2             |
| Build complexity (5 = simplest) | 4               | 3                   | 3             |
| **Total**                       | **23**          | **15**              | **15**        |

Spend governance wins because the ROI is directly measurable: one prevented
runaway loop pays for a year of the product.

## The product: Tollgate

**Tollgate is a pre-flight spend gate for AI agents.** Before every model call
an agent asks Tollgate for permission with a worst-case cost estimate; Tollgate
atomically checks every budget that governs that agent, reserves the money, and
answers allow or deny. After the call, the agent reports actual token usage;
Tollgate prices it, writes it to an append-only ledger exactly once, releases
the reservation and commits the real cost.

### Value proposition

> Hard spend limits and kill switches for every agent, enforced before the
> money is spent, without routing your prompts through anyone.

### Why the gap exists

* **Observability vendors** built for after-the-fact analysis; adding a blocking,
  sub-10 ms decision path with strict consistency is a different product.
* **Model providers** have no incentive to make it easy to spend less, and
  cannot see across competing providers.
* **Proxy gateways** solve routing and caching, and treat budgets as a feature.
  Requiring the full token stream to pass through them is a security review
  and a latency tax many teams refuse.
* **Concurrency is the hard part.** Correct enforcement needs atomic
  check-and-reserve across several nested budgets with in-flight accounting,
  which is easy to get subtly wrong and is where Tollgate's engine lives.

### How Tollgate solves it

| Capability | Mechanism |
|---|---|
| No overshoot under concurrency | Single Redis Lua script checks committed + in-flight + estimate for every applicable budget and reserves on all of them, or none |
| Hierarchical budgets | Organisation, project and agent budgets; daily, weekly, monthly or lifetime; block or alert-only |
| Runaway loop protection | Per-agent requests-per-minute guard with optional automatic stop |
| Kill switch | Pause or stop any agent; takes effect on the very next request |
| Exactly-once accounting | Idempotency keys enforced by a unique index; usage and ledger debit in one insert |
| Self-healing counters | Postgres is the source of truth; missing Redis counters rebuild from the ledger; reconcile endpoint |
| Privacy | Only token counts and model names are sent. Prompts never touch Tollgate |
| Alerting | Threshold crossings, blocks and stops, de-duplicated in the database, delivered via signed webhooks |

### Monetisation

Price on governed requests, not on a percentage of model spend, so Tollgate is
never rewarded for customers spending more.

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | 1 project, 100k governed requests/month, 7-day history |
| Team | $149/month | 10 projects, 5M requests, webhooks, 90-day history |
| Business | $799/month + usage | Unlimited projects, SSO, audit export, chargeback reports |
| Enterprise | Custom | Self-hosted control plane, SLA, dedicated support |

Expansion levers: chargeback reports for finance, model-routing suggestions
("this agent could run on a cheaper model"), and anomaly detection on per-agent
spend curves.
