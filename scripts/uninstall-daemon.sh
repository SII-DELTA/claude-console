#!/usr/bin/env bash
# Remove the local-agent launchd user agent.
set -euo pipefail
LABEL="com.nexra.local-agent"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "[uninstall] removed ${LABEL}"
