// Live integration test for 方式二 (persistence + restart recovery).
// 1) drive a session to an AskUserQuestion, do NOT answer
// 2) simulate an agent restart: destroy the driver (kills the process)
// 3) a fresh driver (same SQLite store) recovers the pending picker and answers it
// 4) verify the session continues with a clean (non-error) success result
//
// Run: pnpm --filter @mac/local-agent exec tsx ../../scripts/itest-pending-recovery.mts
import { tmpdir } from "node:os";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../packages/local-agent/src/bus.js";
import { ClaudeDriver } from "../packages/local-agent/src/claude-driver.js";
import { HistoryStore } from "../packages/local-agent/src/history-store.js";

const cwd = tmpdir();
const store = new HistoryStore(":memory:"); // durable across the two drivers in-process
const claudeStore = {
  isLive: async () => false,
  getSession: async () => ({ session: { cwd } }),
} as any;

function makeDriver(bus: Bus) {
  return new ClaudeDriver({
    workspaceRoot: () => cwd,
    store: claudeStore,
    bus,
    interactivePermissions: true,
    pendingStore: store,
  });
}

function findSessionFile(sessionId: string): string | null {
  const root = join(process.env.HOME!, ".claude", "projects");
  for (const dir of readdirSync(root)) {
    const cand = join(root, dir, `${sessionId}.jsonl`);
    try {
      readFileSync(cand);
      return cand;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// ---- Phase 1: ask + hold, then "restart" (destroy driver) ----
const bus1 = new Bus();
const d1 = makeDriver(bus1);
let captured: { sessionId: string; requestId: string } | null = null;

const sessionId = await new Promise<string>((resolve) => {
  bus1.on("claude:permission_request", (sid, requestId) => {
    console.error(`[phase1] permission_request req=${requestId} — NOT answering, simulating restart`);
    captured = { sessionId: sid, requestId };
    resolve(sid);
  });
  const { sessionId } = d1.newSession(
    "请调用 AskUserQuestion 问我在 A、B 两个方案里选哪个，给两个选项 A、B。不要做别的。",
    cwd,
  );
  void sessionId;
});

if (!captured) {
  console.error("❌ FAIL: never got a permission_request");
  process.exit(1);
}

const persistedBefore = store.listPendingPermissions(sessionId);
console.error(`[phase1] persisted rows before restart: ${persistedBefore.length}`);
d1.destroyAll(); // kill the warm process (agent restart)
await new Promise((r) => setTimeout(r, 800));
const persistedAfter = store.listPendingPermissions(sessionId);
console.error(`[phase1] persisted rows after restart (should still be 1): ${persistedAfter.length}`);

// ---- Phase 2: fresh driver recovers + answers ----
const bus2 = new Bus();
const d2 = makeDriver(bus2);

const listed = d2.listPending(sessionId);
console.error(`[phase2] listPending → ${listed.length} item(s), live=${listed[0]?.live}`);

let pass = false;
await new Promise<void>((resolve) => {
  let resolved = false;
  bus2.on("claude:drive_error", (_id, m) => console.error("[phase2] drive_error:", m));
  bus2.on("claude:drive_done", async (sid) => {
    if (resolved) return;
    resolved = true;
    await new Promise((r) => setTimeout(r, 1500));
    const file = findSessionFile(sid);
    if (file) {
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
            console.error(`[phase2] tool_result is_error=${b.is_error} content=${content.slice(0, 140)}`);
            pass = !b.is_error && /answered/i.test(content);
          }
        }
      }
    }
    resolve();
  });

  // build answers from the recovered questions, as the frontend would
  const answers: Record<string, string | string[]> = {};
  for (const q of listed[0]?.questions ?? []) {
    answers[q.question] = q.multiSelect ? [q.options[0].label] : q.options[0].label;
  }
  console.error(`[phase2] answering with ${JSON.stringify(answers)}`);
  void d2.recoverAnswerPermission(sessionId, captured!.requestId, answers).then((ok) =>
    console.error(`[phase2] recoverAnswerPermission ok=${ok}`),
  );
  setTimeout(() => resolve(), 60_000);
});

d2.destroyAll();
store.close();
console.error(
  pass ? "\n✅ PASS: recovered after restart and answered with a clean success result" : "\n❌ FAIL",
);
process.exit(pass ? 0 : 1);
