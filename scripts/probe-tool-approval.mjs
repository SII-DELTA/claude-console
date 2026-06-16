// Verify the tool-approval control path against the REAL claude CLI:
// under --permission-mode acceptEdits (the prod default), a Bash command should
// hit the stdio can_use_tool ask path. We answer allow (run #1) then deny (run #2)
// and confirm the tool_result reflects each decision.
//
// Usage: node scripts/probe-tool-approval.mjs
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

const bin = process.env.CLAUDE_BIN || "claude";
const decision = process.env.PROBE_DECISION || "allow"; // allow | deny
const sessionId = randomUUID();
const args = [
  "--session-id", sessionId,
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--permission-mode", process.env.PROBE_MODE || "default",
  "--permission-prompt-tool", "stdio",
];
const proc = spawn(bin, args, { cwd: tmpdir(), env: process.env });

let buf = "";
let sentInit = false;
let phase = "init";
let sawCanUse = null;

function send(o) { process.stderr.write("OUT> " + JSON.stringify(o).slice(0, 160) + "\n"); proc.stdin.write(JSON.stringify(o) + "\n"); }
function prompt(t) { send({ type: "user", message: { role: "user", content: [{ type: "text", text: t }] } }); }
function start() {
  if (phase !== "init") return;
  phase = "asked";
  setTimeout(() => prompt("用 Write 工具创建文件 /tmp/probe_perm_test.txt，内容写 hi。只做这一件事。"), 100);
}

proc.stdout.on("data", (c) => {
  buf += c.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); handle(l); }
});
proc.stderr.on("data", (c) => process.stderr.write("[err] " + c));
proc.on("close", (code) => { console.error(`\n=== CLOSED code=${code} sawCanUse=${sawCanUse} ===`); process.exit(0); });

function handle(line) {
  const t = line.trim();
  if (!t) return;
  let e; try { e = JSON.parse(t); } catch { return; }

  if (e.type === "control_response" && e.response?.request_id?.startsWith("init-")) return start();
  if (e.type === "system" && e.subtype === "init") return start();

  if (e.type === "control_request" && e.request?.subtype === "can_use_tool") {
    sawCanUse = e.request.tool_name;
    console.error(`\n>>> can_use_tool tool=${e.request.tool_name} input=${JSON.stringify(e.request.input).slice(0,120)}`);
    const rid = e.request_id;
    const response = decision === "deny"
      ? { behavior: "deny", message: "用户拒绝了该操作。" }
      : { behavior: "allow", updatedInput: { ...(e.request.input || {}) } };
    console.error(`<<< responding ${decision}`);
    send({ type: "control_response", response: { subtype: "success", request_id: rid, response } });
    return;
  }
  if (e.type === "control_request") { send({ type: "control_response", response: { subtype: "success", request_id: e.request_id, response: {} } }); return; }

  if (e.type === "user" || e.type === "assistant") {
    for (const b of e.message?.content ?? []) {
      if (b.type === "tool_result") console.error(`[tool_result] is_error=${b.is_error} ${JSON.stringify(b.content).slice(0,160)}`);
      else if (b.type === "text" && b.text?.trim()) console.error(`[${e.type}] ${b.text.slice(0,120)}`);
    }
    return;
  }
  if (e.type === "result") { console.error(`\n=== RESULT is_error=${e.is_error} ===\n${(e.result || "").slice(0,160)}`); setTimeout(() => proc.kill("SIGTERM"), 200); }
}

setTimeout(() => { if (!sentInit) { sentInit = true; send({ type: "control_request", request_id: "init-" + randomUUID(), request: { subtype: "initialize", hooks: {} } }); } }, 50);
setTimeout(() => { console.error("\n[TIMEOUT]"); proc.kill("SIGTERM"); }, 90000);
