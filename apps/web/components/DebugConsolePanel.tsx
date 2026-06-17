"use client";

import { useEffect, useState } from "react";
import { clearEntries, getEntries, installDebugCapture, subscribe, type DebugEntry } from "../lib/debug-log";

const KIND_TONE: Record<DebugEntry["kind"], string> = {
  log: "text-ink-dim",
  info: "text-ink-dim",
  warn: "text-warning",
  error: "text-danger",
  network: "text-accent",
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Floating, self-contained debug console. Mounted globally when the setting is on. */
export function DebugConsolePanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"log" | "network">("log");
  const [, force] = useState(0);

  useEffect(() => {
    installDebugCapture();
    return subscribe(() => force((n) => n + 1));
  }, []);

  const all = getEntries();
  const list = tab === "network" ? all.filter((e) => e.kind === "network") : all.filter((e) => e.kind !== "network");

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-20 right-3 z-[60] grid h-10 w-10 place-items-center rounded-full border border-line bg-bg-alt text-[11px] font-semibold text-ink-dim shadow-lg"
        aria-label="打开调试控制台"
      >
        DBG
      </button>
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] flex h-[55dvh] flex-col rounded-t-2xl border-t border-line bg-bg shadow-2xl">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[12px] font-semibold text-ink">调试控制台</span>
        <div className="ml-2 flex gap-1">
          {(["log", "network"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-2 py-1 text-[12px] ${tab === t ? "bg-bg-raised text-ink" : "text-ink-faint"}`}
            >
              {t === "log" ? "日志" : "网络"}
            </button>
          ))}
        </div>
        <button onClick={() => clearEntries()} className="ml-auto rounded-md px-2 py-1 text-[12px] text-ink-faint hover:bg-bg-raised">
          清空
        </button>
        <button onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-[12px] text-ink-faint hover:bg-bg-raised">
          关闭
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed scroll-thin">
        {list.length === 0 ? (
          <div className="px-2 py-6 text-center text-ink-faint">暂无{tab === "network" ? "网络请求" : "日志"}</div>
        ) : (
          list.map((e) => (
            <div key={e.id} className="flex gap-2 border-b border-line/30 py-1">
              <span className="shrink-0 text-ink-faint">{fmtTime(e.ts)}</span>
              <span className={`min-w-0 flex-1 break-all ${KIND_TONE[e.kind]}`}>
                {e.kind === "network" && e.net ? (
                  <>
                    <span className={e.net.ok === false ? "text-danger" : "text-success"}>{e.net.status ?? "ERR"}</span>{" "}
                    {e.net.method} {e.net.url}
                    {e.net.ms != null && <span className="text-ink-faint"> ({e.net.ms}ms)</span>}
                  </>
                ) : (
                  e.text
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
