import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuestionPanel, parseAskUserQuestion, findPendingQuestions } from "../components/QuestionPanel";

// jsdom has no scrollIntoView; QuestionPanel calls it on mount.
Element.prototype.scrollIntoView = vi.fn();

describe("parseAskUserQuestion", () => {
  it("parses a valid AskUserQuestion input", () => {
    const qs = parseAskUserQuestion({
      questions: [
        { question: "Pick one", header: "H", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
      ],
    });
    expect(qs).toHaveLength(1);
    expect(qs![0]!.options.map((o) => o.label)).toEqual(["A", "B"]);
  });

  it("returns null for garbage", () => {
    expect(parseAskUserQuestion(null)).toBeNull();
    expect(parseAskUserQuestion({ questions: [] })).toBeNull();
    expect(parseAskUserQuestion({ nope: 1 })).toBeNull();
  });
});

describe("findPendingQuestions", () => {
  const askBlock = {
    kind: "tool_use",
    toolName: "AskUserQuestion",
    toolUseId: "tu_1",
    input: { questions: [{ question: "Pick", header: "H", options: [{ label: "A" }, { label: "B" }] }] },
  };
  const assistantWithAsk = { role: "assistant", blocks: [{ kind: "text", text: "hi" }, askBlock] };

  it("returns the questions when there is no tool_result yet", () => {
    const qs = findPendingQuestions([assistantWithAsk]);
    expect(qs).toHaveLength(1);
    expect(qs![0]!.options.map((o) => o.label)).toEqual(["A", "B"]);
  });

  it("still returns questions when the only result is an error (headless 'Answer questions?')", () => {
    const qs = findPendingQuestions([
      assistantWithAsk,
      { role: "user", blocks: [{ kind: "tool_result", toolUseId: "tu_1", content: "Answer questions?", isError: true }] },
    ]);
    expect(qs).toHaveLength(1);
  });

  it("returns null once a real (non-error) answer exists", () => {
    const qs = findPendingQuestions([
      assistantWithAsk,
      {
        role: "user",
        blocks: [{ kind: "tool_result", toolUseId: "tu_1", content: "Your questions have been answered", isError: false }],
      },
    ]);
    expect(qs).toBeNull();
  });

  it("returns null when the latest assistant turn has no question", () => {
    const qs = findPendingQuestions([
      assistantWithAsk,
      { role: "user", blocks: [{ kind: "tool_result", toolUseId: "tu_1", content: "x", isError: true }] },
      { role: "assistant", blocks: [{ kind: "text", text: "continuing" }] },
    ]);
    expect(qs).toBeNull();
  });
});

describe("QuestionPanel", () => {
  it("multi-select toggles multiple and submits joined labels", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionPanel
        questions={[
          { question: "Features?", header: "Feat", multiSelect: true, options: [{ label: "X" }, { label: "Y" }, { label: "Z" }] },
        ]}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByText("X"));
    fireEvent.click(screen.getByText("Z"));
    fireEvent.click(screen.getByText("提交选择"));
    // 方案 A text + 方案 B structured answers
    expect(onSubmit).toHaveBeenCalledWith("Feat：X、Z", [
      { question: "Features?", multiSelect: true, labels: ["X", "Z"] },
    ]);
  });

  it("single-select keeps only the last choice", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionPanel
        questions={[
          { question: "One?", header: "H", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
        ]}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByText("B"));
    fireEvent.click(screen.getByText("提交选择"));
    expect(onSubmit).toHaveBeenCalledWith("H：B", [
      { question: "One?", multiSelect: false, labels: ["B"] },
    ]);
  });
});
