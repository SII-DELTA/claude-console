#!/usr/bin/env bash
# Start local-agent (api+ws) and the Next.js web app concurrently for local development.
set -euo pipefail
cd "$(dirname "$0")/.."

cleanup() {
  echo "[dev] shutting down…"
  kill 0 || true
}
trap cleanup EXIT INT TERM

echo "[dev] starting @mac/local-agent on :7345"
pnpm --filter @mac/local-agent dev &

echo "[dev] starting @mac/web on :3000"
pnpm --filter @mac/web dev &

wait
