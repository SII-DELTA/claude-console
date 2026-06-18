"use client";

import { useEffect, useRef, useState } from "react";

export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

/** Safely coerce an AskUserQuestion tool_use input into questions, or null. */
export function parseAskUserQuestion(input: unknown): AskQuestion[] | null {
  if (!input || typeof input !== "object") return null;
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: AskQuestion[] = [];
  for (const q of qs) {
    if (!q || typeof q !== "object") continue;
    const opts = (q as { options?: unknown }).options;
    if (!Array.isArray(opts)) continue;
    out.push({
      question: String((q as any).question ?? ""),
      header: (q as any).header ? String((q as any).header) : undefined,
      multiSelect: !!(q as any).multiSelect,
      options: opts
        .filter((o) => o && typeof o === "object" && "label" in o)
        .map((o) => ({ label: String((o as any).label), description: (o as any).description })),
    });
  }
  return out.length ? out : null;
}

/**
 * Find an AskUserQuestion in the last assistant message whose answer hasn't been
 * provided yet. Returns the questions to render, or null.
 *
 * Note: the web console drives Claude as a headless subprocess with no TTY, so
 * an interactive AskUserQuestion can't be answered at the CLI level — it fails
 * immediately with an `isError` tool_result (content `"Answer questions?"`). We
 * must NOT treat that error as "answered", or the picker would never show. Only
 * a successful (non-error) tool_result — i.e. a real answer — counts as answered.
 */
export function findPendingQuestions(
  messages: { role: string; blocks: any[] }[],
): AskQuestion[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const ask = m.blocks.find((b) => b.kind === "tool_use" && b.toolName === "AskUserQuestion");
    if (!ask) return null; // most recent assistant turn has no question
    // answered only if a later message carries a NON-error tool_result for this
    // tool id (a real answer). Error results — e.g. the headless "Answer
    // questions?" failure — do not count, so the picker still renders.
    const answered = messages
      .slice(i + 1)
      .some((later) =>
        later.blocks.some(
          (b) => b.kind === "tool_result" && b.toolUseId === ask.toolUseId && !b.isError,
        ),
      );
    if (answered) return null;
    return parseAskUserQuestion(ask.input);
  }
  return null;
}

/** A user's selection for one question: the question text and chosen labels. */
export interface AskAnswer {
  question: string;
  multiSelect: boolean;
  labels: string[];
}

/** Render AskUserQuestion option cards; supports single + multi select. */
export function QuestionPanel({
  questions,
  onSubmit,
  onClose,
  closeTitle,
  disabled,
}: {
  questions: AskQuestion[];
  /** receives both a human-readable string (方案 A) and structured answers (方案 B). */
  onSubmit: (answer: string, structured: AskAnswer[]) => void;
  /** close the picker without answering (✕). */
  onClose?: () => void;
  closeTitle?: string;
  disabled?: boolean;
}) {
  // selected[qIndex] = set of chosen labels
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  // one-question-at-a-time: which question's card is showing, and whether collapsed.
  const [active, setActive] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  // when the card first appears, pull it into view and flash a highlight —
  // an in-page stand-in for a system popup (which http can't deliver).
  const ref = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(true);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setFlash(false), 1800);
    return () => clearTimeout(t);
  }, []);

  const isAnswered = (qi: number) => (selected[qi]?.length ?? 0) > 0;
  const answeredCount = questions.reduce((n, _, qi) => n + (isAnswered(qi) ? 1 : 0), 0);
  const multi = questions.length > 1;

  function choose(qi: number, label: string, isMulti: boolean) {
    setSelected((prev) => {
      const cur = prev[qi] ?? [];
      if (isMulti) {
        return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [qi]: cur[0] === label ? [] : [label] };
    });
    // single-select: advance to the next unanswered question (desktop-like flow).
    if (!isMulti) {
      const nextUnanswered = questions.findIndex((_, i) => i > qi && !isAnswered(i));
      if (nextUnanswered >= 0) setActive(nextUnanswered);
    }
  }

  const anySelected = answeredCount > 0;
  const cur = questions[Math.min(active, questions.length - 1)];
  const curIdx = Math.min(active, questions.length - 1);

  function submit() {
    const parts = questions.map((q, qi) => {
      const chosen = selected[qi] ?? [];
      const head = q.header || q.question;
      return `${head}：${chosen.join("、")}`;
    });
    const structured: AskAnswer[] = questions.map((q, qi) => ({
      question: q.question,
      multiSelect: !!q.multiSelect,
      labels: selected[qi] ?? [],
    }));
    onSubmit(parts.join("\n"), structured);
    setSelected({});
  }

  return (
    <div
      ref={ref}
      className={`mx-auto mb-2 max-w-3xl rounded-2xl border bg-bg-alt p-3 transition-shadow duration-700 ${
        flash ? "border-accent shadow-[0_0_0_3px_rgba(217,119,87,0.35)]" : "border-accent/30"
      }`}
    >
      {/* Header row: tabs / summary take the flexible space; collapse + close are
          dedicated slots so they can never overlap the title text. */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {collapsed ? (
            <div className="flex h-6 items-center gap-2 text-[12px] text-ink-dim">
              <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[11px] font-medium text-accent">待你选择</span>
              <span className="truncate">
                {questions.length} 个问题 · {answeredCount}/{questions.length} 已答
              </span>
            </div>
          ) : multi ? (
            <div className="flex gap-1 overflow-x-auto pb-0.5 scroll-thin">
              {questions.map((q, qi) => (
                <button
                  key={qi}
                  onClick={() => setActive(qi)}
                  className={`flex shrink-0 max-w-[8.5rem] items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition ${
                    qi === curIdx
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-line text-ink-dim hover:border-accent/50"
                  }`}
                >
                  {isAnswered(qi) && <span className="text-[10px] text-accent">✓</span>}
                  <span className="truncate">{q.header || `问题${qi + 1}`}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[11px] font-medium text-accent">待你选择</span>
          )}
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "展开" : "折叠（先看上面的内容）"}
          aria-label={collapsed ? "展开" : "折叠"}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-faint transition-colors hover:bg-bg-raised hover:text-ink"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" className={collapsed ? "" : "rotate-180"}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {onClose && (
          <button
            onClick={onClose}
            disabled={disabled}
            title={closeTitle ?? "关闭（不回答）"}
            aria-label={closeTitle ?? "关闭（不回答）"}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-faint transition-colors hover:bg-bg-raised hover:text-ink"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {!collapsed && cur && (
        <>
          <div className="mb-2 mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {cur.header && (
              <span className="shrink-0 rounded-full bg-accent/20 px-2 py-0.5 text-[11px] font-medium text-accent">
                {cur.header}
              </span>
            )}
            <span className="min-w-0 break-words text-sm font-medium text-ink">{cur.question}</span>
            {cur.multiSelect && <span className="shrink-0 text-[11px] text-ink-faint">（可多选）</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            {cur.options.map((o) => {
              const on = (selected[curIdx] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  disabled={disabled}
                  onClick={() => choose(curIdx, o.label, !!cur.multiSelect)}
                  className={`rounded-xl border px-3 py-2 text-left transition ${
                    on ? "border-accent bg-accent/15" : "border-line bg-bg-raised hover:border-accent/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`grid h-4 w-4 shrink-0 place-items-center border text-[10px] ${
                        cur.multiSelect ? "rounded" : "rounded-full"
                      } ${on ? "border-accent bg-accent text-bg" : "border-ink-faint"}`}
                    >
                      {on ? "✓" : ""}
                    </span>
                    <span className="min-w-0 break-words text-sm font-medium text-ink">{o.label}</span>
                  </div>
                  {o.description && (
                    <p className="mt-1 pl-6 text-[12px] leading-snug text-ink-dim break-words">{o.description}</p>
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-2">
            {multi && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setActive((a) => Math.max(0, a - 1))}
                  disabled={curIdx === 0}
                  className="rounded-lg border border-line px-2 py-1 text-[12px] text-ink-dim hover:bg-bg-raised disabled:opacity-30"
                >
                  上一题
                </button>
                <button
                  onClick={() => setActive((a) => Math.min(questions.length - 1, a + 1))}
                  disabled={curIdx === questions.length - 1}
                  className="rounded-lg border border-line px-2 py-1 text-[12px] text-ink-dim hover:bg-bg-raised disabled:opacity-30"
                >
                  下一题
                </button>
                <span className="ml-1 text-[11px] text-ink-faint">{answeredCount}/{questions.length} 已答</span>
              </div>
            )}
            <button onClick={submit} disabled={disabled || !anySelected} className="btn !py-1.5 ml-auto text-sm">
              提交选择
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-ink-faint">也可在下方输入框自由回复</p>
        </>
      )}
    </div>
  );
}
