"use client";

import { createContext, memo, useContext, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyText } from "../lib/clipboard";
import { useAppStore } from "../lib/store";

/** Handler for clicking a file-path-looking inline code span. Provide once high in the
 * tree (e.g. around the Timeline) so every rendered Markdown inherits it. */
export const OpenFileContext = createContext<((path: string) => void) | null>(null);

/** Heuristic for "this inline code is a file path" (1A: code spans only). Requires an
 * extension and no whitespace, so prose in backticks isn't turned into dead links. */
function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t) || t.length > 200) return false;
  return /^[~.]?\/?(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(t);
}

function codeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map((c) => (typeof c === "string" ? c : "")).join("");
  return "";
}

function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const setError = useAppStore((s) => s.setError);
  async function copy() {
    const ok = await copyText(ref.current?.textContent ?? "");
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setError("复制失败，请手动选择文本复制");
    }
  }
  return (
    <div className="group relative my-2">
      <pre
        ref={ref}
        className="md-codeblock overflow-x-auto rounded-lg bg-black/40 p-3 pr-14 text-[13px] leading-relaxed scroll-thin"
      >
        {children}
      </pre>
      <button
        onClick={copy}
        className="absolute right-1.5 top-1.5 rounded-md border border-line bg-bg-raised/90 px-2 py-0.5 text-[11px] text-ink-dim opacity-80 transition-colors hover:text-ink"
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

function InlineCode({ className, children, ...props }: any) {
  const onOpenFile = useContext(OpenFileContext);
  const text = codeText(children);
  // Only inline code (block code carries a `language-*` className) that looks like a path.
  if (onOpenFile && !className && looksLikePath(text)) {
    return (
      <button
        type="button"
        onClick={() => onOpenFile(text)}
        title={`预览 ${text}`}
        className="rounded bg-accent/15 px-1 py-0.5 font-mono text-[0.85em] text-accent underline decoration-dotted underline-offset-2 hover:bg-accent/25"
      >
        {children}
      </button>
    );
  }
  return (
    <code className={`rounded bg-black/30 px-1 py-0.5 font-mono text-[0.85em] text-info ${className ?? ""}`} {...props}>
      {children}
    </code>
  );
}

/**
 * Markdown renderer themed for the dark console. Kept dependency-light (no
 * syntax-highlighter) — code blocks are styled monospace with horizontal scroll.
 * Links open in a new tab. memo'd so streaming re-renders stay cheap.
 */
const components: Components = {
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline underline-offset-2 hover:text-accent/80"
    >
      {children}
    </a>
  ),
  // react-markdown v10 dropped the `inline` prop. We style inline code here and
  // reset it inside <pre> via the `.md-codeblock code` CSS rule (globals.css).
  // Inline code that looks like a file path becomes clickable → opens a preview.
  code: ({ className, children, ...props }: any) => <InlineCode className={className} {...props}>{children}</InlineCode>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  p: ({ children }) => <p className="my-2 whitespace-pre-wrap break-words first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="break-words">{children}</li>,
  h1: ({ children }) => <h1 className="mb-1.5 mt-3 text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-3 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2.5 text-sm font-semibold">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line pl-3 text-ink-dim">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto scroll-thin">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-line px-2 py-1 align-top">{children}</td>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
};

export const Markdown = memo(function Markdown({
  children,
  onOpenFile,
}: {
  children: string;
  /** when set, overrides the ancestor OpenFileContext for this subtree */
  onOpenFile?: (path: string) => void;
}) {
  const body = (
    <div className="break-words text-[15px] leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
  // No prop → inherit whatever provider is above us (e.g. the Timeline's).
  return onOpenFile ? <OpenFileContext.Provider value={onOpenFile}>{body}</OpenFileContext.Provider> : body;
});
