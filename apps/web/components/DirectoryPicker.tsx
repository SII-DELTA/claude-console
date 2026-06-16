"use client";

import { useEffect, useState } from "react";
import type { FsListResponse } from "@mac/shared";
import { useAppStore } from "../lib/store";

const sw = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Breadcrumb segments for an absolute path: [{name, path}], root first. */
function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const out: { name: string; path: string }[] = [{ name: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += `/${p}`;
    out.push({ name: p, path: acc });
  }
  return out;
}

export function DirectoryPicker({ onPick, onClose }: { onPick: (cwd: string) => void; onClose: () => void }) {
  const api = useAppStore((s) => s.api);
  const [data, setData] = useState<FsListResponse | null>(null);
  const [loading, setLoading] = useState(true);

  async function browse(path?: string) {
    if (!api) return;
    setLoading(true);
    try {
      setData(await api.fsList(path));
    } catch {
      /* keep current view on error */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void browse(); // start at home
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const path = data?.path ?? "";

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[85vh] flex-col rounded-t-2xl border-t border-line bg-bg-alt pb-safe shadow-2xl">
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line" />
        <h2 className="px-4 pb-2 pt-3 text-[15px] font-semibold text-ink">选择目录</h2>

        {/* breadcrumb */}
        <div className="flex items-center gap-1 overflow-x-auto px-4 pb-2 text-[12px] scroll-thin">
          {crumbs(path).map((c, i, arr) => (
            <span key={c.path} className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => void browse(c.path)}
                className={`whitespace-nowrap font-mono ${i === arr.length - 1 ? "text-accent" : "text-ink-dim hover:text-ink"}`}
              >
                {c.name}
              </button>
              {i < arr.length - 1 && <span className="text-ink-faint">›</span>}
            </span>
          ))}
        </div>

        {/* quick roots */}
        <div className="flex gap-1.5 px-4 pb-2">
          <button
            onClick={() => void browse(data?.home)}
            className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-ink-dim hover:border-accent/40"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" {...sw}><path d="M3 11l9-8 9 8M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /></svg>
            ~ 主目录
          </button>
          <button
            onClick={() => void browse("/")}
            className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-ink-dim hover:border-accent/40"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" {...sw}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /></svg>
            / 根目录
          </button>
        </div>

        {/* folder list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 scroll-thin">
          {data?.parent && (
            <button
              onClick={() => void browse(data.parent!)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left text-[13px] text-ink-dim hover:bg-bg-raised"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" {...sw}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
              .. 上一级
            </button>
          )}
          {loading && <p className="px-3 py-4 text-center text-[12px] text-ink-faint">加载中…</p>}
          {!loading && data?.entries.length === 0 && (
            <p className="px-3 py-4 text-center text-[12px] text-ink-faint">（无子目录）</p>
          )}
          {data?.entries.map((e) => (
            <button
              key={e.path}
              onClick={() => void browse(e.path)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left hover:bg-bg-raised"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" {...sw} className="shrink-0 text-ink-dim"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{e.name}</span>
              <span className="shrink-0 text-ink-faint">›</span>
            </button>
          ))}
        </div>

        {/* footer */}
        <div className="shrink-0 border-t border-line px-4 pb-3 pt-2.5">
          <div className="mb-2 truncate font-mono text-[11px] text-ink-faint">{path || "—"}</div>
          <button
            onClick={() => path && onPick(path)}
            disabled={!path}
            className="w-full rounded-xl bg-accent py-3 text-[14px] font-medium text-white transition-colors hover:bg-accent-dark disabled:opacity-40"
          >
            选择此目录
          </button>
          <button onClick={onClose} className="mt-2 w-full rounded-xl py-2.5 text-[14px] text-ink-dim hover:text-ink">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
