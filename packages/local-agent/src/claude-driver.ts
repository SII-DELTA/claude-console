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

/** One persisted pending row (AskUserQuestion or tool approval). */
interface PendingRecord {
  requestId: string;
  sessionId: string;
  toolName: string;
  kind?: "question" | "approval";
  questions: unknown;
  toolInput?: unknown;
  createdAt: string;
}

/** Durable store for pending permission asks (so they survive restart). */
export interface PendingPermissionStore {
  savePendingPermission(rec: PendingRecord): void;
  deletePendingPermission(requestId: string): void;
  deletePendingPermissionsBySession(sessionId: string): void;
  getPendingPermission(requestId: string): PendingRecord | null;
  listPendingPermissions(sessionId: string): PendingRecord[];
}

/** One recoverable pending AskUserQuestion returned to clients. */
export interface PendingPermissionView {
  requestId: string;
  toolName: string;
  questions: ClaudePermissionQuestion[];
  live: boolean;
}

/** One recoverable pending tool approval (allow/deny) returned to clients. */
export interface ToolApprovalView {
  requestId: string;
  toolName: string;
  summary: string;
  live: boolean;
}

/** Kill a warm process after this much inactivity to free memory. */
const IDLE_TIMEOUT_MS = 5 * 60_000;
/** Don't prewarm sessions whose transcript exceeds this — the cold `--resume` parse
 * cost outweighs the latency saved, and the user may never continue them. */
const PREWARM_MAX_BYTES = 8 * 1024 * 1024;

interface WarmProc {
  proc: ChildProcessWithoutNullStreams;
  buf: string;
  stderr: string;
  busy: boolean;
  idle: NodeJS.Timeout | null;
  mode: string;
  /** Interactive asks (can_use_tool) awaiting a client decision, by request_id. */
  pending: Map<string, { input: unknown; toolName: string; kind: "question" | "approval" }>;
  /**
   * When set, the next AskUserQuestion can_use_tool in this process is
   * auto-answered with these answers instead of being surfaced — used to deliver
   * a recovered answer after a `--resume` (the model re-issues the question).
   */
  resumeAnswers?: Record<string, string | string[]>;
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
  /** Durable store so a pending AskUserQuestion survives reload / agent restart. */
  pendingStore?: PendingPermissionStore;
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
  async prewarm(sessionId: string, mode?: string): Promise<boolean> {
    if (this.procs.has(sessionId)) return false;
    if (await this.opts.store.isLive(sessionId)) return false;
    // Skip huge transcripts: `claude --resume` would parse the whole JSONL just to sit
    // idle — not worth the CPU/IO when the user may never continue this session.
    const size = await this.opts.store.sessionFileSize(sessionId);
    if (size != null && size > PREWARM_MAX_BYTES) return false;
    const detail = await this.opts.store.getSession(sessionId);
    if (!detail) return false;
    // Spawn with the mode the client will actually use, so the first send doesn't kill
    // and cold-resume this process on a mode mismatch (wasting the whole prewarm).
    this.spawnWarm(sessionId, ["--resume", sessionId], detail.session.cwd, mode);
    this.touch(sessionId); // arm idle reaper so an unused prewarm gets cleaned up
    return true;
  }

  interrupt(sessionId: string): boolean {
    // explicit abandon ⇒ drop any durable pending asks (don't resurface later)
    this.opts.pendingStore?.deletePendingPermissionsBySession(sessionId);
    const w = this.procs.get(sessionId);
    if (w) this.kill(sessionId);
    // rows were dropped above → re-derive so any "approval" badge clears now
    void this.opts.store.refreshSession(sessionId);
    return !!w;
  }

  /** True when a turn is actively in flight for the session. */
  isDriving(sessionId: string): boolean {
    return this.procs.get(sessionId)?.busy ?? false;
  }

  /** Toggle the authoritative "a turn is running" flag, emitting `claude:driving`
   *  only on an actual transition (de-duped) so the ws broadcast isn't spammed. */
  private setBusy(sessionId: string, busy: boolean): void {
    const w = this.procs.get(sessionId);
    const prev = w?.busy ?? false;
    if (w) w.busy = busy;
    if (prev !== busy) this.opts.bus.emit("claude:driving", sessionId, busy);
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
      this.setBusy(sessionId, false); // turn died → clear "running"
      this.clearPending(sessionId);
      this.procs.delete(sessionId);
      this.opts.bus.emit("claude:drive_error", sessionId, err.message, now());
    });
    proc.on("close", (code) => {
      const wasBusy = w.busy;
      this.setBusy(sessionId, false); // turn ended (crash/exit) → clear "running"
      this.clearPending(sessionId);
      const existed = this.procs.delete(sessionId);
      if (existed && wasBusy && code !== 0) {
        const msg = w.stderr.trim() || `claude exited with code ${code}`;
        this.opts.bus.emit("claude:drive_error", sessionId, msg, now());
      }
    });
  }

  /** Write a user turn to the warm process stdin. Returns false if no live proc. */
  private write(sessionId: string, prompt: string, images?: ClaudeImage[]): boolean {
    const w = this.procs.get(sessionId);
    if (!w || w.proc.stdin.destroyed) return false;
    this.setBusy(sessionId, true); // authoritative "a turn started"
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
          this.touch(sessionId); // streaming activity → keep the idle reaper from firing mid-turn
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
          if (w) w.resumeAnswers = undefined; // drop any unconsumed recovery answer
          this.setBusy(sessionId, false); // authoritative "the turn finished"
          // turn finished ⇒ no question can still be pending; clear durable rows
          this.opts.pendingStore?.deletePendingPermissionsBySession(sessionId);
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
        this.opts.pendingStore?.deletePendingPermission(rid); // claude abandoned it
        this.opts.bus.emit("claude:permission_cancel", sessionId, rid);
        void this.opts.store.refreshSession(sessionId); // clear any "approval" badge
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
      // Recovery path: a `--resume` armed an answer for the re-issued question →
      // auto-answer it instead of bothering the user again.
      if (w?.resumeAnswers) {
        const answers = w.resumeAnswers;
        w.resumeAnswers = undefined;
        const base = (req.input && typeof req.input === "object" ? req.input : {}) as Record<
          string,
          unknown
        >;
        this.writeControl(sessionId, {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: rid,
            response: { behavior: "allow", updatedInput: { ...base, answers } },
          },
        });
        return true;
      }
      if (w) {
        w.pending.set(rid, { input: req.input, toolName: "AskUserQuestion", kind: "question" });
        if (w.idle) clearTimeout(w.idle); // genuinely awaiting the user — don't reap
        w.idle = null;
      }
      // persist so the picker survives reload / reconnect / agent restart
      this.opts.pendingStore?.savePendingPermission({
        requestId: rid,
        sessionId,
        toolName: "AskUserQuestion",
        kind: "question",
        questions,
        createdAt: now(),
      });
      this.opts.bus.emit("claude:permission_request", sessionId, rid, "AskUserQuestion", questions);
      return true;
    }
    // Any other tool that reached the ask path → surface a generic allow/deny approval.
    const toolName = req.tool_name ?? "工具";
    const summary = summarizeToolInput(toolName, req.input);
    const w = this.procs.get(sessionId);
    if (w) {
      w.pending.set(rid, { input: req.input, toolName, kind: "approval" });
      if (w.idle) clearTimeout(w.idle); // awaiting the user — don't reap
      w.idle = null;
    }
    this.opts.pendingStore?.savePendingPermission({
      requestId: rid,
      sessionId,
      toolName,
      kind: "approval",
      questions: [],
      toolInput: req.input,
      createdAt: now(),
    });
    this.opts.bus.emit("claude:tool_approval_request", sessionId, rid, toolName, summary);
    // approvals aren't in the jsonl → re-derive + broadcast the "approval" attention
    void this.opts.store.refreshSession(sessionId);
    return true;
  }

  /**
   * Answer a pending tool approval: `allow` runs the tool with its original input;
   * `deny` rejects it with a clean (non-error) message so the turn continues.
   * Returns false if the request isn't a live approval in-process.
   */
  approveTool(sessionId: string, requestId: string, decision: "allow" | "deny"): boolean {
    const w = this.procs.get(sessionId);
    if (!w) return false;
    const pend = w.pending.get(requestId);
    if (!pend || pend.kind !== "approval") return false;
    const baseInput = (pend.input && typeof pend.input === "object" ? pend.input : {}) as Record<
      string,
      unknown
    >;
    const response =
      decision === "allow"
        ? { behavior: "allow", updatedInput: { ...baseInput } }
        : { behavior: "deny", message: "用户拒绝了该操作。" };
    const ok = this.writeControl(sessionId, {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
    if (!ok) return false;
    w.pending.delete(requestId);
    this.opts.pendingStore?.deletePendingPermission(requestId);
    this.opts.bus.emit("claude:permission_cancel", sessionId, requestId); // dismiss the panel
    void this.opts.store.refreshSession(sessionId); // clear the "approval" attention badge
    this.touch(sessionId); // re-arm the idle reaper; the turn resumes
    return true;
  }

  /**
   * Drop a pending tool approval that can no longer be answered in-process (the
   * process died and it was recovered as `live:false`). Deletes the durable row,
   * dismisses the panel, and clears the "approval" badge. Returns true if an
   * approval row was actually dropped (idempotent / kind-checked).
   */
  dropApproval(sessionId: string, requestId: string): boolean {
    const rec = this.opts.pendingStore?.getPendingPermission(requestId);
    if (!rec || rec.sessionId !== sessionId || rec.kind !== "approval") return false;
    this.opts.pendingStore?.deletePendingPermission(requestId);
    this.procs.get(sessionId)?.pending.delete(requestId);
    this.opts.bus.emit("claude:permission_cancel", sessionId, requestId);
    void this.opts.store.refreshSession(sessionId);
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
    if (!pend || pend.kind !== "question") return false; // not an AskUserQuestion
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
    // Write failed (stdin gone, process died mid-flight): keep both the in-memory
    // and durable record so the HTTP layer can fall back to the resume-recovery
    // path — the answer must not be silently dropped.
    if (!ok) return false;
    w.pending.delete(requestId);
    this.opts.pendingStore?.deletePendingPermission(requestId);
    this.opts.bus.emit("claude:permission_cancel", sessionId, requestId); // dismiss the picker
    this.touch(sessionId); // re-arm the idle reaper; the turn resumes
    return true;
  }

  /**
   * Close a live AskUserQuestion WITHOUT answering: tell claude the user declined
   * (allow with no answers → "The user did not answer the questions.", a clean
   * non-error result), so the turn continues instead of hanging. Returns false if
   * the request isn't live in-process.
   */
  declinePermission(sessionId: string, requestId: string): boolean {
    const w = this.procs.get(sessionId);
    if (!w) return false;
    const pend = w.pending.get(requestId);
    if (!pend || pend.kind !== "question") return false; // not an AskUserQuestion
    const baseInput = (pend.input && typeof pend.input === "object" ? pend.input : {}) as Record<
      string,
      unknown
    >;
    const ok = this.writeControl(sessionId, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { behavior: "allow", updatedInput: { ...baseInput } },
      },
    });
    if (!ok) return false;
    w.pending.delete(requestId);
    this.opts.pendingStore?.deletePendingPermission(requestId);
    this.opts.bus.emit("claude:permission_cancel", sessionId, requestId);
    this.touch(sessionId);
    return true;
  }

  /** Drop durable pending rows for a session without killing the process. */
  clearPersistedPending(sessionId: string): void {
    this.opts.pendingStore?.deletePendingPermissionsBySession(sessionId);
  }

  /**
   * Answer a permission that is no longer live in-process (e.g. after an agent
   * restart): `--resume` the session, arm the answer, and nudge the model to
   * re-issue the question so we can auto-answer it cleanly. Returns false if no
   * such persisted request exists.
   */
  async recoverAnswerPermission(
    sessionId: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ): Promise<boolean> {
    const rec = this.opts.pendingStore?.getPendingPermission(requestId);
    if (!rec || rec.sessionId !== sessionId) return false;
    this.opts.pendingStore?.deletePendingPermission(requestId);
    // reuse a warm process if one happens to exist; otherwise resume cold
    if (!this.procs.has(sessionId)) {
      const detail = await this.opts.store.getSession(sessionId);
      const dir = detail?.session.cwd ?? this.opts.workspaceRoot();
      this.spawnWarm(sessionId, ["--resume", sessionId], dir);
    }
    const w = this.procs.get(sessionId);
    if (w) w.resumeAnswers = answers;
    this.opts.bus.emit("claude:permission_cancel", sessionId, requestId);
    // nudge the model to continue; it re-asks AskUserQuestion → auto-answered above
    this.write(sessionId, "请根据我刚提交的选择继续。");
    return true;
  }

  /** Recoverable pending permissions for a session (durable rows; live if in-process). */
  listPending(sessionId: string): PendingPermissionView[] {
    const rows = this.opts.pendingStore?.listPendingPermissions(sessionId) ?? [];
    const w = this.procs.get(sessionId);
    const out: PendingPermissionView[] = [];
    for (const rec of rows) {
      const questions = Array.isArray(rec.questions)
        ? (rec.questions as ClaudePermissionQuestion[])
        : null;
      if (!questions || questions.length === 0) continue;
      out.push({
        requestId: rec.requestId,
        toolName: rec.toolName,
        questions,
        live: !!w?.pending.has(rec.requestId),
      });
    }
    return out;
  }

  /** Recoverable pending tool approvals for a session (durable rows; live if in-process). */
  listPendingApprovals(sessionId: string): ToolApprovalView[] {
    const rows = this.opts.pendingStore?.listPendingPermissions(sessionId) ?? [];
    const w = this.procs.get(sessionId);
    const out: ToolApprovalView[] = [];
    for (const rec of rows) {
      if (rec.kind !== "approval") continue;
      out.push({
        requestId: rec.requestId,
        toolName: rec.toolName,
        summary: summarizeToolInput(rec.toolName, rec.toolInput),
        live: !!w?.pending.has(rec.requestId),
      });
    }
    return out;
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
    w.idle = setTimeout(() => this.reapIfIdle(sessionId), this.idleMs);
    // don't keep the event loop alive just for the reaper
    w.idle.unref?.();
  }

  /** Idle-timer callback: never kill a process mid-turn. A busy session is in an
   * active turn (a long tool run / long generation produces no stdout to touch on),
   * so re-arm instead of reaping — the reaper only frees genuinely idle processes.
   * (`kill()` itself stays unconditional, for interrupt / shutdown / mode-switch.) */
  private reapIfIdle(sessionId: string): void {
    const w = this.procs.get(sessionId);
    if (!w) return;
    if (w.busy) {
      this.touch(sessionId); // active turn → defer reaping
      return;
    }
    this.kill(sessionId);
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

/** Human-readable one-line summary of a tool's input for the approval panel. */
export function summarizeToolInput(toolName: string, input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const clip = (s: unknown, n = 200): string => {
    const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
    const oneLine = str.replace(/\s+/g, " ").trim();
    return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
  };
  switch (toolName) {
    case "Bash":
      return clip(obj.command);
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "Read":
    case "NotebookEdit":
      return clip(obj.file_path ?? obj.notebook_path ?? obj);
    case "WebFetch":
      return clip(obj.url);
    case "WebSearch":
      return clip(obj.query);
    default:
      return clip(obj);
  }
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
