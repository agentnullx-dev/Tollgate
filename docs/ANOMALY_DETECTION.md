# Layer 3: Statistical threat detection and quarantine

## What it detects

Runaway agents: retry loops, recursive planners, prompt-injection-driven tool
abuse, or leaked keys, all of which appear as a sudden jump in spend rate.

## Data path

1. `POST /api/v1/usage` records settled cost, requests and tokens per agent per
   minute in Redis (hourly hashes, 4-hour retention).
2. The worker's anomaly engine (one elected leader across replicas) ticks every
   15 s and loads the last 80 minutes for every recently active agent.
3. It evaluates every 5-minute window that ended since its previous tick, so
   no window is skipped during restarts or slow ticks (up to 15 minutes of catch-up).

## The test

For the window ending at minute t:

```
window_mean = spend(t−4 … t) / 5

for each baseline B in { rolling (previous 60 min, zero-filled),
                         long-term (EWMA, ≈1-day span) }:
    σ_eff(B)    = max(σ_B, 0.25·μ_B, $0.002/min)
    threshold_B = μ_B + 3·σ_eff(B)

anomalous ⇔ window_mean > max_B(threshold_B)  AND  window spend ≥ $1
z = (window_mean − μ_gov) / σ_eff(gov)        (gov = baseline with the higher threshold)
```

Design choices:

* **Two baselines, the more permissive wins.** The rolling baseline catches
  spikes against recent behaviour; the long-term profile prevents false
  positives when an agent that was idle for an hour resumes its normal workload.
* **Variance floors** keep a near-constant baseline (σ≈0) from flagging trivial
  changes.
* **Materiality floor** ignores statistically large but financially trivial spikes.
* **Poisoning resistance:** minutes folded into the long-term profile are
  winsorized at μ+3σ, so ramping spend in steps cannot drag the baseline up.
* **Warm-up:** no verdicts until 30 minutes of history. Missing profiles are
  rebuilt from `usage_events` in Postgres.
* **Tokens per request** is tracked too; a drift beyond 3σ without a spend spike
  raises a WARNING `ANOMALY_DETECTED` alert but does not quarantine.

## Quarantine

On an anomalous verdict for an ACTIVE or PAUSED agent, one database transaction:

1. moves the agent to `QUARANTINED` through the same state machine the kill
   switch uses (compare-and-set on the previous status),
2. writes a `security_incidents` row with the full evidence (both baselines,
   window spend, z-score, detector version),
3. appends an immutable zero-amount `SECURITY_INCIDENT` ledger entry linked to
   the incident,
4. writes an audit log entry with actor `SYSTEM / anomaly-engine`,
5. creates a CRITICAL `AGENT_QUARANTINED` alert, which the notification engine delivers.

The agent cache is then invalidated, so the very next `POST /authorize`
returns `DENY` with `AGENT_QUARANTINED`. The incident `dedupeKey`
(`anomaly:<agent>:<window end>`) makes the operation idempotent across replicas.

Releasing requires `org:admin` and a reason:

```bash
curl -s -X PATCH localhost:3000/api/v1/agents/<id> -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"ACTIVE","reason":"Retry loop fixed in 4.2.1","incidentResolution":"RESOLVED"}'
```

Open incidents are closed as `RESOLVED` or `FALSE_POSITIVE`.

## Measured behaviour

Measured with the dashboard simulation, which runs this exact detector code on
Poisson traffic with daily and weekly seasonality:

| Scenario | Result |
|---|---|
| Normal traffic, 5 seeds × 24 h × 6 agents (720 agent-hours) | 0 false positives |
| Sustained 10× spend-rate jump | Quarantined in 4/4 trials per agent, ~2 min |
| Sustained 5× jump | Quarantined in 11/12 trials, ~3–5 min |
| Sustained 3× jump | Caught occasionally (3/12) |
| Sustained 2× jump | Not caught (by design; budgets and threshold alerts cover gradual drift) |
| 30× jump on an agent with a velocity limit | Usually stopped first by the velocity guard |

Tune with `ANOMALY_SIGMA`, `ANOMALY_WINDOW_MINUTES`, `ANOMALY_BASELINE_MINUTES`
and `ANOMALY_MIN_WINDOW_SPEND_USD`. Set `ANOMALY_AUTO_QUARANTINE=false` to
record incidents and alert without blocking.
