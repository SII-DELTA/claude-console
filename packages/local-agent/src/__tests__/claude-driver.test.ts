import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ClaudeDriver, SessionLiveError } from "../claude-driver.js";
import { Bus } from "../bus.js";
import { parseStreamLine } from "../util/claude-stream.js";

function makeFakeProc() {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  return proc;
}

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "S1" });
const TEXT_DELTA = (t: string) =>
  JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
  });
const THINK_DELTA = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
});
const TOOL_START = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Bash" } },
});
const ASSIST_SNAPSHOT = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "hello" }] },
});
const RESULT_OK = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hello" });

describe("claude-stream parser", () => {
  it("streams token-level text/thinking deltas and tool starts", () => {
    expect(parseStreamLine(INIT)).toEqual([{ kind: "init", sessionId: "S1" }]);
    expect(parseStreamLine(TEXT_DELTA("he"))).toEqual([
      { kind: "delta", blockKind: "text", text: "he" },
    ]);
    expect(parseStreamLine(THINK_DELTA)).toEqual([
      { kind: "delta", blockKind: "thinking", text: "hmm" },
    ]);
    expect(parseStreamLine(TOOL_START)).toEqual([
      { kind: "delta", blockKind: "tool_use", text: "Bash" },
    ]);
    expect(parseStreamLine(RESULT_OK)[0]).toMatchObject({
      kind: "done",
      isError: false,
      result: "hello",
    });
    expect(parseStreamLine("garbage")).toEqual([]);
  });

  it("ignores assembled assistant snapshots (avoids double-emit)", () => {
    expect(parseStreamLine(ASSIST_SNAPSHOT)).toEqual([]);
  });
});

describe("ClaudeDriver", () => {
  function setup(opts?: { interactivePermissions?: boolean }) {
    const bus = new Bus();
    const proc = makeFakeProc();
    const spawnFn = vi.fn(() => proc) as any;
    const store = {
      isLive: vi.fn(async () => false),
      getSession: vi.fn(async () => ({ session: { cwd: "/ws" } })),
      refreshSession: vi.fn(async () => {}),
    } as any;
    const driver = new ClaudeDriver({
      workspaceRoot: () => "/ws",
      store,
      bus,
      spawnFn,
      claudeBin: "claude",
      // legacy tests assert the prompt is the first stdin write; keep B off here.
      interactivePermissions: opts?.interactivePermissions ?? false,
    });
    return { bus, proc, spawnFn, store, driver };
  }

  it("newSession spawns a warm streaming process and writes the prompt to stdin", () => {
    const { driver, spawnFn, proc } = setup();
    const { sessionId } = driver.newSession("do a thing");
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const args = spawnFn.mock.calls[0][1] as string[];
    expect(args).toContain("--session-id");
    expect(args).toContain(sessionId);
    expect(args).toContain("--input-format");
    expect(args).toContain("--include-partial-messages");
    expect(args).not.toContain("-p"); // long-lived, not one-shot print mode
    const frame = JSON.parse((proc.stdin.write as any).mock.calls[0][0]);
    expect(frame).toMatchObject({ type: "user", message: { role: "user" } });
    expect(frame.message.content[0].text).toBe("do a thing");
  });

  it("passes the chosen permission mode to claude", () => {
    const { driver, spawnFn } = setup();
    driver.newSession("hi", undefined, undefined, "plan");
    const args = spawnFn.mock.calls[0][1] as string[];
    const i = args.indexOf("--permission-mode");
    expect(args[i + 1]).toBe("plan");
  });

  it("respawns the warm process when the permission mode changes", async () => {
    const { driver, proc, spawnFn } = setup();
    const { sessionId } = driver.newSession("hi", undefined, undefined, "acceptEdits");
    proc.stdout.emit("data", RESULT_OK + "\n");
    await driver.continueSession(sessionId, "again", false, undefined, "plan"); // mode changed
    expect(spawnFn).toHaveBeenCalledTimes(2); // killed + respawned with new mode
    expect((spawnFn.mock.calls[1][1] as string[]).includes("plan")).toBe(true);
  });

  it("reuses the warm process for a follow-up prompt (no re-spawn)", async () => {
    const { driver, spawnFn, proc } = setup();
    const { sessionId } = driver.newSession("first");
    proc.stdout.emit("data", RESULT_OK + "\n"); // turn done, process stays warm
    await driver.continueSession(sessionId, "second");
    expect(spawnFn).toHaveBeenCalledOnce(); // did NOT spawn again
    expect((proc.stdin.write as any).mock.calls.length).toBe(2);
  });

  it("streams deltas and emits drive_done on result", async () => {
    const { driver, proc, bus } = setup();
    const deltas: string[] = [];
    let done = false;
    bus.on("claude:delta", (e) => deltas.push(e.delta));
    bus.on("claude:drive_done", () => (done = true));

    const { sessionId } = driver.newSession("hi");
    proc.stdout.emit("data", INIT + "\n" + TEXT_DELTA("hel") + "\n");
    proc.stdout.emit("data", TEXT_DELTA("lo") + "\n" + RESULT_OK + "\n");
    proc.emit("close", 0);

    expect(deltas).toEqual(["hel", "lo"]);
    expect(done).toBe(true);
    expect(driver.isDriving(sessionId)).toBe(false);
  });

  it("prewarm spawns a warm process without sending a prompt", async () => {
    const { driver, spawnFn, proc } = setup();
    const warmed = await driver.prewarm("SID");
    expect(warmed).toBe(true);
    expect(spawnFn).toHaveBeenCalledOnce();
    const args = spawnFn.mock.calls[0][1] as string[];
    expect(args).toContain("--resume");
    expect((proc.stdin.write as any).mock.calls.length).toBe(0); // no prompt written
  });

  it("prewarm is a no-op when the session is live", async () => {
    const { driver, store, spawnFn } = setup();
    store.isLive.mockResolvedValueOnce(true);
    expect(await driver.prewarm("SID")).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("continueSession throws SessionLiveError when session is live", async () => {
    const { driver, store } = setup();
    store.isLive.mockResolvedValueOnce(true);
    await expect(driver.continueSession("X", "go")).rejects.toBeInstanceOf(SessionLiveError);
  });

  it("continueSession with force bypasses the live check", async () => {
    const { driver, store, spawnFn } = setup();
    store.isLive.mockResolvedValueOnce(true);
    await driver.continueSession("X", "go", true);
    expect(spawnFn).toHaveBeenCalledOnce();
  });

  it("continueSession resumes with --resume and the session cwd", async () => {
    const { driver, spawnFn } = setup();
    await driver.continueSession("SID", "continue please");
    const args = spawnFn.mock.calls[0][1] as string[];
    expect(args).toContain("--resume");
    expect(args).toContain("SID");
    expect(spawnFn.mock.calls[0][2].cwd).toBe("/ws");
  });

  it("emits drive_error on non-zero exit", () => {
    const { driver, proc, bus } = setup();
    let err = "";
    bus.on("claude:drive_error", (_id, m) => (err = m));
    driver.newSession("hi");
    proc.stderr.emit("data", "boom");
    proc.emit("close", 1);
    expect(err).toBe("boom");
  });
});

describe("ClaudeDriver interactive permissions (方案 B)", () => {
  function makePendingStore() {
    const rows = new Map<string, any>();
    return {
      rows,
      savePendingPermission: (r: any) => void rows.set(r.requestId, r),
      deletePendingPermission: (id: string) => void rows.delete(id),
      deletePendingPermissionsBySession: (sid: string) => {
        for (const [k, v] of rows) if (v.sessionId === sid) rows.delete(k);
      },
      getPendingPermission: (id: string) => rows.get(id) ?? null,
      listPendingPermissions: (sid: string) =>
        [...rows.values()].filter((v) => v.sessionId === sid),
    };
  }

  function setupB() {
    const bus = new Bus();
    const proc = makeFakeProc();
    const spawnFn = vi.fn(() => proc) as any;
    const store = {
      isLive: vi.fn(async () => false),
      getSession: vi.fn(async () => ({ session: { cwd: "/ws" } })),
      refreshSession: vi.fn(async () => {}),
    } as any;
    const pendingStore = makePendingStore();
    const driver = new ClaudeDriver({
      workspaceRoot: () => "/ws",
      store,
      bus,
      spawnFn,
      claudeBin: "claude",
      interactivePermissions: true,
      pendingStore,
    });
    return { bus, proc, spawnFn, store, driver, pendingStore };
  }

  /** all stdin writes parsed as JSON (skipping any that aren't) */
  function writes(proc: any): any[] {
    return (proc.stdin.write as any).mock.calls
      .map((c: any[]) => {
        try {
          return JSON.parse(c[0]);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  const canUse = (requestId: string, tool: string, input: unknown) =>
    JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "can_use_tool", tool_name: tool, input },
    });
  const ASK_INPUT = {
    questions: [
      { question: "Pick?", header: "H", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
    ],
  };

  it("adds --permission-prompt-tool stdio and sends an initialize control_request first", () => {
    const { driver, spawnFn, proc } = setupB();
    driver.newSession("hi");
    const args = spawnFn.mock.calls[0][1] as string[];
    const i = args.indexOf("--permission-prompt-tool");
    expect(args[i + 1]).toBe("stdio");
    const first = writes(proc)[0];
    expect(first).toMatchObject({ type: "control_request", request: { subtype: "initialize" } });
  });

  it("surfaces AskUserQuestion can_use_tool and answerPermission replies allow+answers", () => {
    const { driver, proc, bus } = setupB();
    const events: any[] = [];
    bus.on("claude:permission_request", (sessionId, requestId, toolName, questions) =>
      events.push({ sessionId, requestId, toolName, questions }),
    );
    let cancelled = "";
    bus.on("claude:permission_cancel", (_s, rid) => (cancelled = rid));

    const { sessionId } = driver.newSession("ask me");
    proc.stdout.emit("data", canUse("req1", "AskUserQuestion", ASK_INPUT) + "\n");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId, requestId: "req1", toolName: "AskUserQuestion" });
    expect(events[0].questions[0].options.map((o: any) => o.label)).toEqual(["A", "B"]);

    const ok = driver.answerPermission(sessionId, "req1", { "Pick?": "A" });
    expect(ok).toBe(true);
    const resp = writes(proc).find((w) => w.type === "control_response");
    expect(resp.response).toMatchObject({ subtype: "success", request_id: "req1" });
    expect(resp.response.response).toMatchObject({ behavior: "allow" });
    expect(resp.response.response.updatedInput.answers).toEqual({ "Pick?": "A" });
    expect(cancelled).toBe("req1"); // picker dismissed

    // a second answer for the same request is a no-op (no longer pending)
    expect(driver.answerPermission(sessionId, "req1", { "Pick?": "B" })).toBe(false);
  });

  it("surfaces non-AskUserQuestion ask-path tools as an allow/deny approval", () => {
    const { driver, proc, bus } = setupB();
    let questionSurfaced = false;
    bus.on("claude:permission_request", () => (questionSurfaced = true));
    const approvals: any[] = [];
    bus.on("claude:tool_approval_request", (sessionId, requestId, toolName, summary) =>
      approvals.push({ sessionId, requestId, toolName, summary }),
    );
    const { sessionId } = driver.newSession("go");
    proc.stdout.emit("data", canUse("req2", "Bash", { command: "rm -rf /" }) + "\n");
    // not a question, and not answered yet — held open awaiting the user's decision
    expect(questionSurfaced).toBe(false);
    expect(approvals).toEqual([
      { sessionId, requestId: "req2", toolName: "Bash", summary: "rm -rf /" },
    ]);
    expect(writes(proc).find((w) => w.type === "control_response")).toBeUndefined();
  });

  it("approveTool allow → behavior:allow; deny → behavior:deny (clean message)", () => {
    const { driver, proc } = setupB();
    const { sessionId } = driver.newSession("go");

    proc.stdout.emit("data", canUse("rA", "Bash", { command: "ls" }) + "\n");
    expect(driver.approveTool(sessionId, "rA", "allow")).toBe(true);
    const allow = writes(proc).find((w) => w.response?.request_id === "rA");
    expect(allow.response.response.behavior).toBe("allow");
    // a second decision is a no-op (no longer pending)
    expect(driver.approveTool(sessionId, "rA", "allow")).toBe(false);

    proc.stdout.emit("data", canUse("rB", "Bash", { command: "rm x" }) + "\n");
    expect(driver.approveTool(sessionId, "rB", "deny")).toBe(true);
    const deny = writes(proc).find((w) => w.response?.request_id === "rB");
    expect(deny.response.response.behavior).toBe("deny");
    expect(deny.response.response.message).toBeTruthy();
  });

  it("answerPermission/declinePermission reject an approval requestId (kind guard)", () => {
    const { driver, proc } = setupB();
    const { sessionId } = driver.newSession("go");
    proc.stdout.emit("data", canUse("rK", "Bash", { command: "ls" }) + "\n");
    // these are AskUserQuestion paths — must not touch an approval row
    expect(driver.answerPermission(sessionId, "rK", { x: "y" })).toBe(false);
    expect(driver.declinePermission(sessionId, "rK")).toBe(false);
    // the proper path still resolves it
    expect(driver.approveTool(sessionId, "rK", "deny")).toBe(true);
  });

  it("recovered approval (process gone) is cleared via dropApproval, not approveTool", () => {
    const { driver, proc, pendingStore, bus } = setupB();
    const { sessionId } = driver.newSession("go");
    proc.stdout.emit("data", canUse("rD", "Bash", { command: "ls" }) + "\n");
    expect(pendingStore.rows.has("rD")).toBe(true);
    // process dies mid-approval → durable row is KEPT (recoverable), proc gone
    proc.emit("close", 1);
    expect(driver.approveTool(sessionId, "rD", "allow")).toBe(false); // no live proc
    expect(pendingStore.rows.has("rD")).toBe(true); // still lingering
    let cancelled: string | null = null;
    bus.on("claude:permission_cancel", (_s, rid) => (cancelled = rid));
    expect(driver.dropApproval(sessionId, "rD")).toBe(true); // drop the stale row
    expect(pendingStore.rows.has("rD")).toBe(false);
    expect(cancelled).toBe("rD");
    expect(driver.dropApproval(sessionId, "rD")).toBe(false); // idempotent
  });

  it("control_cancel_request drops the pending ask and notifies the client", () => {
    const { driver, proc, bus, pendingStore } = setupB();
    let cancelled = "";
    bus.on("claude:permission_cancel", (_s, rid) => (cancelled = rid));
    const { sessionId } = driver.newSession("ask");
    proc.stdout.emit("data", canUse("req3", "AskUserQuestion", ASK_INPUT) + "\n");
    proc.stdout.emit("data", JSON.stringify({ type: "control_cancel_request", request_id: "req3" }) + "\n");
    expect(cancelled).toBe("req3");
    expect(pendingStore.rows.has("req3")).toBe(false); // durable row removed
    expect(driver.answerPermission(sessionId, "req3", { "Pick?": "A" })).toBe(false);
  });

  it("persists on surface and KEEPS the durable row across a process close (recoverable)", () => {
    const { driver, proc, pendingStore } = setupB();
    driver.newSession("ask");
    proc.stdout.emit("data", canUse("req4", "AskUserQuestion", ASK_INPUT) + "\n");
    expect(pendingStore.rows.has("req4")).toBe(true); // persisted on surface
    proc.emit("close", 0);
    expect(pendingStore.rows.has("req4")).toBe(true); // crash keeps it for recovery
  });

  it("answerPermission removes the durable row; listPending reports live status", () => {
    const { driver, proc, pendingStore } = setupB();
    const { sessionId } = driver.newSession("ask");
    proc.stdout.emit("data", canUse("req5", "AskUserQuestion", ASK_INPUT) + "\n");
    const listed = driver.listPending(sessionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ requestId: "req5", live: true });
    driver.answerPermission(sessionId, "req5", { "Pick?": "A" });
    expect(pendingStore.rows.has("req5")).toBe(false);
    expect(driver.listPending(sessionId)).toHaveLength(0);
  });

  it("listPending marks a persisted-but-dead ask as not live", () => {
    const { driver, pendingStore } = setupB();
    pendingStore.rows.set("rDead", {
      requestId: "rDead",
      sessionId: "S9",
      toolName: "AskUserQuestion",
      questions: [{ question: "Pick?", options: [{ label: "A" }] }],
      createdAt: "t",
    });
    const listed = driver.listPending("S9");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ requestId: "rDead", live: false });
  });

  it("done clears durable rows for the session", () => {
    const { driver, proc, pendingStore } = setupB();
    const { sessionId } = driver.newSession("ask");
    proc.stdout.emit("data", canUse("req6", "AskUserQuestion", ASK_INPUT) + "\n");
    expect(pendingStore.rows.has("req6")).toBe(true);
    proc.stdout.emit(
      "data",
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\n",
    );
    expect(pendingStore.rows.size).toBe(0);
    void sessionId;
  });

  it("recoverAnswerPermission resumes and auto-answers the re-issued question (after restart)", async () => {
    const { driver, proc, bus, spawnFn, pendingStore } = setupB();
    // simulate a row left from a previous (now-dead) agent process
    pendingStore.rows.set("rOld", {
      requestId: "rOld",
      sessionId: "S1",
      toolName: "AskUserQuestion",
      questions: [{ question: "Pick?", options: [{ label: "A" }, { label: "B" }] }],
      createdAt: "t",
    });
    let surfaced = false;
    bus.on("claude:permission_request", () => (surfaced = true));

    const ok = await driver.recoverAnswerPermission("S1", "rOld", { "Pick?": "A" });
    expect(ok).toBe(true);
    expect(pendingStore.rows.has("rOld")).toBe(false); // durable row consumed
    const args = spawnFn.mock.calls[0][1] as string[];
    expect(args).toContain("--resume"); // resumed the session

    // the model re-issues the question with a NEW request id → auto-answered, not surfaced
    proc.stdout.emit("data", canUse("rNew", "AskUserQuestion", ASK_INPUT) + "\n");
    expect(surfaced).toBe(false);
    const resp = writes(proc).find(
      (w) => w.type === "control_response" && w.response?.response?.behavior === "allow",
    );
    expect(resp.response.response.updatedInput.answers).toEqual({ "Pick?": "A" });
  });

  it("recoverAnswerPermission returns false when no durable row exists", async () => {
    const { driver } = setupB();
    expect(await driver.recoverAnswerPermission("S1", "nope", { "Pick?": "A" })).toBe(false);
  });

  it("declinePermission closes the picker with allow + no answers (clean decline)", () => {
    const { driver, proc, bus, pendingStore } = setupB();
    let cancelled = "";
    bus.on("claude:permission_cancel", (_s, rid) => (cancelled = rid));
    const { sessionId } = driver.newSession("ask");
    proc.stdout.emit("data", canUse("req7", "AskUserQuestion", ASK_INPUT) + "\n");
    expect(driver.declinePermission(sessionId, "req7")).toBe(true);
    const resp = writes(proc).find(
      (w) => w.type === "control_response" && w.response?.response?.behavior === "allow",
    );
    expect(resp.response.response.updatedInput.answers).toBeUndefined(); // declined: no answers
    expect(cancelled).toBe("req7");
    expect(pendingStore.rows.has("req7")).toBe(false);
    expect(driver.declinePermission(sessionId, "req7")).toBe(false); // no longer pending
  });

  it("answerPermission keeps the request when the stdin write fails (no lost answer)", () => {
    const { driver, proc, pendingStore } = setupB();
    const { sessionId } = driver.newSession("ask");
    proc.stdout.emit("data", canUse("req8", "AskUserQuestion", ASK_INPUT) + "\n");
    proc.stdin.destroyed = true; // simulate the process dying mid-flight
    expect(driver.answerPermission(sessionId, "req8", { "Pick?": "A" })).toBe(false);
    // durable row preserved so the HTTP layer can fall back to resume-recovery
    expect(pendingStore.rows.has("req8")).toBe(true);
  });
});
