# Phase 2: System architecture

## Stack

| Layer | Choice | Why |
|---|---|---|
| Web + API | Next.js 15 App Router, TypeScript (strict) | One deployable for dashboard and API, route handlers on the Node runtime |
| Styling | Tailwind CSS 3 | Design tokens in config, no runtime CSS |
| Validation | Zod | Runtime validation that also produces the TypeScript types |
| Database | PostgreSQL 16 via Prisma 6 | Source of truth: ledger, usage, budgets, audit |
| Hot path | Redis 7 (Lua scripts) | Atomic multi-budget check-and-reserve in one round trip |
| Charts | Recharts | Declarative, responsive |
| Runtime | Docker (Node 22 Alpine), standalone Next output | Small, non-root image |
| CI | GitHub Actions | Typecheck, unit tests, build, end-to-end smoke test, image publish |

Money is stored as **BigInt micro-USD** everywhere (1 USD = 1,000,000 micros).
Costs round up to the next micro so spend is never under-reported.

## Processes

| Process | Image target | Scales | Responsibilities |
|---|---|---|---|
| Web + API | `runner` | Horizontally, stateless | Gateway (`/authorize`, `/usage`), management API, dashboard |
| Worker | `worker` | Horizontally | Notification engine (all replicas share the queue); anomaly engine (single elected leader) |

See [NOTIFICATIONS.md](NOTIFICATIONS.md) and [ANOMALY_DETECTION.md](ANOMALY_DETECTION.md).

## Request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent (customer code)
    participant T as Tollgate API
    participant R as Redis
    participant P as Postgres
    participant M as Model provider

    A->>T: POST /api/v1/authorize (agent, model, est. tokens)
    T->>R: API key, agent, budgets (read-through cache)
    T->>R: velocity counter INCR
    T->>R: EVAL authorize.lua (check + reserve on all budgets)
    alt headroom available
        R-->>T: allowed, reservation stored
        T-->>A: ALLOW + reservationId
        A->>M: model call (prompt never touches Tollgate)
        M-->>A: completion + token usage
        A->>T: POST /api/v1/usage (idempotencyKey, reservationId, tokens)
        T->>P: INSERT usage_event + ledger_entry (unique idempotency key)
        T->>R: EVAL settle.lua (release reservation, commit actual cost)
        T->>P: INSERT alerts ON CONFLICT DO NOTHING
        T-->>A: accepted
    else a blocking budget would be exceeded
        R-->>T: denied, blocking budget
        T->>P: BUDGET_BLOCKED alert (de-duplicated)
        T-->>A: DENY + reason
    end
```

## Consistency model

* **Postgres** holds every usage event and ledger entry. A unique index on
  `(projectId, idempotencyKey)` makes ingestion exactly-once.
* **Redis** holds, per budget and period, a committed counter and a sorted set
  of in-flight reservations scored by expiry. Expired reservations are swept
  inside the authorize script, so a crashed agent can never hold headroom
  forever.
* **Recovery.** If a committed counter is missing it is rebuilt from Postgres
  with `SET NX`. If settlement fails after the database insert, the affected
  counters are deleted so the next request rebuilds them.
  `POST /api/v1/budgets/:id/reconcile` forces a rebuild on demand.
* **Topology.** Multi-key scripts need all keys on one primary: run Redis
  standalone or with Sentinel, with `maxmemory-policy noeviction`.

## Entity relationship diagram

```mermaid
erDiagram
    User ||--o{ Account : "has"
    User ||--o{ Session : "has"
    User ||--o{ Membership : "belongs via"
    User ||--o{ ApiKey : "creates"
    Organization ||--o{ Membership : "has"
    Organization ||--o{ Project : "owns"
    Organization ||--o{ ApiKey : "owns"
    Organization ||--o{ Agent : "owns"
    Organization ||--o{ Budget : "defines"
    Organization ||--o{ UsageEvent : "records"
    Organization ||--o{ LedgerEntry : "books"
    Organization ||--o{ Alert : "raises"
    Organization ||--o{ AuditLog : "logs"
    Organization ||--o{ SecurityIncident : "records"
    Organization ||--o{ NotificationChannel : "configures"
    Agent ||--o{ SecurityIncident : "subject of"
    SecurityIncident ||--o| LedgerEntry : "marked in"
    SecurityIncident ||--o{ Alert : "raises"
    Alert ||--o{ NotificationDelivery : "delivered as"
    NotificationChannel ||--o{ NotificationDelivery : "receives"
    Organization ||--o{ StripeEvent : "billed by"
    Organization ||--o{ BillingSuspension : "suspended by"
    Project ||--o{ ApiKey : "scopes"
    Project ||--o{ Agent : "contains"
    Project ||--o{ Budget : "limited by"
    Project ||--o{ UsageEvent : "records"
    Project ||--o{ LedgerEntry : "books"
    Agent ||--o{ Budget : "limited by"
    Agent ||--o{ UsageEvent : "generates"
    Agent ||--o{ LedgerEntry : "charged"
    Agent ||--o{ Alert : "subject of"
    ApiKey ||--o{ UsageEvent : "reported"
    Budget ||--o{ Alert : "triggers"
    UsageEvent ||--o| LedgerEntry : "debits"

    User {
        string id PK
        string email UK
        string name
        datetime emailVerified
    }
    Account {
        string id PK
        string userId FK
        string provider
        string providerAccountId
    }
    Session {
        string id PK
        string sessionToken UK
        string userId FK
        datetime expires
    }
    VerificationToken {
        string identifier
        string token UK
        datetime expires
    }
    Organization {
        string id PK
        string slug UK
        enum plan
        enum billingStatus
        string stripeCustomerId UK
        string stripeSubscriptionId UK
        string webhookUrl
        string webhookSecret
    }
    Membership {
        string id PK
        string userId FK
        string organizationId FK
        enum role
    }
    Project {
        string id PK
        string organizationId FK
        string slug
        string environment
    }
    ApiKey {
        string id PK
        string projectId FK
        string prefix UK
        string hashedKey
        string_array scopes
        datetime revokedAt
    }
    Agent {
        string id PK
        string projectId FK
        string externalId
        enum status
        enum enforcementMode
        datetime quarantinedAt
        int maxRequestsPerMinute
        bool autoKillOnVelocity
    }
    Budget {
        string id PK
        enum scope
        string projectId FK
        string agentId FK
        enum period
        bigint limitMicros
        enum enforcement
        int_array alertThresholds
    }
    ModelPrice {
        string id PK
        string provider
        string model
        bigint inputMicrosPerMTok
        bigint outputMicrosPerMTok
        bigint cachedInputMicrosPerMTok
        datetime effectiveFrom
    }
    UsageEvent {
        string id PK
        string projectId FK
        string agentId FK
        string idempotencyKey
        string reservationId
        int inputTokens
        int outputTokens
        bigint costMicros
        datetime occurredAt
    }
    LedgerEntry {
        string id PK
        string usageEventId FK
        enum type
        bigint amountMicros
    }
    Alert {
        string id PK
        string budgetId FK
        string agentId FK
        enum type
        enum severity
        string dedupeKey UK
    }
    SecurityIncident {
        string id PK
        string agentId FK
        enum type
        enum status
        string dedupeKey UK
        bigint windowSpendMicros
        float baselineMeanMicros
        float thresholdMicros
        float zScore
        string actionTaken
        json evidence
    }
    NotificationChannel {
        string id PK
        enum type
        string targetCiphertext
        string targetHint
        enum minSeverity
        enum_array alertTypes
    }
    NotificationDelivery {
        string id PK
        string alertId FK
        string channelId FK
        enum status
        int attempts
        datetime nextAttemptAt
        string lastError
    }
    StripeEvent {
        string id PK
        string type
        enum status
        int attempts
        string outcome
    }
    BillingSuspension {
        string id PK
        string organizationId FK
        string stripeInvoiceId
        string sourceEventId
        string_array agentIds
        datetime liftedAt
    }
    AuditLog {
        string id PK
        enum actorType
        string action
        string targetType
        string targetId
        json before
        json after
    }
```

`ModelPrice` and `VerificationToken` have no foreign keys: prices are looked
up by `(provider, model)` with the newest `effectiveFrom` that is not in the
future, so price changes never rewrite historical costs.

## Redis key layout

| Key | Type | Purpose |
|---|---|---|
| `tg:b:<budgetId>:<period>:c` | string | Committed micros for the period |
| `tg:b:<budgetId>:<period>:r` | zset | In-flight reservations, member `<resId>:<micros>`, score = expiry |
| `tg:res:<resId>` | string (JSON) | Reservation record used at settlement |
| `tg:vel:<agentId>:<minute>` | string | Velocity counter |
| `tg:rl:<apiKeyId>:<minute>` | string | API rate limit counter |
| `tg:cache:*` | string (JSON) | Read-through caches for keys, agents, budgets |
| `tg:stream:alerts` | stream | New alerts for the notification consumer group |
| `tg:notify:due` / `:inflight` | zset | Delayed delivery queue and leases |
| `tg:notify:dead` | list | Dead-letter log (last 10,000) |
| `tg:cb:<channelId>` | hash | Circuit breaker state |
| `tg:am:<agentId>:<hour>` | hash | Per-minute spend, requests, tokens for anomaly detection |
| `tg:ap:<agentId>` | hash | Long-term EWMA anomaly profile |
| `tg:lock:anomaly-engine` | string | Leader lease |

Period keys: `d:2026-10-03`, `w:2026-09-28` (ISO week starting Monday),
`m:2026-10`, or `all` for lifetime budgets. All windows are UTC.
