import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeStore } from "../claude-store.js";
import { Bus } from "../bus.js";
import { encodeProjectDir, parseLine } from "../util/claude-jsonl.js";
import type { ClaudeMessage } from "@mac/shared";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function fixture(workspaceRoot: string): string {
  return [
    line({ type: "queue-operation", operation: "enqueue", sessionId: SESSION_ID }),
    line({ type: "ai-title", sessionId: SESSION_ID, aiTitle: "My Claude Session" }),
    line({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: SESSION_ID,
      cwd: workspaceRoot,
      timestamp: "2026-06-11T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello claude" }] },
    }),
    line({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: SESSION_ID,
      timestamp: "2026-06-11T00:00:02.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "running a command" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
        ],
      },
    }),
    line({
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId: SESSION_ID,
      timestamp: "2026-06-11T00:00:03.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" }],
      },
    }),
  ].join("");
}

describe("claude-jsonl parser", () => {
  it("encodes project dir like Claude Code", () => {
    expect(encodeProjectDir("/Users/Admin/Documents/project/agent_console")).toBe(
      "-Users-Admin-Documents-project-agent-console",
    );
  });

  it("parses assistant blocks", () => {
    const p = parseLine(
      line({
        type: "assistant",
        uuid: "a1",
        sessionId: "s",
        timestamp: "t",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    );
    expect(p?.message?.role).toBe("assistant");
    expect(p?.message?.blocks[0]).toEqual({ kind: "text", text: "hi" });
  });

  it("returns null for non-json", () => {
    expect(parseLine("not json")).toBeNull();
    expect(parseLine("")).toBeNull();
  });
});

describe("ClaudeStore", () => {
  let root: string;
  let projectsRoot: string;
  let workspaceRoot: string;
  let store: ClaudeStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "claude-store-"));
    projectsRoot = join(root, "projects");
    workspaceRoot = "/Users/test/proj";
    const dir = join(projectsRoot, encodeProjectDir(workspaceRoot));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `${SESSION_ID}.jsonl`), fixture(workspaceRoot));
    store = new ClaudeStore(workspaceRoot, "w1", new Bus(), projectsRoot);
  });

  afterEach(async () => {
    await store.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists sessions with structured counts and title", async () => {
    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.id).toBe(SESSION_ID);
    expect(s.title).toBe("My Claude Session");
    expect(s.messageCount).toBe(3);
    expect(s.userMessageCount).toBe(2);
    expect(s.assistantMessageCount).toBe(1);
    expect(s.toolUseCount).toBe(1);
    expect(s.modelId).toBe("claude-opus-4-8");
    expect(s.cwd).toBe(workspaceRoot);
  });

  it("lists projects and marks drivenByAgent via the predicate", async () => {
    store.setDrivenPredicate((id) => id === SESSION_ID);
    const projects = await store.listProjects();
    const p = projects.find((x) => x.dir === encodeProjectDir(workspaceRoot));
    expect(p).toBeTruthy();
    expect(p!.cwd).toBe(workspaceRoot);
    expect(p!.sessionCount).toBe(1);
    const sessions = await store.listSessions();
    expect(sessions[0]!.drivenByAgent).toBe(true);
  });

  it("switchProject points the store at another project dir", async () => {
    const otherCwd = "/Users/test/other";
    const otherDir = encodeProjectDir(otherCwd);
    const dir = join(projectsRoot, otherDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, "99999999-0000-0000-0000-000000000000.jsonl"),
      [
        line({ type: "ai-title", sessionId: "x", aiTitle: "Other Project" }),
        line({
          type: "user",
          uuid: "ou1",
          sessionId: "x",
          cwd: otherCwd,
          timestamp: "2026-06-11T01:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hi other" }] },
        }),
      ].join(""),
    );
    const proj = await store.switchProject(otherDir);
    expect(proj?.cwd).toBe(otherCwd);
    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.title).toBe("Other Project");
  });

  it("rejects path-traversal ids and project dirs", async () => {
    expect(await store.getSession("../../../../etc/hosts")).toBeNull();
    expect(await store.getSession("..%2f..")).toBeNull();
    expect(await store.isLive("../foo")).toBe(false);
    expect(await store.switchProject("../..")).toBeNull();
    expect(await store.switchProject("/etc")).toBeNull();
  });

  it("reads full session messages", async () => {
    const detail = await store.getSession(SESSION_ID);
    expect(detail).not.toBeNull();
    expect(detail!.messages).toHaveLength(3);
    expect(detail!.total).toBe(3);
    expect(detail!.offset).toBe(0);
    const assistant = detail!.messages.find((m) => m.role === "assistant")!;
    const kinds = assistant.blocks.map((b) => b.kind);
    expect(kinds).toEqual(["thinking", "text", "tool_use"]);
  });

  it("paginates messages with limit/before", async () => {
    const full = await store.getSession(SESSION_ID);
    expect(full!.total).toBe(3);

    // tail page: last 2 of 3 → offset 1
    const tail = await store.getSession(SESSION_ID, { limit: 2 });
    expect(tail!.total).toBe(3);
    expect(tail!.offset).toBe(1);
    expect(tail!.messages).toEqual(full!.messages.slice(1));

    // earlier page before index 1 → just the first message, offset 0
    const earlier = await store.getSession(SESSION_ID, { before: 1, limit: 2 });
    expect(earlier!.offset).toBe(0);
    expect(earlier!.messages).toEqual(full!.messages.slice(0, 1));

    // before past the end is clamped to total
    const clamped = await store.getSession(SESSION_ID, { before: 999, limit: 2 });
    expect(clamped!.messages).toEqual(full!.messages.slice(1));
  });

  it("emits claude:message when a new line is appended", { timeout: 15000 }, async () => {
    const bus = new Bus();
    const got: ClaudeMessage[] = [];
    bus.on("claude:message", (_id, m) => got.push(m));
    const live = new ClaudeStore(workspaceRoot, "w1", bus, projectsRoot);
    await live.start();
    const file = join(projectsRoot, encodeProjectDir(workspaceRoot), `${SESSION_ID}.jsonl`);
    await fs.appendFile(
      file,
      line({
        type: "assistant",
        uuid: "a2",
        sessionId: SESSION_ID,
        timestamp: "2026-06-11T00:00:04.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    );
    await waitFor(() => got.length > 0, 12000);
    await live.stop();
    expect(got.at(-1)?.blocks[0]).toEqual({ kind: "text", text: "done" });
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
