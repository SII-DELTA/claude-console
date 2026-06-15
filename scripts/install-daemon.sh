#!/usr/bin/env bash
# Install local-agent as a launchd user agent (auto-start, keep-alive).
# The agent reads ~/.claude/projects and drives Claude Code headlessly — it does
# NOT depend on VS Code. Bind address is loopback by default; set MAC_AGENT_BIND
# to your Tailscale IP to expose it to the tailnet.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.nexra.local-agent"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="$(command -v node)"
CLI_JS="${REPO_ROOT}/packages/local-agent/dist/cli.js"

WORKSPACE="${1:-$REPO_ROOT}"
BIND="${MAC_AGENT_BIND:-127.0.0.1}"
PORT="${MAC_AGENT_PORT:-7345}"

if [[ ! -f "$CLI_JS" ]]; then
  echo "[install] building local-agent…"
  (cd "$REPO_ROOT" && pnpm --filter @mac/shared build && pnpm --filter @mac/local-agent build)
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.mac-agent"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${CLI_JS}</string>
    <string>--workspace</string><string>${WORKSPACE}</string>
    <string>--port</string><string>${PORT}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MAC_AGENT_BIND</key><string>${BIND}</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${HOME}/.mac-agent/agent.out.log</string>
  <key>StandardErrorPath</key><string>${HOME}/.mac-agent/agent.err.log</string>
  <key>WorkingDirectory</key><string>${WORKSPACE}</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "[install] loaded ${LABEL}"
echo "[install]   workspace : ${WORKSPACE}"
echo "[install]   bind      : ${BIND}:${PORT}"
echo "[install]   logs      : ~/.mac-agent/agent.{out,err}.log"
echo "[install] pair code is printed to the out log on each (re)start:"
echo "[install]   grep pairCode ~/.mac-agent/agent.out.log | tail -1"
