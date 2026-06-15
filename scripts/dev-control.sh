#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.logs"

# Read a numeric key from the root .env (if present). Explicit environment wins,
# then .env, then the built-in default.
_envfile="$ROOT_DIR/.env"
_port_from_env() { [[ -f "$_envfile" ]] && grep -E "^$1=" "$_envfile" 2>/dev/null | tail -1 | cut -d= -f2- | tr -dc '0-9'; true; }

WEB_PORT="${WEB_PORT:-$(_port_from_env WEB_PORT)}"; WEB_PORT="${WEB_PORT:-3005}"
AGENT_PORT="${AGENT_PORT:-$(_port_from_env AGENT_PORT)}"; AGENT_PORT="${AGENT_PORT:-7345}"
# Agent's HTTPS port behind `tailscale serve`; baked into the web build so the
# client auto-fills it on *.ts.net (see apps/web ConnectForm defaultAgentUrl).
AGENT_HTTPS_PORT="${AGENT_HTTPS_PORT:-$(_port_from_env AGENT_HTTPS_PORT)}"; AGENT_HTTPS_PORT="${AGENT_HTTPS_PORT:-8443}"
export NEXT_PUBLIC_AGENT_HTTPS_PORT="$AGENT_HTTPS_PORT"
# WEB_MODE: prod = next build + next start（正式）；dev = next dev（本地调试）
WEB_MODE="${WEB_MODE:-prod}"
WEB_LABEL="com.nexra.agent-console.web"
AGENT_LABEL="com.nexra.agent-console.local-agent"
WEB_SCREEN="nexra-agent-console-web"
AGENT_SCREEN="nexra-agent-console-agent"

mkdir -p "$LOG_DIR"

usage() {
  cat <<EOF
Usage:
  scripts/dev-control.sh <start|stop|restart|status> <web|agent|all>

Environment:
  WEB_PORT=$WEB_PORT
  AGENT_PORT=$AGENT_PORT
EOF
}

main() {
  local action="${1:-}"
  local service="${2:-all}"

  case "$action:$service" in
    start:web) start_web ;;
    start:agent) start_agent ;;
    start:all) start_agent; start_web ;;
    stop:web) stop_web ;;
    stop:agent) stop_agent ;;
    stop:all) stop_web; stop_agent ;;
    restart:web) stop_web; start_web ;;
    restart:agent) stop_agent; start_agent ;;
    restart:all) stop_web; stop_agent; start_agent; start_web ;;
    status:web) status_web ;;
    status:agent) status_agent ;;
    status:all) status_agent; status_web ;;
    *) usage; exit 2 ;;
  esac
}

start_web() {
  if [[ "$WEB_MODE" == "prod" ]]; then
    start_web_prod
  else
    start_web_dev
  fi
}

start_web_dev() {
  echo "[dev-control] starting web (dev / next dev) on :$WEB_PORT"
  rm -rf "$ROOT_DIR/apps/web/.next-dev"
  run_detached "$WEB_LABEL" "$WEB_SCREEN" "$ROOT_DIR/apps/web" "$LOG_DIR/web.log" "env NEXT_DIST_DIR=.next-dev NEXT_PUBLIC_AGENT_HTTPS_PORT=$AGENT_HTTPS_PORT ./node_modules/.bin/next dev -p $WEB_PORT"
  wait_for_http "http://127.0.0.1:$WEB_PORT/" "web" "$LOG_DIR/web.log"
}

start_web_prod() {
  echo "[dev-control] building web (prod / next build) — 首次/改动后约需 30-60s …"
  (
    cd "$ROOT_DIR"
    pnpm --filter @mac/shared build
  )
  (
    cd "$ROOT_DIR/apps/web"
    env NEXT_DIST_DIR=.next NEXT_PUBLIC_AGENT_HTTPS_PORT="$AGENT_HTTPS_PORT" ./node_modules/.bin/next build 2>&1 | tee "$LOG_DIR/web-build.log"
  )
  echo "[dev-control] starting web (prod / next start) on :$WEB_PORT"
  run_detached "$WEB_LABEL" "$WEB_SCREEN" "$ROOT_DIR/apps/web" "$LOG_DIR/web.log" "env NEXT_DIST_DIR=.next ./node_modules/.bin/next start -p $WEB_PORT"
  wait_for_http "http://127.0.0.1:$WEB_PORT/" "web" "$LOG_DIR/web.log"
}

start_agent() {
  echo "[dev-control] starting local-agent on :$AGENT_PORT"
  (
    cd "$ROOT_DIR"
    pnpm --filter @mac/shared build
  )
  # Bind / auth come from the root .env (MAC_AGENT_BIND, MAC_AGENT_PASSWORD).
  # Default bind is 127.0.0.1 — correct when fronted by `tailscale serve`.
  run_detached "$AGENT_LABEL" "$AGENT_SCREEN" "$ROOT_DIR/packages/local-agent" "$LOG_DIR/local-agent.log" "./node_modules/.bin/tsx src/cli.ts --port $AGENT_PORT --workspace ../.."
  wait_for_http "http://127.0.0.1:$AGENT_PORT/health" "local-agent" "$LOG_DIR/local-agent.log"
}

stop_web() {
  echo "[dev-control] stopping web"
  screen_quit "$WEB_SCREEN"
  launchctl_remove "$WEB_LABEL"
  kill_by_port "$WEB_PORT"
  kill_by_pattern "agent_console/apps/web/.*/next/dist/bin/next (dev|start) -p $WEB_PORT"
  kill_by_pattern "pnpm --filter @mac/web dev"
}

stop_agent() {
  echo "[dev-control] stopping local-agent"
  screen_quit "$AGENT_SCREEN"
  launchctl_remove "$AGENT_LABEL"
  kill_by_port "$AGENT_PORT"
  kill_by_pattern "agent_console/packages/local-agent/.*src/cli.ts"
  kill_by_pattern "pnpm --filter @mac/local-agent dev"
}

status_web() {
  status_port "$WEB_PORT" "web"
}

status_agent() {
  status_port "$AGENT_PORT" "local-agent"
}

run_detached() {
  local label="$1"
  local screen_name="$2"
  local cwd="$3"
  local log_file="$4"
  local command="$5"
  : >"$log_file"
  if command -v screen >/dev/null 2>&1; then
    screen_quit "$screen_name"
    screen -dmS "$screen_name" /bin/bash -lc "cd '$cwd' && exec $command </dev/null >>'$log_file' 2>&1"
    return 0
  fi
  if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    launchctl_remove "$label"
    launchctl submit -l "$label" -- /bin/bash -lc "cd '$cwd' && exec $command </dev/null >>'$log_file' 2>&1"
    return 0
  fi
  (
    cd "$cwd"
    nohup /bin/bash -lc "exec $command" </dev/null >>"$log_file" 2>&1 &
    disown || true
  )
}

screen_quit() {
  local name="$1"
  if command -v screen >/dev/null 2>&1; then
    screen -S "$name" -X quit >/dev/null 2>&1 || true
  fi
}

launchctl_remove() {
  local label="$1"
  if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    launchctl remove "$label" >/dev/null 2>&1 || true
  fi
}

kill_by_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill_gracefully $pids
  fi
}

kill_by_pattern() {
  local pattern="$1"
  local pids
  pids="$(ps aux | grep -E "$pattern" | grep -v grep | awk '{print $2}' || true)"
  if [[ -n "$pids" ]]; then
    kill_gracefully $(echo "$pids" | sort -u)
  fi
}

kill_gracefully() {
  local pids=("$@")
  if [[ "${#pids[@]}" -eq 0 ]]; then
    return 0
  fi
  echo "[dev-control] killing ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null || true
  sleep 1
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

wait_for_port() {
  local port="$1"
  local name="$2"
  local log_file="$3"
  for _ in $(seq 1 60); do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "[dev-control] $name is listening on :$port"
      return 0
    fi
    sleep 0.5
  done
  echo "[dev-control] $name did not start on :$port" >&2
  echo "[dev-control] last log lines from $log_file:" >&2
  tail -80 "$log_file" >&2 || true
  exit 1
}

wait_for_http() {
  local url="$1"
  local name="$2"
  local log_file="$3"
  for _ in $(seq 1 90); do
    if curl --noproxy "*" -fsS "$url" >/dev/null 2>&1; then
      echo "[dev-control] $name is ready at $url"
      return 0
    fi
    if [[ -f "$log_file" ]] && grep -E "Error:|EADDRINUSE|Cannot find module|failed" "$log_file" >/dev/null 2>&1; then
      echo "[dev-control] $name reported an error while starting" >&2
      tail -120 "$log_file" >&2 || true
      exit 1
    fi
    sleep 0.5
  done
  echo "[dev-control] $name did not become healthy at $url" >&2
  echo "[dev-control] last log lines from $log_file:" >&2
  tail -120 "$log_file" >&2 || true
  exit 1
}

status_port() {
  local port="$1"
  local name="$2"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN; then
    echo "[dev-control] $name is running on :$port"
  else
    echo "[dev-control] $name is stopped on :$port"
  fi
}

main "$@"
