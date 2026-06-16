import { describe, expect, it } from "vitest";
import {
  accumulate,
  deriveActivity,
  deriveLastUser,
  deriveResult,
  newAccumulator,
  parseLine,
  type SessionAccumulator,
} from "../util/claude-jsonl.js";

/** Build an accumulator from raw jsonl entry objects. */
function fold(entries: unknown[]): SessionAccumulator {
  const acc = newAccumulator();
  for (const e of entries) {
    const parsed = parseLine(JSON.stringify(e));
    if (parsed) accumulate(acc, parsed, false);
  }
  return acc;
}

const user = (text: string, i: number) => ({
  type: "user",
  uuid: `u${i}`,
  sessionId: "s",
  timestamp: `2026-06-16T00:0${i}:00Z`,
  message: { role: "user", content: [{ type: "text", text }] },
});

const assistantText = (text: string, i: number) => ({
  type: "assistant",
  uuid: `a${i}`,
  sessionId: "s",
  timestamp: `2026-06-16T00:0${i}:30Z`,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const assistantTool = (name: string, input: unknown, i: number) => ({
  type: "assistant",
  uuid: `t${i}`,
  sessionId: "s",
  timestamp: `2026-06-16T00:0${i}:40Z`,
  message: { role: "assistant", content: [{ type: "tool_use", id: `id${i}`, name, input }] },
});

describe("deriveLastUser", () => {
  it("returns the latest user instruction, not the first", () => {
    const acc = fold([user("第一个任务", 1), assistantText("好的", 1), user("现在改另一个任务", 2)]);
    expect(deriveLastUser(acc)).toBe("现在改另一个任务");
  });

  it("is undefined when there is no user text", () => {
    expect(deriveLastUser(newAccumulator())).toBeUndefined();
  });

  it("clips very long instructions", () => {
    const long = "改".repeat(200);
    const out = deriveLastUser(fold([user(long, 1)]))!;
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(121);
  });
});

describe("deriveActivity", () => {
  it("describes the most recent tool action", () => {
    const acc = fold([
      user("跑测试", 1),
      assistantTool("Read", { file_path: "/a/b/store.ts" }, 1),
      assistantTool("Bash", { command: "npm test" }, 2),
    ]);
    expect(deriveActivity(acc)).toBe("运行 npm test");
  });

  it("uses the file basename for edits", () => {
    const acc = fold([user("改文件", 1), assistantTool("Edit", { file_path: "/x/y/Dashboard.tsx" }, 1)]);
    expect(deriveActivity(acc)).toBe("编辑 Dashboard.tsx");
  });

  it("is undefined when no tool ran", () => {
    expect(deriveActivity(fold([user("hi", 1), assistantText("hello", 1)]))).toBeUndefined();
  });
});

describe("deriveResult", () => {
  it("returns the first line of the assistant's last text", () => {
    const acc = fold([user("做事", 1), assistantText("已完成重构。\n细节略", 1)]);
    expect(deriveResult(acc)).toBe("已完成重构。");
  });

  it("ignores trailing tool_use and keeps the last text", () => {
    const acc = fold([
      user("做事", 1),
      assistantText("第一步说明", 1),
      assistantText("最终结论", 2),
      assistantTool("Bash", { command: "ls" }, 3),
    ]);
    expect(deriveResult(acc)).toBe("最终结论");
  });
});
