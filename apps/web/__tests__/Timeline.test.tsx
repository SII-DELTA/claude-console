import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Timeline, buildTimeline } from "../components/Timeline";
import type { ClaudeMessage } from "@mac/shared";

function msg(partial: Partial<ClaudeMessage>): ClaudeMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    timestamp: "2026-06-11T00:00:00.000Z",
    blocks: [],
    ...partial,
  };
}

describe("Timeline", () => {
  it("renders assistant text", () => {
    render(<Timeline messages={[msg({ blocks: [{ kind: "text", text: "hello world" }] })]} />);
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("renders a tool row with name + arg, collapsed by default", () => {
    render(
      <Timeline
        messages={[msg({ blocks: [{ kind: "tool_use", toolName: "Bash", input: { command: "ls" } }] })]}
      />,
    );
    expect(screen.getByText(/Bash/)).toBeInTheDocument();
    expect(screen.getByText("ls")).toBeInTheDocument();
  });

  it("collapses thinking behind a toggle", () => {
    render(<Timeline messages={[msg({ blocks: [{ kind: "thinking", text: "secret" }] })]} />);
    expect(screen.getByText(/思考/)).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("pairs a tool_use with its tool_result by id (result hidden until expanded)", () => {
    const items = buildTimeline([
      msg({ id: "a", blocks: [{ kind: "tool_use", toolName: "Bash", input: { command: "ls" }, toolUseId: "t1" }] }),
      msg({
        id: "b",
        role: "user",
        blocks: [{ kind: "tool_result", toolUseId: "t1", content: "file.txt" }],
      }),
    ]);
    // one timeline item (the tool), result attached, not a separate user bubble
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", name: "Bash", result: "file.txt" });
  });

  it("keeps real user text as its own item", () => {
    const items = buildTimeline([msg({ id: "u", role: "user", blocks: [{ kind: "text", text: "hi" }] })]);
    expect(items).toEqual([{ kind: "user", id: "u", text: "hi" }]);
  });
});
