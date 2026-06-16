"use client";

import { useRef, useState } from "react";
import type { ClaudeMessage, ClaudeMessageBlock } from "@mac/shared";
import { Markdown } from "./Markdown";
import { ImageThumb } from "./ImageThumb";
import { copyText } from "../lib/clipboard";
import { useAppStore, type SendState } from "../lib/store";

/**
 * Claude-Code-style conversation timeline. Tool calls are paired with their
 * results (by tool_use_id) and collapsed by default into a single tidy row;
 * assistant prose flows as markdown; user turns are compact right bubbles.
 */
type Item =
  | { kind: "user"; id: string; text: string; images?: string[] }
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
    };

export function Timeline({
  messages,
  onFillInput,
}: {
  messages: ClaudeMessage[];
  /** Drop a message's text into the composer (does NOT send). */
  onFillInput?: (text: string) => void;
}) {
  const groups = groupItems(buildTimeline(messages));
  const sendStatus = useAppStore((s) => s.sendStatus);
  return (
    <div className="space-y-3">
      {groups.map((g, i) =>
        g.kind === "user" ? (
          <div key={g.item.id}>
            <Row item={g.item} onFillInput={onFillInput} />
            {sendStatus?.messageId === g.item.id && <SendReceipt state={sendStatus.state} />}
          </div>
        ) : (
          <AssistantGroup key={i} items={g.items} />
        ),
      )}
    </div>
  );
}

/** Delivery/read receipt shown under the last sent user bubble (方案 B). */
function SendReceipt({ state }: { state: SendState }) {
  const map: Record<SendState, { text: string; cls: string }> = {
    sending: { text: "发送中…", cls: "text-ink-faint" },
    delivered: { text: "已送达 ✓", cls: "text-ink-faint" },
    read: { text: "已读·处理中 ✓", cls: "text-accent" },
    failed: { text: "发送失败", cls: "text-danger" },
  };
  const { text, cls } = map[state];
  return <div className={`mt-0.5 pr-1 text-right text-[11px] ${cls}`}>{text}</div>;
}

/** Small hover-revealed copy button with transient "已复制" feedback. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const setError = useAppStore((s) => s.setError);
  async function copy() {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setError("复制失败，请手动选择文本复制");
    }
  }
  return (
    <button
      onClick={copy}
      className={
        className ??
        "px-1 text-[11px] text-ink-faint opacity-60 transition-colors hover:text-accent md:opacity-0 md:group-hover:opacity-100"
      }
      title="复制"
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

/** Group consecutive assistant items so they share one vertical timeline rail. */
function groupItems(
  items: Item[],
): ({ kind: "user"; item: Item } | { kind: "asst"; items: Item[] })[] {
  const out: ({ kind: "user"; item: Item } | { kind: "asst"; items: Item[] })[] = [];
  let cur: Item[] | null = null;
  for (const it of items) {
    if (it.kind === "user") {
      if (cur) {
        out.push({ kind: "asst", items: cur });
        cur = null;
      }
      out.push({ kind: "user", item: it });
    } else {
      (cur ??= []).push(it);
    }
  }
  if (cur) out.push({ kind: "asst", items: cur });
  return out;
}

function AssistantGroup({ items }: { items: Item[] }) {
  return (
    <div className="relative ml-1 space-y-2 border-l border-line/60 pl-4">
      {items.map((it) => (
        <div key={it.id} className="relative">
          <span
            className={`absolute -left-[1.19rem] top-[0.5rem] h-[7px] w-[7px] rounded-full ring-2 ring-bg ${dotColor(it)}`}
          />
          <Row item={it} />
        </div>
      ))}
    </div>
  );
}

function dotColor(it: Item): string {
  if (it.kind === "tool") return it.isError ? "bg-danger" : "bg-info";
  if (it.kind === "thinking") return "bg-ink-faint";
  return "bg-accent";
}

function Row({ item, onFillInput }: { item: Item; onFillInput?: (text: string) => void }) {
  switch (item.kind) {
    case "user":
      return <UserBubble text={item.text} images={item.images} onFillInput={onFillInput} />;
    case "text":
      return (
        <div className="group px-0.5 text-[15px] leading-7 text-ink">
          <Markdown>{item.text}</Markdown>
          <div className="mt-0.5 flex">
            <CopyButton text={item.text} />
          </div>
        </div>
      );
    case "thinking":
      return <Thinking text={item.text} />;
    case "tool":
      return <ToolRow item={item} />;
  }
}

function UserBubble({
  text,
  images,
  onFillInput,
}: {
  text: string;
  images?: string[];
  onFillInput?: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const clean = cleanUserText(text);
  const long = clean.length > 360;
  const shown = long && !expanded ? clean.slice(0, 360) + "…" : clean;
  const hasText = clean !== "（命令）" || text.trim().length > 0;
  return (
    <div className="group flex flex-col items-end gap-1">
      {images && images.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {images.map((src, i) => (
            <ImageThumb
              key={i}
              src={src}
              className="h-28 w-28 rounded-xl border border-line object-cover"
            />
          ))}
        </div>
      )}
      {hasText && (
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-accent/15 px-3.5 py-2 text-[14.5px] leading-relaxed text-ink">
        {shown}
        {long && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="ml-1 align-baseline text-[12px] text-accent hover:underline"
          >
            {expanded ? "收起" : "展开"}
          </button>
        )}
      </div>
      )}
      {hasText && (
        <div className="flex items-center gap-1">
          <CopyButton text={clean} />
          {onFillInput && (
            <button
              onClick={() => onFillInput(clean)}
              className="px-1 text-[11px] text-ink-faint opacity-60 transition-colors hover:text-accent md:opacity-0 md:group-hover:opacity-100"
              title="填入输入框（不直接发送）"
            >
              ↥ 填入输入框
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Strip slash-command / system-reminder wrappers so user turns read cleanly. */
function cleanUserText(text: string): string {
  let t = text;
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  t = t.replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, "");
  t = t.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  // /slash commands: keep the args (the actual instruction)
  const cmd = t.match(/<command-name>\s*(\/[\w-]+)[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
  if (cmd) t = `${cmd[1]} ${cmd[2]}`.trim();
  t = t.replace(/<\/?command-(name|message|args)>/g, "");
  return t.trim() || "（命令）";
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="px-0.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[12.5px] italic text-ink-faint transition-colors hover:text-ink-dim"
      >
        {open ? "▾" : "▸"} 思考
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-line pl-3 text-[12.5px] italic text-ink-dim">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  );
}

function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const primary = primaryArg(item.input);
  const hasDetail = item.input != null || item.result != null;
  return (
    <div>
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-bg-alt/50"
      >
        <span className="w-2 shrink-0 text-center text-ink-faint">
          {hasDetail ? (open ? "▾" : "▸") : "·"}
        </span>
        <span className="font-mono font-semibold text-info">{item.name}</span>
        {primary && (
          <span className="min-w-0 flex-1 truncate font-mono text-ink-dim">{primary}</span>
        )}
        {item.isError ? (
          <span className="ml-auto shrink-0 text-danger">✗</span>
        ) : item.result != null ? (
          <span className="ml-auto shrink-0 text-success">✓</span>
        ) : null}
      </button>
      {open && (
        <div className="ml-4 mt-1.5 space-y-1.5 border-l border-line pl-3">
          {item.input != null && (
            <Pre label="IN">
              {typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2)}
            </Pre>
          )}
          {item.result != null && (
            <Pre label={item.isError ? "ERR" : "OUT"} error={item.isError}>
              {item.result}
            </Pre>
          )}
        </div>
      )}
    </div>
  );
}

function Pre({ label, children, error }: { label: string; children: string; error?: boolean }) {
  const [copied, setCopied] = useState(false);
  const setError = useAppStore((s) => s.setError);
  async function copy() {
    if (await copyText(children)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setError("复制失败，请手动选择文本复制");
    }
  }
  return (
    <div className="group/pre relative">
      <span className={`text-[10px] uppercase tracking-wide ${error ? "text-danger" : "text-ink-faint"}`}>
        {label}
      </span>
      <button
        onClick={copy}
        className="absolute right-1 top-0 rounded border border-line bg-bg-raised/90 px-1.5 text-[10px] text-ink-faint opacity-70 hover:text-ink"
      >
        {copied ? "已复制" : "复制"}
      </button>
      <pre className="mt-0.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 px-2 py-1.5 text-[12px] text-ink-dim scroll-thin">
        {children}
      </pre>
    </div>
  );
}

/* ─────────────────────────── timeline builder ─────────────────────────── */

export function buildTimeline(messages: ClaudeMessage[]): Item[] {
  // map tool_use_id -> result (results live in later user messages)
  const results = new Map<string, { content: string; isError?: boolean }>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === "tool_result" && b.toolUseId) {
        results.set(b.toolUseId, { content: b.content, isError: b.isError });
      }
    }
  }

  const items: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const texts = m.blocks.filter((b): b is Extract<ClaudeMessageBlock, { kind: "text" }> => b.kind === "text");
      const text = texts.map((t) => t.text).join("\n").trim();
      const images = m.blocks
        .filter((b): b is Extract<ClaudeMessageBlock, { kind: "image" }> => b.kind === "image")
        .map((b) => `data:${b.mediaType};base64,${b.dataBase64}`);
      if (text || images.length) items.push({ kind: "user", id: m.id, text, images: images.length ? images : undefined });
      // tool_result-only user messages are attached to their tool rows → skip
      continue;
    }
    // assistant
    let bi = 0;
    for (const b of m.blocks) {
      const id = `${m.id}:${bi++}`;
      if (b.kind === "text" && b.text.trim()) items.push({ kind: "text", id, text: b.text });
      else if (b.kind === "thinking") items.push({ kind: "thinking", id, text: b.text });
      else if (b.kind === "tool_use") {
        const r = b.toolUseId ? results.get(b.toolUseId) : undefined;
        items.push({ kind: "tool", id, name: b.toolName, input: b.input, result: r?.content, isError: r?.isError });
      }
    }
  }
  return items;
}

function primaryArg(input: unknown): string {
  let s = "";
  if (typeof input === "string") s = input;
  else if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const key = ["command", "file_path", "path", "pattern", "url", "description", "query"].find(
      (k) => typeof o[k] === "string",
    );
    if (key) s = String(o[key]);
  }
  return abbreviate(s.split("\n")[0] ?? "");
}

/** Shorten long absolute paths to …/parent/file and cap command length. */
function abbreviate(s: string): string {
  const t = s.trim();
  if (/^[~/]/.test(t) && !/\s/.test(t)) {
    const parts = t.split("/").filter(Boolean);
    if (parts.length > 2) return "…/" + parts.slice(-2).join("/");
    return t;
  }
  return t.length > 72 ? t.slice(0, 72) + "…" : t;
}
