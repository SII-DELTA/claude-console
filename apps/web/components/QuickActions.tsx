"use client";

import { useState } from "react";

/** Common follow-up prompts so you barely type on mobile. */
const PRESETS: { label: string; prompt: string }[] = [
  { label: "继续", prompt: "继续" },
  { label: "跑测试", prompt: "运行相关测试，如有失败请修复" },
  { label: "修复报错", prompt: "修复刚才出现的报错" },
  { label: "提交", prompt: "提交当前改动，commit message 要清晰准确" },
  { label: "总结进度", prompt: "简要总结当前进度和下一步计划" },
  { label: "解释", prompt: "解释一下你刚才做的改动和原因" },
];
const MORE = PRESETS.slice(1);

const pill =
  "shrink-0 rounded-full border border-line bg-bg-raised px-3 py-1 text-[12.5px] text-ink-dim transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-40";

export function QuickActions({
  onPick,
  disabled,
}: {
  onPick: (prompt: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => onPick("继续")} disabled={disabled} className={pill}>
        继续
      </button>
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          className={`${pill} flex items-center gap-1`}
          title="更多指令"
        >
          指令
          <span className="text-ink-faint">{open ? "▴" : "▾"}</span>
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
            <div className="absolute bottom-full left-0 z-30 mb-1.5 w-40 overflow-hidden rounded-xl border border-line bg-bg-raised p-1 shadow-2xl">
              {MORE.map((p) => (
                <button
                  key={p.label}
                  onClick={() => {
                    onPick(p.prompt);
                    setOpen(false);
                  }}
                  className="block w-full rounded-lg px-3 py-2 text-left text-[13px] text-ink hover:bg-bg-alt"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
