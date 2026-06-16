// Reproduce the reported bug: ask AskUserQuestion → CLOSE the picker (allow with
// NO answers, exactly what declinePermission writes) → then send a SECOND prompt
// to the SAME warm process and see whether it responds.
//
// Usage: node scripts/probe-decline-then-resend.mjs
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

const bin = process.env.CLAUDE_BIN || "claude";
const sessionId = randomUUID();
const cwd = tmpdir();
const args = [
  "--session-id", sessionId,
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--permission-mode", "default",
  "--permission-prompt-tool", "stdio",
];
const proc = spawn(bin, args, { cwd, env: process.env });

let buf = "";
let phase = "init"; // init → asked → declined → resent → done
let results = 0;
let sentInit = false;

function sendInitialize() {
  send({ type: "control_request", request_id: "init-" + randomUUID(), request: { subtype: "initialize", hooks: {} } });
}
function startAsk() {
  if (phase !== "init") return;
  phase = "asked";
  setTimeout(() => sendPrompt("请调用 AskUserQuestion 工具问我：A 还是 B？两个选项 A、B。不要做别的。"), 100);
}

function send(obj) {
  const line = JSON.stringify(obj) + "\n";
  process.stderr.write("OUT> " + line.slice(0, 200) + "\n");
  proc.stdin.write(line);
}
function sendPrompt(text) {
  send({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}
function respond(rid, response) {
  send({ type: "control_response", response: { subtype: "success", request_id: rid, response } });
}

proc.stdout.on("data", (c) => {
  buf += c.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    handle(line);
  }
});
proc.stderr.on("data", (c) => process.stderr.write("[stderr] " + c.toString()));
proc.on("close", (code) => {
  console.error(`\n=== CLOSED code=${code} phase=${phase} results=${results} ===`);
  process.exit(0);
});

function handle(line) {
  const t = line.trim();
  if (!t) return;
  let e;
  try { e = JSON.parse(t); } catch { return; }

  if (e.type === "control_response") {
    if (e.response?.request_id?.startsWith("init-")) startAsk();
    return;
  }
  if (e.type === "system" && e.subtype === "init") {
    console.error("[init] session=" + e.session_id);
    startAsk();
    return;
  }

  if (e.type === "control_request" && e.request?.subtype === "can_use_tool") {
    const rid = e.request_id;
    console.error(`[can_use_tool] ${e.request?.tool_name} phase=${phase}`);
    // CLOSE the picker: allow with NO answers (exactly declinePermission)
    respond(rid, { behavior: "allow", updatedInput: { ...(e.request.input || {}) } });
    if (phase === "asked") phase = "declined";
    return;
  }
  if (e.type === "control_request") {
    respond(e.request_id, {}); // ack unknown
    return;
  }

  if (e.type === "assistant" || e.type === "user") {
    const blocks = e.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === "tool_use") console.error(`[${e.type}] tool_use ${b.name}`);
        else if (b.type === "tool_result") console.error(`[${e.type}] tool_result is_error=${b.is_error} ${JSON.stringify(b.content).slice(0,150)}`);
        else if (b.type === "text" && b.text?.trim()) console.error(`[${e.type}] text: ${b.text.slice(0,120)}`);
      }
    }
    return;
  }

  if (e.type === "result") {
    results++;
    console.error(`\n=== RESULT #${results} is_error=${e.is_error} phase=${phase} ===`);
    console.error((e.result || "").slice(0, 200));
    if (phase === "declined") {
      // The reported scenario: after closing the picker, send a NEW message.
      phase = "resent";
      console.error("\n>>> sending SECOND prompt to the SAME warm process <<<\n");
      setTimeout(() => sendPrompt("好的，现在直接说『收到』两个字就行。"), 300);
    } else if (phase === "resent") {
      phase = "done";
      setTimeout(() => proc.kill("SIGTERM"), 300);
    }
    return;
  }
}

setTimeout(() => { if (!sentInit) { sentInit = true; sendInitialize(); } }, 50);
setTimeout(() => { console.error("\n[TIMEOUT 90s] phase=" + phase + " results=" + results); proc.kill("SIGTERM"); }, 90000);
