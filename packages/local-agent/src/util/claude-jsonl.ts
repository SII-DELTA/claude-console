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
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolUseCount: number;
  lastTimestamp?: string;
  messages: ClaudeMessage[];
}

export function newAccumulator(): SessionAccumulator {
  return {
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    messages: [],
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
    if (!acc.firstUserText) {
      const t = m.blocks.find((b) => b.kind === "text");
      if (t && t.kind === "text") acc.firstUserText = t.text;
    }
  } else if (m.role === "assistant") {
    acc.assistantMessageCount += 1;
  }
  acc.toolUseCount += m.blocks.filter((b) => b.kind === "tool_use").length;
  if (keepMessages) acc.messages.push(m);
}

export function deriveTitle(acc: SessionAccumulator, fallbackId: string): string {
  if (acc.aiTitle) return acc.aiTitle;
  const t = (acc.firstUserText ?? "").trim().replace(/\s+/g, " ");
  if (t) return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  return `Claude session ${fallbackId.slice(0, 8)}`;
}
