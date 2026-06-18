"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "../lib/store";
import { Markdown } from "./Markdown";
import { copyText } from "../lib/clipboard";

type Preview = {
  path: string;
  relPath: string;
  kind: "text" | "markdown" | "image" | "binary";
  content?: string;
  mediaType?: string;
  truncated?: boolean;
  size: number;
};

/** Full-screen preview of a file clicked in the chat. Resolves against the session cwd. */
export function FilePreview({ cwd, path, onClose }: { cwd: string; path: string; onClose: () => void }) {
  const api = useAppStore((s) => s.api);
  const [data, setData] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    if (!api) return;
    api
      .previewFile(cwd, path)
      .then((d) => alive && setData(d as Preview))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [api, cwd, path]);

  // `:line` suffix (display only)
  const lineMatch = path.match(/:(\d+)(?::\d+)?$/);
  const line = lineMatch ? Number(lineMatch[1]) : null;

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-bg" role="dialog" aria-label="文件预览">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] text-ink">{data?.relPath ?? path}</div>
          {data && (
            <div className="text-[11px] text-ink-faint">
              {data.kind}
              {line != null ? ` · 第 ${line} 行` : ""}
              {data.truncated ? " · 已截断" : ""} · {fmtSize(data.size)}
            </div>
          )}
        </div>
        <button
          onClick={() => void copyText(data?.relPath ?? path)}
          className="shrink-0 rounded-lg border border-line px-2 py-1 text-[12px] text-ink-dim hover:bg-bg-raised"
        >
          复制路径
        </button>
        <button
          onClick={onClose}
          className="shrink-0 rounded-lg border border-line px-2 py-1 text-[12px] text-ink-dim hover:bg-bg-raised"
        >
          关闭
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3 scroll-thin">
        {error ? (
          <p className="text-[13px] text-danger">无法预览：{error}</p>
        ) : !data ? (
          <p className="text-[13px] text-ink-faint">加载中…</p>
        ) : data.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`data:${data.mediaType};base64,${data.content}`} alt={data.relPath} className="max-w-full" />
        ) : data.kind === "binary" ? (
          <p className="text-[13px] text-ink-faint">二进制文件，无法预览（{fmtSize(data.size)}）。</p>
        ) : data.kind === "markdown" ? (
          <Markdown>{data.content ?? ""}</Markdown>
        ) : (
          <pre className="overflow-x-auto whitespace-pre font-mono text-[12px] leading-relaxed text-ink scroll-thin">
            {data.content}
          </pre>
        )}
      </div>
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
