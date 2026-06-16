"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Allow/deny gate for a non-AskUserQuestion tool the model wants to run. Mirrors
 * the QuestionPanel look; two actions only — allow once or deny (no "always").
 */
export function ToolApprovalPanel({
  toolName,
  summary,
  onDecision,
  onClose,
  recovered,
  disabled,
}: {
  toolName: string;
  summary: string;
  onDecision: (decision: "allow" | "deny") => void;
  /** dismiss without deciding (used for a recovered, no-longer-live approval). */
  onClose?: () => void;
  /** true ⇒ recovered from the store (process gone); can't allow/deny, only dismiss. */
  recovered?: boolean;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(true);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setFlash(false), 1800);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      ref={ref}
      className={`relative mx-auto mb-2 max-w-3xl rounded-2xl border bg-bg-alt p-3 transition-shadow duration-700 ${
        flash ? "border-accent shadow-[0_0_0_3px_rgba(217,119,87,0.35)]" : "border-accent/30"
      }`}
    >
      {onClose && (
        <button
          onClick={onClose}
          disabled={disabled}
          title="忽略"
          aria-label="忽略"
          className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-ink-faint transition-colors hover:bg-bg-raised hover:text-ink"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      )}
      <div className="mb-2 flex items-center gap-2 pr-6">
        <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[11px] font-medium text-accent">
          需要批准
        </span>
        <span className="text-sm font-medium text-ink">
          Claude 想执行 <span className="font-semibold">{toolName}</span>
        </span>
      </div>
      {summary && (
        <pre className="mb-3 overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-bg-raised px-3 py-2 text-[12px] leading-snug text-ink-dim scroll-thin">
          {summary}
        </pre>
      )}
      {recovered ? (
        <p className="text-[12px] text-ink-faint">
          这是之前挂起的审批，会话进程已结束，无法再放行——可忽略。
        </p>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => onDecision("deny")}
            disabled={disabled}
            className="rounded-xl border border-line bg-bg-raised px-3 py-1.5 text-sm text-ink transition-colors hover:border-accent/50 disabled:opacity-50"
          >
            拒绝
          </button>
          <button
            onClick={() => onDecision("allow")}
            disabled={disabled}
            className="btn !py-1.5 text-sm"
          >
            允许一次
          </button>
        </div>
      )}
    </div>
  );
}
