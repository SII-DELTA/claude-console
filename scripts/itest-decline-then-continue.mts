// Repro: ask AskUserQuestion → decline (✕ close) → send a follow-up → does it continue?
// Run: pnpm --filter @mac/local-agent exec tsx ../../scripts/itest-decline-then-continue.mts
import { tmpdir } from "node:os";
import { Bus } from "../packages/local-agent/src/bus.js";
import { ClaudeDriver } from "../packages/local-agent/src/claude-driver.js";

const cwd = tmpdir();
const bus = new Bus();
const store = { isLive: async () => false, getSession: async () => ({ session: { cwd } }) } as any;
const driver = new ClaudeDriver({ workspaceRoot: () => cwd, store, bus, interactivePermissions: true });

let sessionId = "";
let declined = false;
let firstDone = false;

bus.on("claude:drive_error", (_id, m) => console.error("[drive_error]", m));
bus.on("claude:permission_request", (sid, rid) => {
  console.error(`[permission_request] rid=${rid} → DECLINE (✕)`);
  const ok = driver.declinePermission(sid, rid);
  declined = true;
  console.error(`[decline] ok=${ok}`);
});

function waitDone() {
  return new Promise<void>((resolve) => {
    const off = bus.on("claude:drive_done", () => {
      off();
      resolve();
    });
    setTimeout(() => { off(); resolve(); }, 60000);
  });
}

console.error("=== turn 1: ask question, then decline ===");
const done1 = waitDone();
({ sessionId } = driver.newSession("请调用 AskUserQuestion 问我 A 还是 B，两个选项。不要别的。", cwd));
await done1;
firstDone = true;
console.error(`[turn1 done] declined=${declined} isDriving=${driver.isDriving(sessionId)} owns=${driver.owns(sessionId)}`);

await new Promise((r) => setTimeout(r, 500));

console.error("\n=== turn 2: follow-up message (should continue same session) ===");
let gotText = false;
const off = bus.on("claude:delta", (e) => { if (e.blockKind === "text" && e.delta.trim()) gotText = true; });
const done2 = waitDone();
try {
  await driver.continueSession(sessionId, "现在请只回复一句：你好。");
} catch (e) {
  console.error("[continueSession THREW]", (e as Error).constructor.name, (e as Error).message);
}
await done2;
off();
console.error(`[turn2 done] gotText=${gotText} owns=${driver.owns(sessionId)}`);

driver.destroyAll();
console.error(gotText ? "\n✅ PASS: 续写正常" : "\n❌ FAIL: 第二条消息没有产生回复（复现用户问题）");
process.exit(gotText ? 0 : 1);
