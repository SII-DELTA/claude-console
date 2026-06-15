import type { AgentLogLevel } from "@mac/shared";
import stripAnsi from "strip-ansi";

const ERROR_RE = /\b(error|err|fatal|exception|traceback|panic|fail(ed)?|✗|✘)\b/i;
const TEST_RE = /\b(pass(ed)?|✓|ok|test|spec|assertion|expected)\b/i;
const ACTION_RE = /\b(running|executing|spawn|invoking|tool[: ]|action[: ]|->)\b/i;
const WARN_RE = /\b(warn|warning|deprecat)\b/i;

export interface ParsedChunk {
  level: AgentLogLevel;
  content: string;
  raw: string;
}

/**
 * Split a raw PTY chunk into one or more log lines and infer level.
 * Trailing partial line is left to the caller via the buffered helper.
 */
export function inferLevel(line: string): AgentLogLevel {
  if (ERROR_RE.test(line)) return "error";
  if (WARN_RE.test(line)) return "warn";
  if (TEST_RE.test(line)) return "test";
  if (ACTION_RE.test(line)) return "action";
  return "info";
}

export function parseChunk(raw: string): ParsedChunk[] {
  const text = stripAnsi(raw);
  const lines = text.split(/\r?\n/);
  const out: ParsedChunk[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    out.push({ level: inferLevel(line), content: line, raw });
  }
  return out;
}

/**
 * Stateful line buffer: keeps the trailing partial line until a newline arrives.
 */
export class LineBuffer {
  private buffer = "";

  push(raw: string): ParsedChunk[] {
    this.buffer += stripAnsi(raw);
    const out: ParsedChunk[] = [];
    while (true) {
      const idx = this.buffer.search(/\r?\n/);
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + (this.buffer[idx] === "\r" ? 2 : 1));
      if (line.trim().length > 0) {
        out.push({ level: inferLevel(line), content: line, raw });
      }
    }
    return out;
  }

  flush(): ParsedChunk[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    return [{ level: inferLevel(line), content: line, raw: line }];
  }
}
