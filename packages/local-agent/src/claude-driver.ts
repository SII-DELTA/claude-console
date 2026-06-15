import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ClaudeImage, ClaudePermissionQuestion } from "@mac/shared";
import type { Bus } from "./bus.js";
import type { ClaudeStore } from "./claude-store.js";
import { parseStreamLine } from "./util/claude-stream.js";

export class SessionLiveError extends Error {
  constructor(public readonly sessionId: string) {
    super("session is live");
    this.name = "SessionLiveError";
  }
}

/** Kill a warm process after this much inactivity to free memory. */
const IDLE_TIMEOUT_MS = 5 * 60_000;

interface WarmProc {
  proc: ChildProcessWithoutNullStreams;
  buf: string;
  stderr: string;
  busy: boolean;
  idle: NodeJS.Timeout | null;
  mode: string;
  /** Interactive permission asks (can_use_tool) awaiting a client answer, by request_id. */
  pending: Map<string, { input: unknown }>;
}

export interface ClaudeDriverOptions {
  /** Resolve the default cwd for new sessions (current workspace root). */
  workspaceRoot: () => string;
  store: ClaudeStore;
  bus: Bus;
  /** Override for tests: a fake spawn. */
  spawnFn?: typeof spawn;
  /** Path to claude binary. */
  claudeBin?: string;
  /** Permission mode passed to claude. Default acceptEdits. */
  permissionMode?: string;
  /** Idle timeout override (tests). */
  idleTimeoutMs?: number;
  /**
   * Route interactive permission asks (AskUserQuestion) through the stdio control
   * protocol so the web client can answer them in-turn (方案 B). When false, falls
   * back to 方案 A (the CLI auto-denies and the client re-renders from the error).
   * Defaults to env CLAUDE_INTERACTIVE_PERMISSIONS (on unless "0"/"false").
   */
  interactivePermissions?: boolean;
}

/**
 * Drives Claude Code with a **long-lived warm process per session**.
 *
 * The first prompt to a session spawns `claude --input-format stream-json
 * --output-format stream-json --include-partial-messages` (cold start ~5-7s).
 * Follow-up prompts are written to the same process's stdin, reusing the warm
 * prompt cache (~1.5-2s to first token). Token deltas stream over the bus; the
 * session JSONL remains the source of truth (mirrored by ClaudeStore).
 */
export class ClaudeDriver {
  private readonly procs = new Map<string, WarmProc>();

  constructor(private readonly opts: ClaudeDriverOptions) {}

  private get bin(): string {
    return this.opts.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";
  }

  private get permissionMode(): string {
    return this.opts.permissionMode ?? process.env.CLAUDE_PERMISSION_MODE ?? "acceptEdits";
  }

  private get idleMs(): number {
    return this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  }

  private get interactivePermissions(): boolean {
    if (this.opts.interactivePermissions !== undefined) return this.opts.interactivePermissions;
    const env = process.env.CLAUDE_INTERACTIVE_PERMISSIONS;
    return env !== "0" && env !== "false";
  }

  /** Start a brand new session. Returns the generated session id. */
  newSession(
    prompt: string,
    cwd?: string,
    images?: ClaudeImage[],
    mode?: string,
  ): { sessionId: string } {
    const sessionId = randomUUID();
    const dir = cwd ?? this.opts.workspaceRoot();
    this.spawnWarm(sessionId, ["--session-id", sessionId], dir, mode);
    this.write(sessionId, prompt, images);
    return { sessionId };
  }

  /**
   * Send a prompt to an existing session. Reuses the warm process if present
   * (fast); otherwise resumes cold. Rejects if the session is live, unless forced.
   */
  async continueSession(
    sessionId: string,
    prompt: string,
    force = false,
    images?: ClaudeImage[],
    mode?: string,
  ): Promise<void> {
    const wantMode = this.resolveMode(mode);
    const warm = this.procs.get(sessionId);
    // a warm process spawned with a different permission mode must respawn
    if (warm && warm.mode !== wantMode) this.kill(sessionId);
    // warm path: write to the live process. If it was just reaped (idle race),
    // write() returns false and we fall through to a cold resume.
    else if (warm && this.write(sessionId, prompt, images)) {
      return;
    }
    if (!force && (await this.opts.store.isLive(sessionId))) {
      throw new SessionLiveError(sessionId);
    }
    const detail = await this.opts.store.getSession(sessionId);
    const dir = detail?.session.cwd ?? this.opts.workspaceRoot();
    this.spawnWarm(sessionId, ["--resume", sessionId], dir, mode);
    this.write(sessionId, prompt, images);
  }

  /**
   * Pre-spawn the warm process for a session (no prompt) so its startup +
   * config load happen off the critical path while the user reads/types.
   * No-op if already warm or the session is live elsewhere (would conflict).
   */
  async prewarm(sessionId: string): Promise<boolean> {
    if (this.procs.has(sessionId)) return false;
    if (await this.opts.store.isLive(sessionId)) return false;
    const detail = await this.opts.store.getSession(sessionId);
    if (!detail) return false;
    this.spawnWarm(sessionId, ["--resume", sessionId], detail.session.cwd);
    this.touch(sessionId); // arm idle reaper so an unused prewarm gets cleaned up
    return true;
  }

  interrupt(sessionId: string): boolean {
    const w = this.procs.get(sessionId);
    if (!w) return false;
    this.kill(sessionId);
    return true;
  }

  /** True when a turn is actively in flight for the session. */
  isDriving(sessionId: string): boolean {
    return this.procs.get(sessionId)?.busy ?? false;
  }

  /** True when this agent owns a warm process for the session (busy or idle). */
  owns(sessionId: string): boolean {
    return this.procs.has(sessionId);
  }

  private resolveMode(mode?: string): string {
    return mode ?? this.permissionMode;
  }

  private spawnWarm(sessionId: string, idArgs: string[], cwd: string, mode?: string): void {
    const spawnFn = this.opts.spawnFn ?? spawn;
    const resolved = this.resolveMode(mode);
    const args = [
      ...idArgs,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      resolved,
    ];
    // 方案 B: own the permission "ask" path over stdio so AskUserQuestion can be
    // answered interactively (otherwise the CLI headlessly auto-denies it).
    if (this.interactivePermissions) args.push("--permission-prompt-tool", "stdio");
    const proc = spawnFn(this.bin, args, { cwd, env: process.env }) as ChildProcessWithoutNullStreams;
    const w: WarmProc = {
      proc,
      buf: "",
      stderr: "",
      busy: false,
      idle: null,
      mode: resolved,
      pending: new Map(),
    };
    this.procs.set(sessionId, w);
    // Hand the control protocol an initialize so the CLI routes permission asks to
    // us as `can_use_tool` control_requests. stdin is buffered, so this safely
    // precedes the first prompt regardless of ordering.
    if (this.interactivePermissions) {
      this.writeControl(sessionId, {
        type: "control_request",
        request_id: `init-${randomUUID()}`,
        request: { subtype: "initialize", hooks: {} },
      });
    }

    proc.stdout.on("data", (chunk: Buffer | string) => {
      w.buf += chunk.toString();
      let nl: number;
      while ((nl = w.buf.indexOf("\n")) >= 0) {
        const line = w.buf.slice(0, nl);
        w.buf = w.buf.slice(nl + 1);
        this.handleLine(sessionId, line);
      }
    });
    proc.stderr.on("data", (c: Buffer) => {
      w.stderr += c.toString();
    });
    proc.on("error", (err) => {
      this.clearPending(sessionId);
      this.procs.delete(sessionId);
      this.opts.bus.emit("claude:drive_error", sessionId, err.message, now());
    });
    proc.on("close", (code) => {
      this.clearPending(sessionId);
      const existed = this.procs.delete(sessionId);
      if (existed && w.busy && code !== 0) {
        const msg = w.stderr.trim() || `claude exited with code ${code}`;
        this.opts.bus.emit("claude:drive_error", sessionId, msg, now());
      }
    });
  }

  /** Write a user turn to the warm process stdin. Returns false if no live proc. */
  private write(sessionId: string, prompt: string, images?: ClaudeImage[]): boolean {
    const w = this.procs.get(sessionId);
    if (!w || w.proc.stdin.destroyed) return false;
    w.busy = true;
    this.touch(sessionId);
    const content: unknown[] = [];
    for (const img of images ?? []) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 },
      });
    }
    content.push({ type: "text", text: prompt });
    const frame =
      JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    try {
      w.proc.stdin.write(frame);
      return true;
    } catch (err) {
      this.opts.bus.emit(
        "claude:drive_error",
        sessionId,
        err instanceof Error ? err.message : "write failed",
        now(),
      );
      return false;
    }
  }

  private handleLine(sessionId: string, line: string): void {
    if (this.handleControl(sessionId, line)) return;
    for (const ev of parseStreamLine(line)) {
      switch (ev.kind) {
        case "delta":
          this.opts.bus.emit("claude:delta", {
            sessionId,
            delta: ev.text,
            blockKind: ev.blockKind,
            status: "streaming",
            timestamp: now(),
          });
          break;
        case "done": {
          const w = this.procs.get(sessionId);
          if (w) w.busy = false;
          this.touch(sessionId); // keep warm; arm idle timer
          if (ev.isError) {
            this.opts.bus.emit("claude:drive_error", sessionId, ev.result ?? "drive failed", now());
          } else {
            this.opts.bus.emit("claude:drive_done", sessionId, now(), ev.usage);
          }
          break;
        }
        case "rate_limit":
          this.opts.bus.emit("claude:rate_limit", {
            resetsAt: ev.resetsAt,
            limitType: ev.limitType,
            status: ev.status,
          });
          break;
        case "error":
          this.opts.bus.emit("claude:drive_error", sessionId, ev.message, now());
          break;
        case "init":
          break;
      }
    }
  }

  /**
   * Intercept stdio control-protocol envelopes. Returns true if the line was a
   * control message (and thus must not be parsed as a stream event).
   *
   * - `can_use_tool` for AskUserQuestion → surface to the client and hold the
   *   request open until it answers (or the turn aborts).
   * - `can_use_tool` for any other tool → deny immediately (zero-regression: these
   *   ask-path tools were already auto-denied headlessly).
   * - `control_cancel_request` → the CLI gave up on a pending ask; drop + notify.
   * - `control_response` → the CLI's reply to our initialize; ignore.
   */
  private handleControl(sessionId: string, line: string): boolean {
    const t = line.trim();
    if (!t || t[0] !== "{") return false;
    let msg: {
      type?: string;
      request_id?: string;
      request?: { subtype?: string; tool_name?: string; input?: unknown };
    };
    try {
      msg = JSON.parse(t);
    } catch {
      return false;
    }
    if (msg.type === "control_response") return true; // reply to our initialize; nothing to do
    if (msg.type === "control_cancel_request") {
      const w = this.procs.get(sessionId);
      const rid = msg.request_id;
      if (w && rid && w.pending.delete(rid)) {
        this.opts.bus.emit("claude:permission_cancel", sessionId, rid);
        this.touch(sessionId);
      }
      return true;
    }
    if (msg.type !== "control_request" || !msg.request || !msg.request_id) {
      return msg.type === "control_request"; // malformed control_request: consume, ignore
    }
    const rid = msg.request_id;
    const req = msg.request;
    if (req.subtype !== "can_use_tool") {
      // unknown control_request subtype: ack empty success so the CLI doesn't stall
      this.writeControl(sessionId, {
        type: "control_response",
        response: { subtype: "success", request_id: rid, response: {} },
      });
      return true;
    }
    if (req.tool_name === "AskUserQuestion") {
      const questions = coerceQuestions(req.input);
      if (!questions) {
        this.respondPermissionDeny(sessionId, rid, "AskUserQuestion: no questions to ask.");
        return true;
      }
      const w = this.procs.get(sessionId);
      if (w) {
        w.pending.set(rid, { input: req.input });
        if (w.idle) clearTimeout(w.idle); // genuinely awaiting the user — don't reap
        w.idle = null;
      }
      this.opts.bus.emit("claude:permission_request", sessionId, rid, "AskUserQuestion", questions);
      return true;
    }
    // Any other tool that reached the ask path stays denied (see method doc).
    this.respondPermissionDeny(
      sessionId,
      rid,
      `${req.tool_name} 需要交互式批准，Web 控制台暂不支持该工具的审批。`,
    );
    return true;
  }

  /**
   * Answer a pending interactive permission (AskUserQuestion) with the user's
   * choices. `answers` maps question text → chosen label(s). Returns false if the
   * request is no longer pending (already answered / turn aborted).
   */
  answerPermission(
    sessionId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ): boolean {
    const w = this.procs.get(sessionId);
    if (!w) return false;
    const pend = w.pending.get(requestId);
    if (!pend) return false;
    w.pending.delete(requestId);
    const baseInput = (pend.input && typeof pend.input === "object" ? pend.input : {}) as Record<
      string,
      unknown
    >;
    const ok = this.writeControl(sessionId, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { behavior: "allow", updatedInput: { ...baseInput, answers } },
      },
    });
    this.opts.bus.emit("claude:permission_cancel", sessionId, requestId); // dismiss the picker
    this.touch(sessionId); // re-arm the idle reaper; the turn resumes
    return ok;
  }

  private respondPermissionDeny(sessionId: string, requestId: string, message: string): void {
    this.writeControl(sessionId, {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: { behavior: "deny", message } },
    });
  }

  /** Write a control-protocol envelope to the warm process stdin. */
  private writeControl(sessionId: string, obj: unknown): boolean {
    const w = this.procs.get(sessionId);
    if (!w || w.proc.stdin.destroyed) return false;
    try {
      w.proc.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** Drop any pending permission asks for a session and notify the client. */
  private clearPending(sessionId: string): void {
    const w = this.procs.get(sessionId);
    if (!w || w.pending.size === 0) return;
    for (const rid of [...w.pending.keys()]) {
      this.opts.bus.emit("claude:permission_cancel", sessionId, rid);
    }
    w.pending.clear();
  }

  /** (Re)arm the idle timer that reaps a warm process after inactivity. */
  private touch(sessionId: string): void {
    const w = this.procs.get(sessionId);
    if (!w) return;
    if (w.idle) clearTimeout(w.idle);
    w.idle = setTimeout(() => this.kill(sessionId), this.idleMs);
    // don't keep the event loop alive just for the reaper
    w.idle.unref?.();
  }

  private kill(sessionId: string): void {
    const w = this.procs.get(sessionId);
    if (!w) return;
    if (w.idle) clearTimeout(w.idle);
    this.clearPending(sessionId);
    this.procs.delete(sessionId);
    try {
      w.proc.stdin.end();
    } catch {
      /* noop */
    }
    try {
      w.proc.kill("SIGTERM");
    } catch {
      /* noop */
    }
  }

  destroyAll(): void {
    for (const id of [...this.procs.keys()]) this.kill(id);
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Coerce an AskUserQuestion tool input into client-facing questions, or null. */
function coerceQuestions(input: unknown): ClaudePermissionQuestion[] | null {
  if (!input || typeof input !== "object") return null;
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: ClaudePermissionQuestion[] = [];
  for (const q of qs) {
    if (!q || typeof q !== "object") continue;
    const opts = (q as { options?: unknown }).options;
    if (!Array.isArray(opts)) continue;
    out.push({
      question: String((q as { question?: unknown }).question ?? ""),
      header: (q as { header?: unknown }).header ? String((q as { header?: unknown }).header) : undefined,
      multiSelect: !!(q as { multiSelect?: unknown }).multiSelect,
      options: opts
        .filter((o): o is { label: unknown; description?: unknown } => !!o && typeof o === "object" && "label" in o)
        .map((o) => ({
          label: String(o.label),
          description: o.description != null ? String(o.description) : undefined,
        })),
    });
  }
  return out.length ? out : null;
}
