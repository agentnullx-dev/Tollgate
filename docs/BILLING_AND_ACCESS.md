# Billing lifecycle and access control

## Stripe webhook (`POST /api/webhooks/stripe`)

```mermaid
sequenceDiagram
    participant S as Stripe
    participant W as /api/webhooks/stripe
    participant DB as Postgres
    participant G as /authorize
    S->>W: event (raw body + Stripe-Signature)
    W->>W: constructEvent(raw, sig, whsec, 300 s) + livemode check
    W->>DB: INSERT stripe_events(id) (claim; duplicates stop here)
    alt invoice.payment_failed (policy says suspend)
        W->>DB: organization.billingStatus = SUSPENDED
        Note over G: every request now denied: BILLING_SUSPENDED
        loop batches of 100 ACTIVE agents
            W->>DB: transitionAgentStatus(→ KILLED, "[billing] …") + audit
            W->>DB: billing_suspensions.agentIds += stopped
        end
        W->>DB: BILLING_SUSPENDED alert → notification engine
    else invoice.paid
        W->>DB: lift suspensions caused by this invoice
        W->>DB: revive only agents still KILLED with a "[billing]" reason
    else customer.subscription.*
        W->>DB: plan, status, period end, billing-managed monthly ceiling
    end
    W-->>S: 200 (done / ignored / duplicate) or 500 (retry)
```

| Event | Effect |
|---|---|
| `checkout.session.completed` | Links the Stripe customer to the organization in `client_reference_id`, then syncs the subscription (never re-points an org already linked to another customer) |
| `customer.subscription.created/updated/resumed` | Plan from price metadata `tollgate_plan`, product metadata, lookup key `tollgate_<plan>_*`, or `STRIPE_PRICE_PLAN_MAP`; status; billing-managed budget |
| `customer.subscription.paused`, status `unpaid` | Suspension (unless policy is `never`) |
| `customer.subscription.deleted` | Downgrade to Free with its ceiling; lifts any suspension |
| `invoice.payment_failed` | `PAST_DUE`, and suspension per `BILLING_SUSPEND_POLICY` |
| `invoice.paid`, `invoice.payment_succeeded` | Lifts suspensions caused by that invoice; restores agents when none remain |

Plan ceilings (overridable per customer with subscription metadata
`tollgate_monthly_cap_usd`): Free $50, Team $2,000, Business $25,000,
Enterprise none. The ceiling is an ORGANIZATION / MONTHLY / BLOCK budget with
`managedBy = "billing"`; it cannot be edited or deleted by hand.

**Guarantees.** Signatures are verified on the raw body with a 300 s replay
window. The event id is the primary key of `stripe_events`, so a redelivered
event is acknowledged without reprocessing; failed events are re-claimed on
Stripe's retry, and claims abandoned by a crashed instance are reclaimed after
five minutes. Subscription events older than the last applied one are ignored
(Stripe does not guarantee order). Suspension sweeps are idempotent and resume
on retry.

**Choosing a policy.** `immediate` (the default, as specified) stops agents on
the first failed attempt. Card declines are often transient and Stripe retries
automatically, so for most B2B customers `final_attempt` is the gentler choice:
the organization is `PAST_DUE` during retries and suspended only when Stripe
gives up.

Local testing:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe   # prints whsec_…
stripe trigger invoice.payment_failed
```

## Access control

| Role | DB roles | Can |
|---|---|---|
| `org:viewer` | VIEWER | View the console: charts, budgets, agents, incidents, alerts |
| `org:developer` | DEVELOPER | Viewer + create API keys (gateway/read scopes) + switch agents between strict blocking and alert-only + pause/resume |
| `org:admin` | OWNER, ADMIN | Everything: limits and budgets, stopping agents, webhook URLs/secrets and encryption keys, releasing quarantines, elevated API key scopes, members, billing |

Three layers, each sufficient to deny:

1. **Middleware (Edge).** Fail-closed route table; session required for
   protected routes; tenant resolved from the user's own memberships (a tampered
   `tg_org` cookie cannot switch tenants); permission check; same-origin check
   for cookie-authenticated mutations; client-supplied `x-tollgate-*` headers
   stripped. Membership claims in the JWT older than five minutes are refreshed
   through `/api/session/refresh` before page access.
2. **Route handlers.** `withSessionHandler` re-reads membership and role from
   Postgres on every call and applies field-level rules (a developer may toggle
   alert-only on the same endpoint where only an admin may stop an agent or
   release a quarantine). Removing a member or disabling a user
   (`users.disabledAt`) takes effect on the next request.
3. **Pages.** `requirePageContext` does the same for server components, and the
   console only renders controls the role allows.

Do not treat middleware as the only check: it runs at the edge without the
database, and Next.js has shipped middleware bypass vulnerabilities before
(CVE-2025-29927, fixed in 15.2.3; this project requires ^15.3). The route
handlers are the authority.

Identity providers: Microsoft Entra ID, Google and GitHub are enabled when their
`AUTH_*` credentials are set. `AUTH_DEV_LOGIN=true` enables an email-only login
for seeded users in non-production builds (`dev@acme.test` admin,
`developer@acme.test`, `viewer@acme.test`).
