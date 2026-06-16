// Live integration test for tool approval through the REAL ClaudeDriver.
// Spawns claude in `default` mode, triggers a Write (which gates), answers it via
// driver.approveTool(allow|deny), then verifies the tool_result in the JSONL:
//   allow → Write ran (non-error "File created…")
//   deny  → tool_result is_error with our "用户拒绝了该操作。" message
//
// Run: APPROVE_DECISION=allow pnpm --filter @mac/local-agent exec tsx ../../scripts/itest-tool-approval.mts
//      APPROVE_DECISION=deny  pnpm --filter @mac/local-agent exec tsx ../../scripts/itest-tool-approval.mts
import { tmpdir } from "node:os";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../packages/local-agent/src/bus.js";
import { ClaudeDriver } from "../packages/local-agent/src/claude-driver.js";

const decision = (process.env.APPROVE_DECISION as "allow" | "deny") || "allow";
const cwd = tmpdir();
const outFile = join(cwd, `itest_approval_${Date.now()}.txt`);
const bus = new Bus();
const store = {
  isLive: async () => false,
  getSession: async () => ({ session: { cwd } }),
  refreshSession: async () => {},
} as any;

const driver = new ClaudeDriver({
  workspaceRoot: () => cwd,
  store,
  bus,
  interactivePermissions: true,
});

let surfaced = false;
let resolved = false;
const done = new Promise<void>((resolve) => {
  bus.on("claude:tool_approval_request", (sessionId, requestId, toolName, summary) => {
    surfaced = true;
    console.error(`[tool_approval_request] tool=${toolName} req=${requestId} summary=${summary}`);
    const ok = driver.approveTool(sessionId, requestId, decision);
    console.error(`  approveTool(${decision}) ok=${ok}`);
  });
  bus.on("claude:permission_request", (_s, _r, tool) =>
    console.error(`[unexpected permission_request] tool=${tool}`),
  );
  bus.on("claude:drive_error", (_id, m) => console.error("[drive_error]", m));
  bus.on("claude:drive_done", async (sessionId) => {
    if (resolved) return;
    resolved = true;
    await new Promise((r) => setTimeout(r, 1500)); // let claude flush the JSONL
    let pass = false;
    try {
      const root = join(process.env.HOME!, ".claude", "projects");
      let file: string | null = null;
      for (const dir of readdirSync(root)) {
        const cand = join(root, dir, `${sessionId}.jsonl`);
        try { readFileSync(cand); file = cand; break; } catch { /* keep looking */ }
      }
      if (!file) throw new Error("session JSONL not found for " + sessionId);
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      let writeId: string | null = null;
      for (const ln of lines) {
        const o = JSON.parse(ln);
        const c = o?.message?.content;
        if (!Array.isArray(c)) continue;
        for (const b of c) {
          if (b?.type === "tool_use" && b?.name === "Write") writeId = b.id;
          if (b?.type === "tool_result" && b?.tool_use_id === writeId) {
            const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
            console.error(`[Write tool_result] is_error=${b.is_error} content=${content.slice(0, 160)}`);
            if (decision === "allow") pass = !b.is_error && /created|successfully/i.test(content);
            else pass = !!b.is_error && /拒绝/.test(content);
          }
        }
      }
    } catch (e) {
      console.error("verify failed:", e);
    }
    console.error(`\n=== ${decision.toUpperCase()} → surfaced=${surfaced} pass=${pass} ===`);
    (globalThis as any).__pass = pass && surfaced;
    resolve();
  });
});

console.error(`[itest] decision=${decision} → starting Write session (default mode)…`);
driver.newSession(
  `用 Write 工具创建文件 ${outFile}，内容写 ok。只做这一件事，不要解释。`,
  cwd,
  undefined,
  "default",
);

const timeout = new Promise<void>((r) => setTimeout(r, 90_000));
await Promise.race([done, timeout]);
driver.destroyAll();
const ok = (globalThis as any).__pass === true;
console.error(ok ? "ITEST PASS" : "ITEST FAIL");
process.exit(ok ? 0 : 1);
