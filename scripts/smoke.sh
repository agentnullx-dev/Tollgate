#!/usr/bin/env bash
# End-to-end smoke test: authorize -> settle -> idempotent retry -> query -> kill switch.
# Usage: BASE_URL=http://localhost:3000 API_KEY=tg_live_... ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-tg_live_0123456789ab_devdevdevdevdevdevdevdevdevdevde}"
AUTH=(-H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json")
AGENT="smoke-agent-$(date +%s)"

fail() { echo "FAIL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || fail "missing dependency: $1"; }
need curl
need jq

echo "1. Health"
curl -fsS "${BASE_URL}/api/health" | jq -e '.status == "ok"' >/dev/null || fail "health check"

echo "2. Authorize"
AUTHZ=$(curl -fsS "${AUTH[@]}" -X POST "${BASE_URL}/api/v1/authorize" -d @- <<JSON
{"agentKey":"${AGENT}","agentName":"Smoke test","provider":"anthropic","model":"claude-haiku-4-5",
 "estimatedInputTokens":4000,"maxOutputTokens":1000}
JSON
)
echo "$AUTHZ" | jq -e '.decision == "ALLOW"' >/dev/null || fail "authorize: $AUTHZ"
RES_ID=$(echo "$AUTHZ" | jq -r '.reservationId')
AGENT_ID=$(echo "$AUTHZ" | jq -r '.agent.id')

echo "3. Settle usage"
IDEM="smoke-${RES_ID}"
BODY=$(jq -n --arg k "$IDEM" --arg r "$RES_ID" --arg a "$AGENT" \
  '{events:[{idempotencyKey:$k,reservationId:$r,agentKey:$a,provider:"anthropic",model:"claude-haiku-4-5",inputTokens:3800,outputTokens:640,latencyMs:1820}]}')
INGEST=$(curl -fsS "${AUTH[@]}" -X POST "${BASE_URL}/api/v1/usage" -d "$BODY")
echo "$INGEST" | jq -e '.summary.accepted == 1' >/dev/null || fail "ingest: $INGEST"

echo "4. Idempotent retry"
RETRY=$(curl -fsS "${AUTH[@]}" -X POST "${BASE_URL}/api/v1/usage" -d "$BODY")
echo "$RETRY" | jq -e '.summary.duplicate == 1 and .summary.accepted == 0' >/dev/null || fail "retry: $RETRY"

echo "5. Query usage"
curl -fsS "${AUTH[@]}" "${BASE_URL}/api/v1/usage?groupBy=agent" | jq -e '.totals.requests >= 1' >/dev/null || fail "usage query"

echo "6. Validation errors are structured"
CODE=$(curl -s -o /tmp/tg_err.json -w '%{http_code}' "${AUTH[@]}" -X POST "${BASE_URL}/api/v1/authorize" -d '{"agentKey":""}')
[ "$CODE" = "422" ] || fail "expected 422, got $CODE"
jq -e '.error.code == "VALIDATION_FAILED"' /tmp/tg_err.json >/dev/null || fail "error envelope"

echo "7. Kill switch"
curl -fsS "${AUTH[@]}" -X PATCH "${BASE_URL}/api/v1/agents/${AGENT_ID}" \
  -d '{"status":"KILLED","reason":"smoke test"}' | jq -e '.data.status == "KILLED"' >/dev/null || fail "kill"
DENIED=$(curl -fsS "${AUTH[@]}" -X POST "${BASE_URL}/api/v1/authorize" -d @- <<JSON
{"agentKey":"${AGENT}","provider":"anthropic","model":"claude-haiku-4-5","estimatedInputTokens":10,"maxOutputTokens":10}
JSON
)
echo "$DENIED" | jq -e '.decision == "DENY" and .reason.code == "AGENT_KILLED"' >/dev/null || fail "kill not enforced: $DENIED"

echo "8. Budgets list"
curl -fsS "${AUTH[@]}" "${BASE_URL}/api/v1/budgets" | jq -e '.data | length >= 1' >/dev/null || fail "budgets"

echo "All smoke checks passed."
