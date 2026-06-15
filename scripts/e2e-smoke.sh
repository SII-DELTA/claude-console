#!/usr/bin/env bash
# End-to-end smoke test against a running local-agent instance.
#
# Usage:
#   BASE_URL=http://localhost:7345 PAIR_CODE=12345678 ./scripts/e2e-smoke.sh
#
# This script does NOT start the agent — start it first via `pnpm --filter @mac/local-agent dev`
# and obtain an 8-digit pair code from the CLI output.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:7345}"
PAIR_CODE="${PAIR_CODE:?PAIR_CODE env var is required (8 digits from local-agent CLI)}"
DEVICE_NAME="${DEVICE_NAME:-smoke-test}"

need() { command -v "$1" >/dev/null || { echo "missing tool: $1" >&2; exit 1; }; }
need curl
need jq

api() { curl -fsS "$@"; }

echo "[1/6] /health"
api "$BASE_URL/health" | jq .

echo "[2/6] /auth/pair"
PAIR_RESP=$(api -X POST "$BASE_URL/auth/pair" \
  -H "content-type: application/json" \
  -d "{\"pairCode\":\"$PAIR_CODE\",\"deviceName\":\"$DEVICE_NAME\",\"platform\":\"web\"}")
TOKEN=$(echo "$PAIR_RESP" | jq -r .token)
[ "$TOKEN" != "null" ] || { echo "pair failed: $PAIR_RESP" >&2; exit 1; }
echo "  ok, token length = ${#TOKEN}"

AUTH=( -H "authorization: Bearer $TOKEN" )

echo "[3/6] POST /sessions"
CREATE=$(api "${AUTH[@]}" -X POST "$BASE_URL/sessions" \
  -H "content-type: application/json" \
  -d '{"title":"smoke","type":"shell","command":"echo hello && sleep 1","cwd":"."}')
SID=$(echo "$CREATE" | jq -r .id)
echo "  created session $SID"

echo "[4/6] POST /sessions/$SID/input"
api "${AUTH[@]}" -X POST "$BASE_URL/sessions/$SID/input" \
  -H "content-type: application/json" \
  -d '{"input":"echo from-smoke\n"}' >/dev/null
echo "  input sent"

sleep 1

echo "[5/6] GET /sessions/$SID/logs"
api "${AUTH[@]}" "$BASE_URL/sessions/$SID/logs?limit=20" | jq 'length as $n | "  log entries: \($n)"' -r

echo "[6/6] DELETE /sessions/$SID"
api "${AUTH[@]}" -X DELETE "$BASE_URL/sessions/$SID" >/dev/null
echo "  deleted"

echo "✓ smoke ok"
