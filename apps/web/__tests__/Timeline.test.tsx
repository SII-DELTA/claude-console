import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Timeline, buildTimeline } from "../components/Timeline";
import { useAppStore } from "../lib/store";
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

describe("Timeline send receipt (方案 B)", () => {
  afterEach(() => useAppStore.setState({ sendStatus: null }));

  function renderWithStatus(state: "sending" | "delivered" | "read" | "failed") {
    useAppStore.setState({ sendStatus: { sessionId: "s1", messageId: "u", state } });
    render(<Timeline messages={[msg({ id: "u", role: "user", blocks: [{ kind: "text", text: "hi" }] })]} />);
  }

  it("shows 发送中/已送达/已读/失败 under the matching user bubble", () => {
    renderWithStatus("sending");
    expect(screen.getByText("发送中…")).toBeInTheDocument();
  });

  it("shows 已读·处理中 for the read state", () => {
    renderWithStatus("read");
    expect(screen.getByText(/已读·处理中/)).toBeInTheDocument();
  });

  it("shows nothing when the receipt targets a different message", () => {
    useAppStore.setState({ sendStatus: { sessionId: "s1", messageId: "other", state: "delivered" } });
    render(<Timeline messages={[msg({ id: "u", role: "user", blocks: [{ kind: "text", text: "hi" }] })]} />);
    expect(screen.queryByText("已送达 ✓")).not.toBeInTheDocument();
  });
});
