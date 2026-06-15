import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// the hook script is a plain .mjs; import its pure transition fn
import { computeHookState } from "../../hooks/session-hook.mjs";
import { installLivenessHooks } from "../hooks-installer.js";
import { SessionLiveness } from "../session-liveness.js";

const here = dirname(fileURLToPath(import.meta.url));

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "live-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("computeHookState (hook transitions)", () => {
  const payload = { session_id: "s1", cwd: "/x", transcript_path: "/t.jsonl" };
  it("maps the four lifecycle events", () => {
    expect(computeHookState({}, "SessionStart", payload).state).toBe("idle");
    expect(computeHookState({}, "UserPromptSubmit", payload).state).toBe("busy");
    expect(computeHookState({}, "Stop", payload).state).toBe("idle");
    expect(computeHookState({}, "SessionEnd", payload).state).toBe("ended");
  });
  it("tracks currentTool across Pre/PostToolUse and stays busy", () => {
    const pre = computeHookState({ state: "busy" }, "PreToolUse", { ...payload, tool_name: "Bash" });
    expect(pre.state).toBe("busy");
    expect(pre.currentTool).toBe("Bash");
    const post = computeHookState(pre, "PostToolUse", payload);
    expect(post.currentTool).toBeNull();
  });
  it("carries sessionId/cwd/transcript through", () => {
    const s = computeHookState({}, "UserPromptSubmit", payload);
    expect(s.sessionId).toBe("s1");
    expect(s.cwd).toBe("/x");
    expect(s.transcriptPath).toBe("/t.jsonl");
  });
});

describe("installLivenessHooks (idempotent merge)", () => {
  const script = join(here, "..", "..", "hooks", "session-hook.mjs");

  it("installs all events into an empty/missing settings file", async () => {
    const settingsPath = join(tmp(), "settings.json");
    const r = await installLivenessHooks({ settingsPath, scriptPath: script, node: "/usr/bin/node" });
    expect(r.installed).toBe(true);
    const j = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PreToolUse", "PostToolUse"]) {
      const cmd = j.hooks[ev][0].hooks[0].command;
      expect(cmd).toContain("session-hook.mjs");
      expect(cmd).toContain(ev);
    }
  });

  it("is a no-op on re-install (idempotent)", async () => {
    const settingsPath = join(tmp(), "settings.json");
    await installLivenessHooks({ settingsPath, scriptPath: script, node: "/usr/bin/node" });
    const second = await installLivenessHooks({ settingsPath, scriptPath: script, node: "/usr/bin/node" });
    expect(second.installed).toBe(false);
    expect(second.reason).toBe("already installed");
  });

  it("preserves the user's existing unrelated hooks", async () => {
    const dir = tmp();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }),
    );
    await installLivenessHooks({ settingsPath, scriptPath: script, node: "/usr/bin/node" });
    const j = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(j.model).toBe("x"); // unrelated key kept
    const stopCmds = j.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain("echo mine"); // user hook kept
    expect(stopCmds.some((c: string) => c.includes("session-hook.mjs"))).toBe(true); // ours added
  });
});

describe("SessionLiveness (reaper)", () => {
  it("marks a session dead when its process is gone and no registry entry exists", () => {
    const stateDir = tmp();
    const registryDir = tmp();
    // a busy state file whose pid is almost-certainly dead (use a huge pid)
    writeFileSync(
      join(stateDir, "ghost.json"),
      JSON.stringify({ sessionId: "ghost", state: "busy", pid: 2_000_000_000, currentTool: null }),
    );
    const live = new SessionLiveness(undefined, { stateDir, registryDir });
    live.refreshAndReap();
    expect(live.isBusy("ghost")).toBe(false);
    expect(live.getState("ghost")?.state).toBe("dead");
  });

  it("keeps a session alive when the registry shows a live pid for it", () => {
    const stateDir = tmp();
    const registryDir = tmp();
    writeFileSync(
      join(stateDir, "self.json"),
      JSON.stringify({ sessionId: "self", state: "busy", pid: 2_000_000_001, currentTool: null }),
    );
    // registry says this session's pid is THIS test process → alive
    writeFileSync(join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "self" }));
    const live = new SessionLiveness(undefined, { stateDir, registryDir });
    live.refreshAndReap();
    expect(live.isBusy("self")).toBe(true);
  });
});
