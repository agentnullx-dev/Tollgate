# Tollgate

[![CI](https://github.com/agentnullx-dev/Tollgate/actions/workflows/ci.yml/badge.svg)](https://github.com/agentnullx-dev/Tollgate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs)

**Hard spending limits, a kill switch and runaway detection for AI agents.**

A buggy agent stuck in a retry loop can burn through a month of model budget
overnight, and most teams only find out when the invoice arrives. Tollgate
stops that before the money is spent.

- **Budgets that actually block:** caps per organization, project or agent (daily, weekly, monthly or lifetime), checked atomically before every model call.
- **Kill switch:** pause or stop any agent instantly; it takes effect on the very next request.
- **Runaway detection:** agents whose spend suddenly spikes more than 3σ above normal are quarantined automatically.
- **Alerts:** Slack, Microsoft Teams, email and signed webhooks at 50/80/90/100% of a budget, with retries when a provider is down.
- **Private by design:** only token counts and model names reach Tollgate; your prompts never pass through it.
- **Works with any provider:** Anthropic, OpenAI, Google or anything else you can price per token.
- **Team-ready:** single sign-on, admin/developer/viewer roles, audit logs and optional Stripe billing.

> New project: issues, ideas and pull requests are welcome.

## How it works

Agents ask Tollgate for permission before every model call with a worst-case
cost estimate. Tollgate atomically checks every budget that governs that agent
(organisation, project, agent), counts money already in flight, reserves the
estimate and answers allow or deny in one Redis round trip. After the call the
agent reports real token usage; Tollgate prices it, writes it to an
append-only ledger exactly once, and settles the reservation.

Two background engines run alongside the gateway:

* **Notification engine:** delivers alerts to Slack, Microsoft Teams, email and
  signed webhooks with an outbox, leased Redis queue, exponential backoff,
  circuit breakers and a dead-letter state.
* **Anomaly engine:** watches every agent's spend per minute and quarantines any
  agent whose 5-minute spend rate jumps more than 3σ above its baseline,
  recording a security incident in the ledger.

Docs:
* Product and market analysis: [`docs/PRODUCT.md`](docs/PRODUCT.md)
* Architecture, ERD and consistency model: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
* Notification engine: [`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md)
* Anomaly detection and quarantine: [`docs/ANOMALY_DETECTION.md`](docs/ANOMALY_DETECTION.md)
* Stripe billing lifecycle and role-based access: [`docs/BILLING_AND_ACCESS.md`](docs/BILLING_AND_ACCESS.md)

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

That starts Postgres, Redis and Mailpit, applies the schema, seeds a demo
organisation with two weeks of usage, and runs the app and the worker with hot
reload:

| URL | What |
|---|---|
| <http://localhost:3000/dashboard> | Operator console (sign in as `dev@acme.test`, `developer@acme.test` or `viewer@acme.test`) |
| <http://localhost:8025> | Mailpit inbox: every alert email lands here |
| <http://localhost:9100/metrics> | Worker Prometheus metrics |

The console runs a live simulation of a tenant (seven agents, 30 days of
history) built from the Prisma model types and the same pricing, budget,
backoff and detector code as the server. Try: switch "Billing reconciler" from
alert-only to strict blocking and watch it start getting blocked; click
"Simulate runaway" on an agent and watch it get quarantined; set Teams to
"Down" and watch deliveries back off.

The seed prints a development API key (also in `.env.example`):

```
tg_live_0123456789ab_devdevdevdevdevdevdevdevdevdevde
```

Run the end-to-end checks against the running stack:

```bash
./scripts/smoke.sh
```

Production-like images (web on port 3001, two worker replicas):

```bash
docker compose --profile prod up --build app-prod worker-prod
```

### Without Docker

```bash
npm install
docker compose up -d postgres redis   # or point .env at your own
npx prisma db push && npx prisma db seed
npm run dev          # web + API
npm run worker:dev   # notifications + anomaly engine
```

## Using it from an agent

```ts
const TG = "http://localhost:3000/api/v1";
const headers = { Authorization: `Bearer ${process.env.TOLLGATE_KEY}`, "Content-Type": "application/json" };

const gate = await fetch(`${TG}/authorize`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    agentKey: "support-triage",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    estimatedInputTokens: 6000,
    maxOutputTokens: 1024,
  }),
}).then((r) => r.json());

if (gate.decision === "DENY") throw new Error(gate.reason.message);

const completion = await callModel(/* ... */);

await fetch(`${TG}/usage`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    events: [{
      idempotencyKey: crypto.randomUUID(),
      reservationId: gate.reservationId,
      agentKey: "support-triage",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: completion.usage.input_tokens,
      outputTokens: completion.usage.output_tokens,
      cachedInputTokens: completion.usage.cache_read_input_tokens ?? 0,
    }],
  }),
});
```

Denials are returned as HTTP 200 with `decision: "DENY"` so clients can tell
"blocked by policy" apart from "gateway unreachable" and pick fail-open or
fail-closed behaviour for the latter.

## API reference

All `/api/v1` routes take `Authorization: Bearer <key>` (or `x-api-key`).
Every response carries `x-request-id`.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| POST | `/api/v1/authorize` | `gateway:authorize` | Pre-flight check and reservation |
| POST | `/api/v1/usage` | `usage:write` | Batch ingest (≤500 events), idempotent |
| GET | `/api/v1/usage` | `usage:read` | Aggregates by `day`, `agent` or `model` |
| GET | `/api/v1/budgets` | `budgets:read` | Budgets with live committed + in-flight spend |
| POST | `/api/v1/budgets` | `budgets:write` | Create a budget |
| GET/PATCH/DELETE | `/api/v1/budgets/:id` | `budgets:read` / `budgets:write` | Read, update, delete |
| POST | `/api/v1/budgets/:id/reconcile` | `budgets:write` | Rebuild the live counter from the ledger |
| GET/PATCH | `/api/v1/agents/:id` | `usage:read` / `agents:write` | Read, pause, stop, release quarantine (`org:admin`), set enforcement mode and rate limits |
| GET | `/api/v1/incidents` | `usage:read` | Security incidents from the anomaly engine |
| GET/POST | `/api/v1/notification-channels` | `org:admin` | List or create Slack, Teams, email, webhook channels |
| GET/PATCH/DELETE | `/api/v1/notification-channels/:id` | `org:admin` | Inspect (with 7-day delivery stats), update, delete |
| POST | `/api/v1/notification-channels/:id/test` | `org:admin` | Send a test notification synchronously |
| GET | `/api/health` | none | Database and Redis readiness |
| POST | `/api/webhooks/stripe` | Stripe signature | Billing lifecycle: plans, budgets, suspension and restoration |

Session-authenticated console API (cookie + role, same-origin only):

| Method | Path | Minimum role | Purpose |
|---|---|---|---|
| GET / POST | `/api/console/api-keys` | developer | List keys; create keys (elevated scopes need admin) |
| PATCH | `/api/console/agents/:id` | developer | Alert-only toggle and pause; stop, limits and quarantine release need admin |
| PATCH | `/api/console/budgets/:id` | admin | Limits, enforcement, on/off |
| GET / POST | `/api/console/notification-channels` | viewer / admin | View masked channels; enter webhook URLs and secrets |
| POST | `/api/session/active-org` | any member | Switch organization |

`org:admin` implies every scope and allows organisation-wide budgets.

### Authorize

```bash
curl -s localhost:3000/api/v1/authorize \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"agentKey":"code-migrator","provider":"anthropic","model":"claude-opus-4-1",
       "estimatedInputTokens":30000,"maxOutputTokens":4000}'
```

```json
{
  "decision": "ALLOW",
  "reservationId": "res_4f0c9e2d6b3a4f1e8c7d6b5a4f3e2d1c",
  "expiresAt": "2026-10-03T14:25:00.000Z",
  "estimatedCostMicros": "750000",
  "estimatedCostUsd": 0.75,
  "reason": null,
  "agent": { "id": "cm1...", "externalId": "code-migrator", "status": "ACTIVE" },
  "budgetsEvaluated": [
    { "budgetId": "cm2...", "name": "Company monthly cap", "periodKey": "m:2026-10", "enforcement": "BLOCK" }
  ]
}
```

A denial explains which budget blocked and by how much:

```json
{
  "decision": "DENY",
  "reason": {
    "code": "BUDGET_EXCEEDED",
    "message": "Code migrator daily does not have enough headroom for this request.",
    "budgetName": "Code migrator daily",
    "limitUsd": 45, "committedUsd": 44.61, "reservedUsd": 0.31, "headroomUsd": 0.08
  }
}
```

Other denial codes: `AGENT_PAUSED`, `AGENT_KILLED`, `AGENT_QUARANTINED`, `VELOCITY_LIMIT`, `BILLING_SUSPENDED`.

### Enforcement modes

Each agent runs in `STRICT` mode (blocking budgets refuse its requests) or
`ALERT_ONLY` mode (budgets are evaluated and reserved, but over-limit requests
are allowed and raise a `BUDGET_LIMIT_BYPASSED` alert). Switch instantly:

```bash
curl -s -X PATCH localhost:3000/api/v1/agents/<agent id> \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"enforcementMode":"STRICT"}'
```

Allowed responses include `overLimit` when a request went past a limit without being blocked.

### Create a budget

```bash
curl -s localhost:3000/api/v1/budgets \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"Support daily","scope":"AGENT","agentId":"<agent id>",
       "period":"DAILY","limitUsd":25,"enforcement":"BLOCK","alertThresholds":[50,80,100]}'
```

### Stop an agent

```bash
curl -s -X PATCH localhost:3000/api/v1/agents/<agent id> \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"status":"KILLED","reason":"Retry loop on billing tool"}'
```

### Errors

Every error uses one envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed.",
    "requestId": "8f6c...",
    "details": [{ "path": "maxOutputTokens", "message": "maxOutputTokens must be greater than zero.", "code": "custom" }]
  }
}
```

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed JSON, empty body |
| 401 | `UNAUTHORIZED` | Missing, malformed, revoked or expired key |
| 403 | `FORBIDDEN` | Missing scope, or touching another project's resources |
| 404 | `NOT_FOUND` | Resource not visible to this key |
| 409 | `CONFLICT` | Unique constraint, budget quota |
| 413 | `PAYLOAD_TOO_LARGE` | Body over the route limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Not `application/json` |
| 422 | `VALIDATION_FAILED` / `UNKNOWN_MODEL` | Schema violations, unpriced model |
| 429 | `RATE_LIMITED` | Per-key limit; `Retry-After` header set |
| 503 | `SERVICE_UNAVAILABLE` | Postgres or Redis unreachable |

### Notifications

Create channels with `POST /api/v1/notification-channels` (see
[`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md)). Generic webhooks are signed:

```
x-tollgate-signature: sha256=HMAC_SHA256(secret, "<x-tollgate-timestamp>.<raw body>")
```

## Project layout

```
prisma/
  schema.prisma          data model (Phase 2)
  seed.ts                demo org, key, prices, agents, budgets, history
src/
  app/
    api/health/          readiness probe
    api/v1/authorize/    pre-flight gate
    api/v1/usage/        ingestion + analytics
    api/v1/budgets/      CRUD + reconcile
    api/v1/agents/       kill switch, enforcement mode, quarantine release
    api/v1/incidents/    security incidents
    api/v1/notification-channels/  channel management and test sends
    api/webhooks/stripe/ Stripe billing lifecycle
    api/console/         session-authenticated console API (RBAC)
    api/auth/, api/session/  Auth.js handlers, claim refresh, org switching
    login/, forbidden/   sign-in and access-denied pages
    dashboard/           operator console
  components/console/    console UI (trends, budgets, agents, incidents, notifications)
  middleware.ts          edge gate: sessions, tenants, roles, CSRF
  auth.ts, auth.config.ts  Auth.js (Node + edge-safe configs)
  worker/
    index.ts             worker process: health, metrics, graceful shutdown
    notification-worker.ts  stream consumer, fan-out, dispatcher, reaper, reconciler
    anomaly-engine.ts    leader-elected detection loop
  lib/
    anomaly/             detector (pure), metric store, profiles, quarantine
    notifications/       context, renderers, transports, queue, circuit breaker
    sim/                 schema-typed simulation engine and mock transport
    agent-transitions.ts agent state machine (shared by server and UI)
    crypto.ts, url-guard.ts  secret encryption and SSRF protection
    rbac.ts              roles, permissions, fail-closed route table (edge-safe)
    session.ts           authoritative session context and handler wrapper
    billing/             plan rules, Stripe client, billing gate, lifecycle
    http.ts              route wrapper, error mapping, body/query parsing
    auth.ts              API keys, scopes, rate limiting
    redis.ts             client + Lua scripts
    schemas.ts           Zod validation
    money.ts, periods.ts exact pricing and UTC budget windows
    services/            budgets engine, agents, pricing, alerts, webhooks, audit
  types/api.ts           wire types shared by API and UI
scripts/smoke.sh         end-to-end checks
```

## Production checklist

* Switch from `prisma db push` to migrations: `npx prisma migrate dev --name init`
  locally, commit `prisma/migrations`, run `npm run db:deploy` on release.
* Redis: standalone or Sentinel, `maxmemory-policy noeviction`, AOF on.
  Cluster mode is not supported because budget scripts touch several keys.
* Schedule `POST /api/v1/budgets/:id/reconcile` (or call `reconcileBudget`
  from a worker) hourly to bound drift after incidents.
* Keep `model_prices` in sync with provider pricing pages. New prices take
  effect at `effectiveFrom` without rewriting history.
* Put the dashboard behind Auth.js; the `users`, `accounts`, `sessions` and
  `verification_tokens` tables are already compatible with the Prisma adapter.
* Set `NOTIFICATION_ENCRYPTION_KEY` (`openssl rand -base64 32`) and keep it in a
  secret manager; rotating it requires re-creating channels.
* Set `AUTH_SECRET`, at least one identity provider, and keep `AUTH_DEV_LOGIN` unset.
* Create a Stripe webhook endpoint for the events in `docs/BILLING_AND_ACCESS.md`
  and set `STRIPE_WEBHOOK_SECRET`; decide on `BILLING_SUSPEND_POLICY`.
* Run at least two worker replicas. Alert on dead-letter growth and on
  `tollgate_anomaly_leader` summing to zero.
