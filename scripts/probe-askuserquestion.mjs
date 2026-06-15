// Empirical probe: drive the real `claude` CLI with the stream-json control
// protocol and capture exactly which control_request AskUserQuestion surfaces as
// (can_use_tool / request_user_dialog / elicitation) and what response it wants.
//
// Usage: node scripts/probe-askuserquestion.mjs
// Env: CLAUDE_BIN (default "claude"), PROBE_RESPOND=deny|allow (default deny)
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

const bin = process.env.CLAUDE_BIN || "claude";
const respondMode = process.env.PROBE_RESPOND || "deny";
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
let sentInit = false;
let answered = false;

function send(obj) {
  const line = JSON.stringify(obj) + "\n";
  process.stderr.write("OUT> " + line);
  proc.stdin.write(line);
}

// 1. initialize handshake — advertise we handle the control protocol
function sendInitialize() {
  send({
    type: "control_request",
    request_id: "init-" + randomUUID(),
    request: { subtype: "initialize", hooks: {} },
  });
}

function sendPrompt(text) {
  send({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

function respondControl(requestId, response) {
  send({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    handle(line);
  }
});
proc.stderr.on("data", (c) => process.stderr.write("[claude-stderr] " + c.toString()));
proc.on("close", (code) => {
  console.error("\n=== claude closed code=" + code + " ===");
  process.exit(0);
});

function handle(line) {
  const t = line.trim();
  if (!t) return;
  let e;
  try { e = JSON.parse(t); } catch { return; }

  // log envelope type
  if (e.type === "control_request") {
    console.error("\n########## INBOUND control_request ##########");
    console.error(JSON.stringify(e, null, 2).slice(0, 2000));
    const sub = e.request?.subtype;
    const rid = e.request_id;
    if (sub === "can_use_tool") {
      const answer = "我选择：方案A（前端兜底）";
      if (respondMode === "allow") {
        const input = e.request.input || {};
        const answers = {};
        for (const q of input.questions || []) {
          answers[q.question] = q.options?.[0]?.label; // pick first option as "chosen"
        }
        respondControl(rid, {
          behavior: "allow",
          updatedInput: { ...input, answers },
        });
      } else {
        respondControl(rid, { behavior: "deny", message: answer });
      }
    } else if (sub === "request_user_dialog" || sub === "elicitation") {
      // try a few plausible answer shapes; log so we learn the right one
      respondControl(rid, {
        behavior: "allow",
        response: { questions: [{ header: "选择", answer: "方案A" }] },
      });
    } else {
      // unknown control: ack success empty
      respondControl(rid, {});
    }
    return;
  }
  if (e.type === "control_response") {
    console.error("\n---- INBOUND control_response ----");
    console.error(JSON.stringify(e).slice(0, 600));
    if (e.response?.request_id?.startsWith("init-") && !sentInit) {
      sentInit = true;
      setTimeout(() => sendPrompt(
        "请调用 AskUserQuestion 工具，问我：在 A 和 B 两个方案里选哪个？给两个选项 A、B。不要做别的解释。"
      ), 100);
    }
    return;
  }
  if (e.type === "control_cancel_request") {
    console.error("\n---- control_cancel_request ----", JSON.stringify(e).slice(0, 500));
    return;
  }
  if (e.type === "system" && e.subtype === "init") {
    console.error("[system:init] session=" + e.session_id);
    if (!sentInit) { sentInit = true; setTimeout(() => sendPrompt(
      "请调用 AskUserQuestion 工具，问我：在 A 和 B 两个方案里选哪个？给两个选项 A、B。不要做别的。"
    ), 100); }
    return;
  }
  if (e.type === "assistant" || e.type === "user") {
    // log tool_use / tool_result blocks compactly
    const blocks = e.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === "tool_use") console.error(`[${e.type}] tool_use ${b.name} id=${b.id} input=${JSON.stringify(b.input).slice(0,200)}`);
        else if (b.type === "tool_result") console.error(`[${e.type}] tool_result for ${b.tool_use_id} is_error=${b.is_error} content=${JSON.stringify(b.content).slice(0,300)}`);
        else if (b.type === "text" && b.text?.trim()) console.error(`[${e.type}] text: ${b.text.slice(0,160)}`);
      }
    }
    return;
  }
  if (e.type === "result") {
    console.error("\n=== result is_error=" + e.is_error + " ===");
    console.error((e.result || "").slice(0, 300));
    setTimeout(() => proc.kill("SIGTERM"), 200);
    return;
  }
}

// Send initialize right away (some versions accept before system:init)
setTimeout(() => { if (!sentInit) sendInitialize(); }, 50);
// also send initialize again right after we see init handled above? keep single.
setTimeout(() => { console.error("\n[probe timeout 60s, killing]"); proc.kill("SIGTERM"); }, 60000);
