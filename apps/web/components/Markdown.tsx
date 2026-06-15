"use client";

import { memo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyText } from "../lib/clipboard";
import { useAppStore } from "../lib/store";

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
  code: ({ className, children, ...props }: any) => (
    <code
      className={`rounded bg-black/30 px-1 py-0.5 font-mono text-[0.85em] text-info ${className ?? ""}`}
      {...props}
    >
      {children}
    </code>
  ),
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

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="break-words text-[15px] leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
