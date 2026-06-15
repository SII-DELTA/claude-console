// Live integration test for 方案 B through the REAL ClaudeDriver class.
// Spawns claude, triggers AskUserQuestion, answers it via driver.answerPermission,
// then verifies the resulting tool_result is a clean (non-error) success.
//
// Run: pnpm --filter @mac/local-agent exec tsx ../../scripts/itest-interactive-permission.mts
import { tmpdir } from "node:os";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../packages/local-agent/src/bus.js";
import { ClaudeDriver } from "../packages/local-agent/src/claude-driver.js";

const cwd = tmpdir();
const bus = new Bus();
const store = {
  isLive: async () => false,
  getSession: async () => ({ session: { cwd } }),
} as any;

const driver = new ClaudeDriver({
  workspaceRoot: () => cwd,
  store,
  bus,
  interactivePermissions: true,
});

let pass = false;
let resolved = false;
const done = new Promise<void>((resolve) => {
  bus.on("claude:permission_request", (sessionId, requestId, toolName, questions) => {
    console.error(`[permission_request] tool=${toolName} req=${requestId}`);
    console.error("  questions=", JSON.stringify(questions).slice(0, 200));
    const answers: Record<string, string | string[]> = {};
    for (const q of questions) {
      answers[q.question] = q.multiSelect ? [q.options[0].label] : q.options[0].label;
    }
    const ok = driver.answerPermission(sessionId, requestId, answers);
    console.error("  answerPermission ok=", ok);
  });
  bus.on("claude:drive_error", (_id, m) => {
    console.error("[drive_error]", m);
  });
  bus.on("claude:drive_done", async (sessionId) => {
    if (resolved) return;
    resolved = true;
    await new Promise((r) => setTimeout(r, 1500)); // let claude flush the JSONL
    // Locate the session JSONL across project dirs (macOS realpath varies).
    try {
      const root = join(process.env.HOME!, ".claude", "projects");
      let file: string | null = null;
      for (const dir of readdirSync(root)) {
        const cand = join(root, dir, `${sessionId}.jsonl`);
        try {
          readFileSync(cand);
          file = cand;
          break;
        } catch {
          /* keep looking */
        }
      }
      if (!file) throw new Error("session JSONL not found for " + sessionId);
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      let askId: string | null = null;
      for (const ln of lines) {
        const o = JSON.parse(ln);
        const c = o?.message?.content;
        if (!Array.isArray(c)) continue;
        for (const b of c) {
          if (b?.type === "tool_use" && b?.name === "AskUserQuestion") askId = b.id;
          if (b?.type === "tool_result" && b?.tool_use_id === askId) {
            const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
            console.error(`[tool_result] is_error=${b.is_error} content=${content.slice(0, 160)}`);
            pass = !b.is_error && /answered/i.test(content);
          }
        }
      }
    } catch (e) {
      console.error("verify failed:", e);
    }
    resolve();
  });
});

console.error("[itest] starting session…");
driver.newSession(
  "请调用 AskUserQuestion 工具问我在 A、B 两个方案里选哪个，给两个选项 A、B。不要做别的。",
  cwd,
);

const timeout = new Promise<void>((r) => setTimeout(r, 90_000));
await Promise.race([done, timeout]);
driver.destroyAll();
console.error(pass ? "\n✅ PASS: AskUserQuestion resolved with a clean success result" : "\n❌ FAIL");
process.exit(pass ? 0 : 1);
