import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeStore } from "../claude-store.js";
import { Bus } from "../bus.js";
import { accumulate, deriveAttention, encodeProjectDir, newAccumulator, parseLine } from "../util/claude-jsonl.js";
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

  it("extracts context tokens from an assistant turn's usage (input + cache read + creation)", () => {
    const p = parseLine(
      line({
        type: "assistant",
        uuid: "a1",
        sessionId: "s1",
        timestamp: "2026-06-11T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 2704, cache_read_input_tokens: 15853, cache_creation_input_tokens: 3731, output_tokens: 456 },
        },
      }),
    );
    expect(p?.contextTokens).toBe(2704 + 15853 + 3731);
    // accumulator keeps the latest turn's value
    const acc = newAccumulator();
    accumulate(acc, p!, false);
    expect(acc.contextTokens).toBe(22288);
  });
});

describe("deriveAttention", () => {
  function fold(lines: string[]) {
    const acc = newAccumulator();
    for (const l of lines) {
      const p = parseLine(l);
      if (p) accumulate(acc, p, false);
    }
    return acc;
  }
  let n = 0;
  const uid = () => `m${++n}`;
  const userMsg = (text: string) =>
    line({ type: "user", uuid: uid(), sessionId: "s", message: { role: "user", content: [{ type: "text", text }] } });
  const askMsg = (id: string) =>
    line({
      type: "assistant",
      uuid: uid(),
      sessionId: "s",
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: {} }] },
    });
  const answerMsg = (id: string) =>
    line({
      type: "user",
      uuid: uid(),
      sessionId: "s",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    });
  const textReply = (text: string) =>
    line({ type: "assistant", uuid: uid(), sessionId: "s", message: { role: "assistant", content: [{ type: "text", text }] } });

  it("flags an unanswered AskUserQuestion as 'question' (even when live)", () => {
    const acc = fold([userMsg("hi"), askMsg("q1")]);
    expect(deriveAttention(acc, false)).toBe("question");
    expect(deriveAttention(acc, true)).toBe("question");
  });

  it("clears the question once a non-error tool_result answers it", () => {
    const acc = fold([userMsg("hi"), askMsg("q1"), answerMsg("q1"), textReply("done")]);
    expect(deriveAttention(acc, false)).toBe("done");
  });

  it("skips dismissed question ids (no longer 'question')", () => {
    const acc = fold([userMsg("hi"), askMsg("q1")]);
    expect(deriveAttention(acc, false, new Set(["q1"]))).not.toBe("question");
    // an un-dismissed open question still flags
    const acc2 = fold([userMsg("hi"), askMsg("q1"), askMsg("q2")]);
    expect(deriveAttention(acc2, false, new Set(["q1"]))).toBe("question");
  });

  it("flags a finished, non-live conversation as 'done'", () => {
    const acc = fold([userMsg("hi"), textReply("here you go")]);
    expect(deriveAttention(acc, false)).toBe("done");
    expect(deriveAttention(acc, true)).toBeUndefined();
  });

  it("clears a question superseded by a later user message (not 'question')", () => {
    // user ignored the question and just typed something else → no longer awaiting
    const acc = fold([userMsg("hi"), askMsg("q1"), userMsg("actually do this instead"), textReply("ok")]);
    expect(deriveAttention(acc, false)).toBe("done");
  });

  it("clears a question answered by an error tool_result (auto-deny, not 'question')", () => {
    const errAnswer = (id: string) =>
      line({
        type: "user",
        uuid: uid(),
        sessionId: "s",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "denied", is_error: true }] },
      });
    const acc = fold([userMsg("hi"), askMsg("q1"), errAnswer("q1"), textReply("moving on")]);
    expect(deriveAttention(acc, false)).toBe("done");
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

  it("opens a session living in a non-active project dir (cross-project, no 404)", async () => {
    // A session in another project — the dashboard/sessions lists are cross-project, so
    // clicking it must resolve even though the active project dir is workspaceRoot.
    const otherCwd = "/Users/test/elsewhere";
    const otherId = "abcdef01-2222-3333-4444-555555555555";
    const dir = join(projectsRoot, encodeProjectDir(otherCwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `${otherId}.jsonl`), fixture(otherCwd).replaceAll(SESSION_ID, otherId));

    // active project is still workspaceRoot (no switchProject)
    const detail = await store.getSession(otherId);
    expect(detail).not.toBeNull();
    expect(detail!.messages.length).toBeGreaterThan(0);
    // just-written file resolves cross-project for liveness/size/tail too
    expect(await store.isLive(otherId)).toBe(true);
    expect(await store.sessionFileSize(otherId)).toBeGreaterThan(0);
    const tail = await store.tail(otherId, 0);
    expect(tail).not.toBeNull();
  });

  it("cwdOfSession resolves cross-project from the JSONL (for desktop inject)", async () => {
    expect(await store.cwdOfSession(SESSION_ID)).toBe(workspaceRoot);
    // a session in another project (active dir is still workspaceRoot) still resolves
    const otherCwd = "/Users/test/elsewhere2";
    const otherId = "cccccccc-2222-3333-4444-555555555555";
    const dir = join(projectsRoot, encodeProjectDir(otherCwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `${otherId}.jsonl`), fixture(otherCwd).replaceAll(SESSION_ID, otherId));
    expect(await store.cwdOfSession(otherId)).toBe(otherCwd);
    expect(await store.cwdOfSession("99999999-0000-0000-0000-000000000000")).toBeNull();
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

  it("tail fast-path equals the full-fold slice (incl. meta lines, tools, 多字节)", async () => {
    // Build a longer session: interleaved meta lines + many turns, a tool_use/result pair,
    // and multi-byte (Chinese) text spanning enough bytes to cross the reverse-read chunking.
    const bigId = "beefbeef-2222-3333-4444-555555555555";
    const dir = join(projectsRoot, encodeProjectDir(workspaceRoot));
    const lines: string[] = [line({ type: "ai-title", sessionId: bigId, aiTitle: "大会话 标题" })];
    for (let i = 0; i < 40; i++) {
      lines.push(
        line({
          type: "user",
          uuid: `u${i}`,
          sessionId: bigId,
          cwd: workspaceRoot,
          timestamp: `2026-06-11T00:${String(i).padStart(2, "0")}:01.000Z`,
          message: { role: "user", content: [{ type: "text", text: `第 ${i} 条问题，包含中文与 emoji 🚀 用于跨字节边界` }] },
        }),
      );
      if (i % 7 === 0) lines.push(line({ type: "queue-operation", operation: "enqueue", sessionId: bigId })); // meta noise
      lines.push(
        line({
          type: "assistant",
          uuid: `a${i}`,
          sessionId: bigId,
          timestamp: `2026-06-11T00:${String(i).padStart(2, "0")}:02.000Z`,
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [
              { type: "text", text: `回答 ${i}` },
              { type: "tool_use", id: `tool_${i}`, name: "Bash", input: { command: `echo ${i}` } },
            ],
          },
        }),
      );
      lines.push(
        line({
          type: "user",
          uuid: `r${i}`,
          sessionId: bigId,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tool_${i}`, content: `out ${i}` }] },
        }),
      );
    }
    await fs.writeFile(join(dir, `${bigId}.jsonl`), lines.join(""));

    const full = (await store.getSession(bigId))!; // whole-history (full-fold) path = ground truth
    expect(full.messages.length).toBe(full.total);
    expect(full.total).toBe(120); // 40 * (user + assistant + tool_result)

    for (const k of [1, 5, 37, full.total, full.total + 10]) {
      const page = (await store.getSession(bigId, { limit: k }))!;
      const start = Math.max(0, full.total - k);
      expect(page.total).toBe(full.total);
      expect(page.cursor).toBe(full.cursor);
      expect(page.offset).toBe(start);
      expect(page.messages).toEqual(full.messages.slice(start)); // 逐条等价
    }

    // tail page + an earlier (before) page must stitch back to the full history with no gap/overlap
    const tail = (await store.getSession(bigId, { limit: 30 }))!;
    const earlier = (await store.getSession(bigId, { before: tail.offset, limit: 1000 }))!;
    expect([...earlier.messages, ...tail.messages]).toEqual(full.messages);
  });

  it("tail path drops an in-progress (newline-less, unparseable) trailing line", async () => {
    const dir = join(projectsRoot, encodeProjectDir(workspaceRoot));
    // a complete session followed by a half-written final line (no trailing \n, invalid JSON)
    await fs.writeFile(join(dir, `${SESSION_ID}.jsonl`), fixture(workspaceRoot) + '{"type":"assist');
    const page = (await store.getSession(SESSION_ID, { limit: 10 }))!;
    expect(page.total).toBe(3); // the partial line is not a message
    expect(page.messages).toHaveLength(3);
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

  it("flags hidden projects and excludes their sessions from the overview", async () => {
    const dir = encodeProjectDir(workspaceRoot);
    expect((await store.listAllSessions()).length).toBe(1);
    store.setHiddenProjects([dir]);
    const projects = await store.listProjects();
    expect(projects.find((p) => p.dir === dir)?.hidden).toBe(true);
    // hidden project's sessions drop out of the cross-project overview
    expect(await store.listAllSessions()).toHaveLength(0);
    store.removeHiddenProject(dir);
    expect((await store.listAllSessions()).length).toBe(1);
  });

  it("synthesizes a 0-session entry for a pinned cwd with no project dir yet", async () => {
    const newCwd = "/Users/test/brand-new";
    store.setPinnedProjects([newCwd]);
    const p = (await store.listProjects()).find((x) => x.cwd === newCwd);
    expect(p).toBeTruthy();
    expect(p!.pinned).toBe(true);
    expect(p!.sessionCount).toBe(0);
    expect(p!.dir).toBe(encodeProjectDir(newCwd));
  });

  it("listDir returns folders only, with parent + home", async () => {
    await fs.mkdir(join(root, "sub-a"), { recursive: true });
    await fs.mkdir(join(root, "sub-b"), { recursive: true });
    await fs.writeFile(join(root, "a-file.txt"), "x");
    const res = await store.listDir(root);
    expect(res.path).toBe(root);
    expect(res.parent).toBe(join(root, ".."));
    const names = res.entries.map((e) => e.name);
    expect(names).toContain("sub-a");
    expect(names).toContain("sub-b");
    expect(names).not.toContain("a-file.txt"); // files excluded
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
