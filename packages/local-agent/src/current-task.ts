import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { Bus } from "./bus.js";
import type { ClaudeStore } from "./claude-store.js";
import type { ClaudeMessage } from "@mac/shared";

/**
 * Out-of-band "current task" observer (spec layer C).
 *
 * On each completed turn it asks a cheap Haiku — via a one-shot `claude -p` print
 * call that reuses the user's existing Claude Code auth — to label what the session
 * is *currently* working on, and exposes that label to {@link ClaudeStore} so the
 * dashboard card title tracks the live task instead of the opening prompt.
 *
 * It is a pure READER: it never writes to the session's jsonl, never enters the
 * driven session's context, and runs in a neutral cwd so the project's CLAUDE.md
 * doesn't bias (or task) the observer. Failures degrade silently to layer A
 * (latest user instruction).
 */

const INSTRUCTION =
  "你是会话观察员。阅读给定的 Claude Code 会话片段，只用一句不超过 20 字的中文短语，" +
  "概括它当前正在做的具体任务（动宾结构，如「重构监控台项目过滤」）。" +
  "不要解释、不要标点结尾、不要引号，只输出这句话。";

/** transcript budget + how many trailing messages to feed the observer */
const TAIL_MESSAGES = 16;
const TRANSCRIPT_BUDGET = 4000;
const SUMMARY_MAX = 24;
const SPAWN_TIMEOUT_MS = 25_000;

export interface CurrentTaskOptions {
  store: ClaudeStore;
  bus: Bus;
  /** path to the claude binary (defaults to CLAUDE_BIN / "claude"). */
  claudeBin?: string;
  /** model alias for the observer (defaults to "haiku"). */
  model?: string;
  /** test seam: replace the spawn-based summarizer. */
  summarizeFn?: (transcript: string, cwd: string) => Promise<string | null>;
}

export class CurrentTaskSummarizer {
  private readonly summaries = new Map<string, string>();
  /** messageCount last summarized per session — skip when nothing new arrived */
  private readonly lastCount = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly opts: CurrentTaskOptions) {}

  /** Whether the observer is enabled (env CURRENT_TASK_SUMMARY; default on). */
  static enabled(): boolean {
    const v = process.env.CURRENT_TASK_SUMMARY;
    return v !== "0" && v !== "false" && v !== "off";
  }

  /** The current-task label for a session, if any (fed to ClaudeStore). */
  get(id: string): string | undefined {
    return this.summaries.get(id);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.opts.bus.on("claude:drive_done", (sessionId) => {
      void this.summarize(sessionId);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async summarize(sessionId: string): Promise<void> {
    if (this.inFlight.has(sessionId)) return;
    const detail = await this.opts.store.getSession(sessionId, { limit: TAIL_MESSAGES });
    if (!detail) return;
    // dedup: only re-summarize when the transcript actually grew since last time
    if (this.lastCount.get(sessionId) === detail.session.messageCount) return;
    const transcript = buildTranscript(detail.messages);
    if (!transcript) return;
    this.inFlight.add(sessionId);
    try {
      const fn = this.opts.summarizeFn ?? ((t, c) => this.spawnSummary(t, c));
      const label = await fn(transcript, detail.session.cwd);
      this.lastCount.set(sessionId, detail.session.messageCount);
      const clean = sanitize(label);
      if (clean && clean !== this.summaries.get(sessionId)) {
        this.summaries.set(sessionId, clean);
        // re-derive + broadcast the session meta so the new title reaches clients
        void this.opts.store.refreshSession(sessionId);
      }
    } catch {
      /* observer is best-effort; layer A (latest user instruction) covers the gap */
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  /** One-shot `claude -p` print call (reads transcript from stdin). */
  private spawnSummary(transcript: string, _cwd: string): Promise<string | null> {
    const bin = this.opts.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";
    const model = this.opts.model ?? process.env.CURRENT_TASK_MODEL ?? "haiku";
    return new Promise((resolve) => {
      const proc = spawn(
        bin,
        ["-p", "--model", model, "--output-format", "json", "--append-system-prompt", INSTRUCTION],
        // neutral cwd: don't load the project's CLAUDE.md into the observer
        { cwd: tmpdir(), env: process.env },
      );
      let out = "";
      let settled = false;
      const done = (v: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          proc.kill("SIGTERM");
        } catch {
          /* noop */
        }
        resolve(v);
      };
      const timer = setTimeout(() => done(null), SPAWN_TIMEOUT_MS);
      proc.stdout.on("data", (c: Buffer) => {
        out += c.toString();
      });
      proc.on("error", () => done(null));
      proc.on("close", () => done(extractResult(out)));
      try {
        proc.stdin.write(transcript);
        proc.stdin.end();
      } catch {
        done(null);
      }
    });
  }
}

/** Flatten recent messages into a compact role-tagged transcript (budget-capped). */
function buildTranscript(messages: ClaudeMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const who = m.role === "user" ? "用户" : "助手";
    const parts: string[] = [];
    for (const b of m.blocks) {
      if (b.kind === "text" && b.text.trim()) parts.push(b.text.trim());
      else if (b.kind === "tool_use") parts.push(`[工具:${b.toolName}]`);
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) lines.push(`${who}: ${text.slice(0, 600)}`);
  }
  // keep the tail within budget (most recent context matters most)
  let joined = lines.join("\n");
  if (joined.length > TRANSCRIPT_BUDGET) joined = joined.slice(joined.length - TRANSCRIPT_BUDGET);
  return joined;
}

/** Pull the result text out of `claude --output-format json` stdout. */
function extractResult(stdout: string): string | null {
  const t = stdout.trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t) as { result?: unknown; is_error?: boolean };
    if (obj.is_error) return null;
    return typeof obj.result === "string" ? obj.result : null;
  } catch {
    // not JSON (older CLI / plain output) — take the first non-empty line
    return t.split("\n").find((l) => l.trim()) ?? null;
  }
}

function sanitize(label: string | null): string | undefined {
  if (!label) return undefined;
  const one = label
    .replace(/\s+/g, " ")
    .replace(/^["'「『]+|["'」』。.\s]+$/g, "")
    .trim();
  if (!one) return undefined;
  return one.length > SUMMARY_MAX ? `${one.slice(0, SUMMARY_MAX)}…` : one;
}
