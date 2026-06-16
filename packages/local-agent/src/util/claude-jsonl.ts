/**
 * Pure parsing helpers for Claude Code session JSONL files
 * (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`).
 *
 * Kept side-effect free so it can be unit-tested with fixtures.
 */
import type { ClaudeMessage, ClaudeMessageBlock } from "@mac/shared";

/** Claude Code encodes the project cwd by replacing every non-alphanumeric char with "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
}

interface RawEntry {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  aiTitle?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | RawContentBlock[];
  };
}

export interface ParsedLine {
  /** A renderable chat message, when the line is a user/assistant turn. */
  message?: ClaudeMessage;
  /** Title carried by an `ai-title` line. */
  aiTitle?: string;
  /** cwd carried by the line (any type), used to populate session.cwd. */
  cwd?: string;
  /** model id seen on assistant lines. */
  modelId?: string;
  /** raw timestamp on the line, used for updatedAt even on meta lines. */
  timestamp?: string;
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : c && typeof c === "object" && "text" in c
            ? String((c as { text?: unknown }).text ?? "")
            : "",
      )
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function mapBlocks(content: string | RawContentBlock[] | undefined): ClaudeMessageBlock[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content.length ? [{ kind: "text", text: content }] : [];
  }
  const blocks: ClaudeMessageBlock[] = [];
  for (const b of content) {
    switch (b.type) {
      case "text":
        blocks.push({ kind: "text", text: b.text ?? "" });
        break;
      case "thinking":
        blocks.push({ kind: "thinking", text: b.thinking ?? b.text ?? "" });
        break;
      case "image":
        if (b.source?.type === "base64" && b.source.data) {
          blocks.push({
            kind: "image",
            mediaType: b.source.media_type ?? "image/png",
            dataBase64: b.source.data,
          });
        }
        break;
      case "tool_use":
        blocks.push({
          kind: "tool_use",
          toolName: b.name ?? "tool",
          input: b.input,
          toolUseId: b.id,
        });
        break;
      case "tool_result":
        blocks.push({
          kind: "tool_result",
          toolUseId: b.tool_use_id,
          content: normalizeToolResultContent(b.content),
          isError: b.is_error,
        });
        break;
      default:
        // unknown block type: keep any text we can salvage
        if (b.text) blocks.push({ kind: "text", text: b.text });
    }
  }
  return blocks;
}

/** Parse a single JSONL line into a ParsedLine, or null if it is not JSON. */
export function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let entry: RawEntry;
  try {
    entry = JSON.parse(trimmed) as RawEntry;
  } catch {
    return null;
  }

  const out: ParsedLine = {
    cwd: entry.cwd,
    timestamp: entry.timestamp,
    modelId: entry.message?.model,
  };

  if (entry.type === "ai-title" && entry.aiTitle) {
    out.aiTitle = entry.aiTitle;
    return out;
  }

  if (entry.type === "user" || entry.type === "assistant") {
    const role = entry.type === "user" ? "user" : "assistant";
    const blocks = mapBlocks(entry.message?.content);
    if (blocks.length > 0 && entry.uuid && entry.sessionId) {
      out.message = {
        id: entry.uuid,
        sessionId: entry.sessionId,
        parentUuid: entry.parentUuid ?? null,
        role,
        blocks,
        timestamp: entry.timestamp ?? new Date(0).toISOString(),
      };
    }
  }

  return out;
}

export interface SessionAccumulator {
  sessionId?: string;
  cwd?: string;
  aiTitle?: string;
  modelId?: string;
  firstUserText?: string;
  /** most recent user free-text turn — drives the dashboard's "current task" title */
  lastUserText?: string;
  /** most recent assistant text block — used as the "done" result summary */
  lastAssistantText?: string;
  /** most recent assistant tool_use — used to render the running "activity" line */
  lastToolName?: string;
  lastToolInput?: unknown;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolUseCount: number;
  lastTimestamp?: string;
  messages: ClaudeMessage[];
  /** role of the last seen message — used to tell "done/awaiting user" apart */
  lastRole?: "user" | "assistant";
  /** AskUserQuestion tool_use ids not yet answered by a non-error tool_result */
  openQuestionIds: Set<string>;
}

export function newAccumulator(): SessionAccumulator {
  return {
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    messages: [],
    openQuestionIds: new Set<string>(),
  };
}

/** Fold a parsed line into an accumulator (used both for list-meta and full reads). */
export function accumulate(acc: SessionAccumulator, parsed: ParsedLine, keepMessages: boolean): void {
  if (parsed.cwd && !acc.cwd) acc.cwd = parsed.cwd;
  if (parsed.aiTitle) acc.aiTitle = parsed.aiTitle;
  if (parsed.modelId) acc.modelId = parsed.modelId;
  if (parsed.timestamp && (!acc.lastTimestamp || parsed.timestamp > acc.lastTimestamp)) {
    acc.lastTimestamp = parsed.timestamp;
  }
  const m = parsed.message;
  if (!m) return;
  if (!acc.sessionId) acc.sessionId = m.sessionId;
  acc.messageCount += 1;
  if (m.role === "user") {
    acc.userMessageCount += 1;
    // Real user text only — strip IDE/system-injected wrappers (<ide_opened_file>,
    // <system-reminder>, slash-command envelopes…) so titles reflect what the user
    // actually typed, not editor context auto-attached to the turn.
    const realText = userText(m.blocks);
    if (realText) {
      if (!acc.firstUserText) acc.firstUserText = realText;
      // track the *latest* user instruction (the session's current task focus)
      acc.lastUserText = realText;
      // A real follow-up user message means the user moved on — any earlier
      // AskUserQuestion is no longer awaiting them. (Injected-only turns don't count.)
      acc.openQuestionIds.clear();
    }
  } else if (m.role === "assistant") {
    acc.assistantMessageCount += 1;
    for (const b of m.blocks) {
      if (b.kind === "text" && b.text.trim()) acc.lastAssistantText = b.text;
      else if (b.kind === "tool_use") {
        acc.lastToolName = b.toolName;
        acc.lastToolInput = b.input;
      }
    }
  }
  if (m.role === "user" || m.role === "assistant") acc.lastRole = m.role;
  acc.toolUseCount += m.blocks.filter((b) => b.kind === "tool_use").length;
  // Track an unanswered AskUserQuestion: open on the tool_use, close on *any*
  // matching tool_result (including an error/auto-deny — that still means it's no
  // longer blocking on the user). Only a question with no tool_result at all (e.g. a
  // live turn paused awaiting the answer) stays open.
  for (const b of m.blocks) {
    if (b.kind === "tool_use" && b.toolName === "AskUserQuestion" && b.toolUseId) {
      acc.openQuestionIds.add(b.toolUseId);
    } else if (b.kind === "tool_result" && b.toolUseId) {
      acc.openQuestionIds.delete(b.toolUseId);
    }
  }
  if (keepMessages) acc.messages.push(m);
}

/**
 * Whether a session needs user attention, for the dashboard's cross-session view:
 * - `question`: an unanswered AskUserQuestion is pending
 * - `done`: not live and the last turn was the assistant's (awaiting next instruction)
 * Returns undefined when nothing needs attention. (`error` is surfaced at runtime
 * by the driver, not derivable from the jsonl alone.)
 */
export function deriveAttention(
  acc: SessionAccumulator,
  isLive: boolean,
  dismissed?: Set<string>,
): "question" | "error" | "done" | undefined {
  // an unanswered question still counts unless the user explicitly dismissed it
  const open = dismissed
    ? [...acc.openQuestionIds].some((id) => !dismissed.has(id))
    : acc.openQuestionIds.size > 0;
  if (open) return "question";
  if (!isLive && acc.lastRole === "assistant") return "done";
  return undefined;
}

export function deriveTitle(acc: SessionAccumulator, fallbackId: string): string {
  if (acc.aiTitle) return acc.aiTitle;
  const t = (acc.firstUserText ?? "").trim().replace(/\s+/g, " ");
  if (t) return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  return `Claude session ${fallbackId.slice(0, 8)}`;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

// IDE/CLI context the harness injects into a user turn — not typed by the user.
const INJECTED_TAGS =
  "ide_opened_file|ide_selection|ide_diagnostics|ide_recently_modified_files|" +
  "system-reminder|command-name|command-message|command-args|" +
  "local-command-stdout|local-command-stderr";

/** Remove whole `<tag>…</tag>` injected-context blocks (and stray tag markers). */
export function stripInjectedText(text: string): string {
  return text
    .replace(new RegExp(`<(${INJECTED_TAGS})>[\\s\\S]*?</\\1>`, "gi"), " ")
    .replace(new RegExp(`</?(${INJECTED_TAGS})>`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Concatenated real user text from a message's blocks (injected wrappers stripped). */
export function userText(blocks: ClaudeMessageBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      const cleaned = stripInjectedText(b.text);
      if (cleaned) parts.push(cleaned);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Latest user instruction (the session's current task), clipped. Empty → undefined. */
export function deriveLastUser(acc: SessionAccumulator): string | undefined {
  const t = (acc.lastUserText ?? "").trim();
  return t ? clip(t, 120) : undefined;
}

/** First line of the assistant's last text — a "result" summary for done sessions. */
export function deriveResult(acc: SessionAccumulator): string | undefined {
  const t = (acc.lastAssistantText ?? "").split("\n").find((l) => l.trim());
  return t ? clip(t, 120) : undefined;
}

/** Friendly one-line "what it's doing now" from the last tool_use. Empty → undefined. */
export function deriveActivity(acc: SessionAccumulator): string | undefined {
  const name = acc.lastToolName;
  if (!name) return undefined;
  const obj =
    acc.lastToolInput && typeof acc.lastToolInput === "object"
      ? (acc.lastToolInput as Record<string, unknown>)
      : {};
  const arg = (v: unknown): string => clip(typeof v === "string" ? v : "", 60);
  const file = (p: unknown): string => {
    const s = typeof p === "string" ? p : "";
    return clip(s.split("/").filter(Boolean).pop() ?? s, 48);
  };
  switch (name) {
    case "Bash":
      return `运行 ${arg(obj.command)}`;
    case "Edit":
    case "MultiEdit":
      return `编辑 ${file(obj.file_path)}`;
    case "Write":
      return `写入 ${file(obj.file_path)}`;
    case "Read":
      return `读取 ${file(obj.file_path)}`;
    case "NotebookEdit":
      return `编辑 ${file(obj.notebook_path)}`;
    case "Grep":
      return `搜索 ${arg(obj.pattern)}`;
    case "Glob":
      return `查找 ${arg(obj.pattern)}`;
    case "WebFetch":
      return `读取网页 ${arg(obj.url)}`;
    case "WebSearch":
      return `网页搜索 ${arg(obj.query)}`;
    case "Task":
      return "运行子任务";
    case "TodoWrite":
      return "更新任务清单";
    case "AskUserQuestion":
      return "等待你的回答";
    default:
      return `使用 ${clip(name, 32)}`;
  }
}
