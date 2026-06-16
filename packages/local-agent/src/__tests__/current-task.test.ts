import { describe, expect, it, vi } from "vitest";
import { CurrentTaskSummarizer } from "../current-task.js";
import { Bus } from "../bus.js";
import type { ClaudeStore } from "../claude-store.js";
import type { ClaudeMessage } from "@mac/shared";

function msg(role: "user" | "assistant", text: string, i: number): ClaudeMessage {
  return { id: `m${i}`, sessionId: "s", role, blocks: [{ kind: "text", text }], timestamp: `t${i}` };
}

/** Minimal ClaudeStore stub exposing only what the summarizer touches. */
function fakeStore(messages: ClaudeMessage[], refresh: (id: string) => void): ClaudeStore {
  return {
    async getSession() {
      return {
        session: { id: "s", cwd: "/proj", messageCount: messages.length } as never,
        messages,
        total: messages.length,
        offset: 0,
      };
    },
    refreshSession: (id: string) => {
      refresh(id);
      return Promise.resolve();
    },
  } as unknown as ClaudeStore;
}

describe("CurrentTaskSummarizer", () => {
  it("summarizes on drive_done and broadcasts the refresh", async () => {
    const bus = new Bus();
    const refreshed: string[] = [];
    const store = fakeStore([msg("user", "重构监控台", 1)], (id) => refreshed.push(id));
    const summarizeFn = vi.fn(async () => "重构监控台项目过滤");
    const s = new CurrentTaskSummarizer({ store, bus, summarizeFn });
    s.start();
    bus.emit("claude:drive_done", "s", "ts");
    await vi.waitFor(() => expect(s.get("s")).toBe("重构监控台项目过滤"));
    expect(refreshed).toContain("s");
    expect(summarizeFn).toHaveBeenCalledTimes(1);
  });

  it("clips an over-long summary and strips quotes", async () => {
    const bus = new Bus();
    const store = fakeStore([msg("user", "做事", 1)], () => {});
    const long = "「" + "字".repeat(40) + "」";
    const s = new CurrentTaskSummarizer({ store, bus, summarizeFn: async () => long });
    s.start();
    bus.emit("claude:drive_done", "s", "ts");
    await vi.waitFor(() => expect(s.get("s")).toBeTruthy());
    const out = s.get("s")!;
    expect(out.startsWith("「")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(25);
  });

  it("dedups: does not re-summarize when message count is unchanged", async () => {
    const bus = new Bus();
    const store = fakeStore([msg("user", "做事", 1)], () => {});
    const summarizeFn = vi.fn(async () => "做事中");
    const s = new CurrentTaskSummarizer({ store, bus, summarizeFn });
    s.start();
    bus.emit("claude:drive_done", "s", "ts");
    await vi.waitFor(() => expect(s.get("s")).toBe("做事中"));
    bus.emit("claude:drive_done", "s", "ts2");
    await new Promise((r) => setTimeout(r, 20));
    expect(summarizeFn).toHaveBeenCalledTimes(1);
  });
});
