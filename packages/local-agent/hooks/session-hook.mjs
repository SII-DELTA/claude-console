#!/usr/bin/env node
// Claude Code lifecycle hook → writes ~/.claude/session-state/<sessionId>.json
// Invoked by Claude as:  node session-hook.mjs <EventName>
// Reads the hook payload (JSON) on stdin. Zero dependencies, fast startup —
// it runs on every lifecycle transition, so it must be cheap.
//
// State machine (see docs/specs/2026-06-16-session-liveness-detection-spec.md):
//   SessionStart → idle | UserPromptSubmit → busy | Stop → idle | SessionEnd → (delete)
//   PreToolUse → busy + currentTool | PostToolUse → clear currentTool
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_BY_EVENT = {
  SessionStart: "idle",
  UserPromptSubmit: "busy",
  Stop: "idle",
  SessionEnd: "ended",
};

/** Pure state transition (exported for unit tests). Does not touch the clock/fs. */
export function computeHookState(prev, event, payload) {
  let state = STATE_BY_EVENT[event] ?? prev.state ?? "idle";
  let currentTool = prev.currentTool ?? null;
  if (event === "PreToolUse") {
    state = "busy";
    currentTool = payload.tool_name ?? payload.tool ?? null;
  } else if (event === "PostToolUse") {
    currentTool = null;
  }
  return {
    sessionId: payload.session_id ?? payload.sessionId ?? prev.sessionId ?? null,
    cwd: payload.cwd ?? prev.cwd ?? null,
    state,
    transcriptPath: payload.transcript_path ?? prev.transcriptPath ?? null,
    currentTool,
    lastEvent: event,
    version: payload.version ?? prev.version ?? null,
  };
}

export function stateDir() {
  return path.join(os.homedir(), ".claude", "session-state");
}

function main() {
  const event = process.argv[2] || "";
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let payload = {};
    try { payload = JSON.parse(raw || "{}"); } catch { /* keep {} */ }
    const sid = payload.session_id ?? payload.sessionId;
    if (!sid) process.exit(0);
    const dir = stateDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const file = path.join(dir, sid + ".json");
    if (event === "SessionEnd") {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      process.exit(0);
    }
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first event */ }
    const out = computeHookState(prev, event, payload);
    // pid isn't in the payload; the hook's parent is the claude session process.
    out.pid = prev.pid ?? process.ppid ?? null;
    out.lastEventAt = new Date().toISOString();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, file); // atomic — readers never see a partial file
    } catch { /* best-effort */ }
    process.exit(0);
  });
  // never hang if stdin stays open
  setTimeout(() => process.exit(0), 2000).unref?.();
}

// Run main only when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("session-hook.mjs")) main();
