import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import chokidar, { type FSWatcher } from "chokidar";
import {
  LIVE_WINDOW_MS,
  type ClaudeMessage,
  type ClaudeProject,
  type ClaudeSession,
} from "@mac/shared";
import type { Bus } from "./bus.js";
import {
  accumulate,
  deriveActivity,
  deriveAttention,
  deriveLastUser,
  deriveResult,
  deriveTitle,
  encodeProjectDir,
  newAccumulator,
  parseLine,
  type SessionAccumulator,
} from "./util/claude-jsonl.js";

/**
 * Reads + mirrors Claude Code native sessions from
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
 *
 * - listSessions()/getSession() parse on demand.
 * - start() begins a chokidar watch that incrementally tails appended lines and
 *   emits `claude:message` / `claude:session_updated` on the bus.
 */
/** session ids are UUID-ish; project dirs are alnum+dash — reject anything that
 *  could traverse the filesystem (slashes, dots, ..). */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_DIR = /^[A-Za-z0-9_-]{1,256}$/;

export class ClaudeStore {
  private watcher: FSWatcher | null = null;
  /** byte offset already consumed per file path */
  private offsets = new Map<string, number>();
  /** explicit active project dir override (set when the user switches project) */
  private activeDir: string | null = null;
  /** predicate injected by the runtime: is this session driven by our agent? */
  private drivenPredicate: ((id: string) => boolean) | null = null;
  /** predicate injected by the runtime: is our agent actively running a turn for it? */
  private drivingPredicate: ((id: string) => boolean) | null = null;
  /** predicates injected by the runtime: hook-derived liveness (any entrypoint). */
  private livenessBusyPredicate: ((id: string) => boolean) | null = null;
  private livenessAlivePredicate: ((id: string) => boolean) | null = null;
  /** predicate injected by the runtime: does this session have a pending tool approval? */
  private pendingApprovalPredicate: ((id: string) => boolean) | null = null;
  /** predicate injected by the runtime: the Haiku observer's current-task summary. */
  private currentTaskPredicate: ((id: string) => string | undefined) | null = null;
  /** AskUserQuestion ids the user dismissed → excluded from the "question" attention */
  private dismissedQuestions = new Set<string>();

  constructor(
    private workspaceRoot: string,
    private workspaceId: string,
    private readonly bus?: Bus,
    private readonly projectsRoot = join(homedir(), ".claude", "projects"),
  ) {}

  setWorkspace(workspaceRoot: string, workspaceId: string): void {
    this.workspaceRoot = workspaceRoot;
    this.workspaceId = workspaceId;
    this.activeDir = null;
    // watcher covers the whole projects root → no restart needed on workspace change
  }

  /** Lets the runtime tell us which sessions our own driver currently owns. */
  setDrivenPredicate(fn: (id: string) => boolean): void {
    this.drivenPredicate = fn;
  }

  /** Lets the runtime tell us which sessions our driver has a turn in flight for. */
  setDrivingPredicate(fn: (id: string) => boolean): void {
    this.drivingPredicate = fn;
  }

  /** Hook-derived liveness (covers terminal/VSCode/our-own sessions uniformly). */
  setLivenessPredicates(busy: (id: string) => boolean, alive: (id: string) => boolean): void {
    this.livenessBusyPredicate = busy;
    this.livenessAlivePredicate = alive;
  }

  /** Lets the runtime tell us which sessions have a pending tool approval (not in jsonl). */
  setPendingApprovalPredicate(fn: (id: string) => boolean): void {
    this.pendingApprovalPredicate = fn;
  }

  /** Lets the runtime supply the Haiku observer's current-task summary per session. */
  setCurrentTaskPredicate(fn: (id: string) => string | undefined): void {
    this.currentTaskPredicate = fn;
  }

  /** Seed the dismissed-question set (from durable storage at startup). */
  setDismissedQuestions(ids: Iterable<string>): void {
    this.dismissedQuestions = new Set(ids);
  }

  /** Mark question ids as dismissed so they stop counting toward "question" attention. */
  addDismissedQuestions(ids: string[]): void {
    for (const id of ids) this.dismissedQuestions.add(id);
  }

  /** Current open (unanswered) AskUserQuestion ids for a session. */
  async getOpenQuestionIds(id: string): Promise<string[]> {
    if (!SAFE_ID.test(id)) return [];
    const file = this.sessionFile(id);
    if (!existsSync(file)) return [];
    const acc = await this.foldFile(file, false);
    return [...acc.openQuestionIds];
  }

  /** Re-read a session's meta and broadcast it (e.g. after a dismiss). */
  async refreshSession(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return;
    const meta = await this.readSessionMeta(this.sessionFile(id));
    if (meta) this.bus?.emit("claude:session_updated", meta);
  }

  /** cwd used as the default for new sessions in the active project. */
  activeCwd(): string {
    return this.workspaceRoot;
  }

  private projectDir(): string {
    return this.activeDir
      ? join(this.projectsRoot, this.activeDir)
      : join(this.projectsRoot, encodeProjectDir(this.workspaceRoot));
  }

  /** List all Claude Code projects under ~/.claude/projects. */
  async listProjects(): Promise<ClaudeProject[]> {
    const activeDirName = this.activeDir ?? encodeProjectDir(this.workspaceRoot);
    const entries = await safeListDirs(this.projectsRoot);
    const projects = await Promise.all(
      entries.map((dir) => this.readProjectMeta(dir, dir === activeDirName)),
    );
    return projects
      .filter((p): p is ClaudeProject => !!p)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Switch the active project to the given encoded dir name. */
  async switchProject(dir: string): Promise<ClaudeProject | null> {
    if (!SAFE_DIR.test(dir)) return null;
    const full = join(this.projectsRoot, dir);
    if (!existsSync(full)) return null;
    const meta = await this.readProjectMeta(dir, true);
    if (!meta) return null;
    this.activeDir = dir;
    this.workspaceRoot = meta.cwd; // new sessions land in the real project cwd
    this.workspaceId = dir;
    // watcher already covers all projects → no restart needed
    return meta;
  }

  private async readProjectMeta(dir: string, active: boolean): Promise<ClaudeProject | null> {
    const full = join(this.projectsRoot, dir);
    const files = (await safeList(full)).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    let cwd = "";
    let updatedAt = "";
    let sessionCount = 0;
    let liveCount = 0;
    for (const f of files) {
      const file = join(full, f);
      const mt = await safeMtimeMs(file);
      if (!cwd) {
        // read just enough to learn the project's real cwd
        const acc = await this.foldFile(file, false);
        if (acc.cwd) cwd = acc.cwd;
        if (acc.messageCount > 0) sessionCount += 1;
      } else {
        sessionCount += 1;
      }
      const iso = mt ? new Date(mt).toISOString() : "";
      if (iso > updatedAt) updatedAt = iso;
      if (mt != null && nowMs() - mt < LIVE_WINDOW_MS) liveCount += 1;
    }
    const resolvedCwd = cwd || dir.replace(/^-/, "/").replace(/-/g, "/");
    return {
      dir,
      cwd: resolvedCwd,
      name: resolvedCwd.split("/").filter(Boolean).pop() ?? dir,
      sessionCount,
      liveCount,
      updatedAt: updatedAt || new Date(0).toISOString(),
      active,
    };
  }

  private sessionFile(id: string): string {
    return join(this.projectDir(), `${id}.jsonl`);
  }

  async listSessions(): Promise<ClaudeSession[]> {
    const dir = this.projectDir();
    const files = await safeList(dir);
    const sessions = await Promise.all(
      files
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => this.readSessionMeta(join(dir, f))),
    );
    return sessions
      .filter((s): s is ClaudeSession => !!s && s.messageCount > 0)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** List sessions across ALL projects (dashboard overview; meta-only). */
  async listAllSessions(): Promise<ClaudeSession[]> {
    const files = await this.allSessionFiles();
    const sessions = await Promise.all(files.map((f) => this.readSessionMeta(f)));
    return sessions
      .filter((s): s is ClaudeSession => !!s && s.messageCount > 0)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Absolute paths of every session jsonl under every project dir. */
  private async allSessionFiles(): Promise<string[]> {
    const dirs = await safeListDirs(this.projectsRoot);
    const out: string[] = [];
    for (const d of dirs) {
      const full = join(this.projectsRoot, d);
      for (const f of await safeList(full)) {
        if (f.endsWith(".jsonl")) out.push(join(full, f));
      }
    }
    return out;
  }

  async getSession(
    id: string,
    opts?: { limit?: number; before?: number },
  ): Promise<{
    session: ClaudeSession;
    messages: ClaudeMessage[];
    total: number;
    offset: number;
  } | null> {
    if (!SAFE_ID.test(id)) return null;
    const file = this.sessionFile(id);
    if (!existsSync(file)) return null;
    const acc = await this.foldFile(file, true);
    const session = this.buildSession(id, file, acc, await safeMtimeMs(file));
    if (!session) return null;
    const all = acc.messages;
    const total = all.length;
    // No limit → whole history (back-compat for internal callers / driver).
    // before: absolute index; return the page ending just before it.
    const end = opts?.before != null ? Math.max(0, Math.min(opts.before, total)) : total;
    const limit = opts?.limit != null && opts.limit > 0 ? opts.limit : total;
    const start = Math.max(0, end - limit);
    return { session, messages: all.slice(start, end), total, offset: start };
  }

  /** Lightweight meta read (no message retention). */
  private async readSessionMeta(file: string): Promise<ClaudeSession | null> {
    const acc = await this.foldFile(file, false);
    return this.buildSession(basename(file, ".jsonl"), file, acc, await safeMtimeMs(file));
  }

  private async foldFile(file: string, keepMessages: boolean): Promise<SessionAccumulator> {
    const acc = newAccumulator();
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return acc;
    }
    for (const line of raw.split("\n")) {
      const parsed = parseLine(line);
      if (parsed) accumulate(acc, parsed, keepMessages);
    }
    return acc;
  }

  private buildSession(
    id: string,
    file: string,
    acc: SessionAccumulator,
    mtimeMs: number | null,
  ): ClaudeSession | null {
    if (acc.messageCount === 0) return null;
    const updatedAt =
      acc.lastTimestamp ?? (mtimeMs ? new Date(mtimeMs).toISOString() : new Date(0).toISOString());
    const drivenByAgent = this.drivenPredicate?.(id) ?? false;
    // "Running a turn now" — union of the hook-derived state (any entrypoint) and our
    // own driver (instant, no hook install/restart needed). Authoritative; not mtime.
    const driving = (this.livenessBusyPredicate?.(id) ?? false) || (this.drivingPredicate?.(id) ?? false);
    // "Has a live process" — hook-tracked liveness, or our own warm proc, or (fallback
    // for sessions started before hooks were installed) a recently-written jsonl.
    const mtimeFresh = mtimeMs != null && nowMs() - mtimeMs < LIVE_WINDOW_MS;
    const isLive = (this.livenessAlivePredicate?.(id) ?? false) || drivenByAgent || driving || mtimeFresh;
    return {
      id,
      title: deriveTitle(acc, id),
      workspaceId: this.workspaceId,
      cwd: acc.cwd ?? this.workspaceRoot,
      sessionFilePath: file,
      updatedAt,
      messageCount: acc.messageCount,
      userMessageCount: acc.userMessageCount,
      assistantMessageCount: acc.assistantMessageCount,
      toolUseCount: acc.toolUseCount,
      modelId: acc.modelId,
      isLive,
      driving,
      drivenByAgent,
      preview: acc.firstUserText?.slice(0, 140),
      // dynamic "current task" layers: A = latest user instruction, C = Haiku summary,
      // B = running activity / done result (frontend picks per state).
      lastUserText: deriveLastUser(acc),
      currentTask: this.currentTaskPredicate?.(id) || undefined,
      lastActivity: deriveActivity(acc),
      lastResult: deriveResult(acc),
      // a pending tool approval (runtime control-protocol state, not in the jsonl)
      // takes precedence; otherwise derive question/done/error from the jsonl.
      attention: (this.pendingApprovalPredicate?.(id) ?? false)
        ? "approval"
        : deriveAttention(acc, isLive, this.dismissedQuestions),
    };
  }

  /** Returns true if the session file is being written within the live window. */
  async isLive(id: string): Promise<boolean> {
    if (!SAFE_ID.test(id)) return false;
    const m = await safeMtimeMs(this.sessionFile(id));
    return m != null && nowMs() - m < LIVE_WINDOW_MS;
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    // Watch the WHOLE projects root (depth 1) so the dashboard's cross-project
    // overview updates live, not just the active project. onFileChanged reads meta
    // by file path, so it's project-agnostic; detail/driver paths still scope to the
    // active project via projectDir().
    const root = this.projectsRoot;
    await fs.mkdir(root, { recursive: true }).catch(() => {});
    // seed offsets to current file sizes so we only stream *new* lines
    for (const p of await this.allSessionFiles()) {
      this.offsets.set(p, (await safeSize(p)) ?? 0);
    }
    // chokidar v4 dropped glob support — watch the root and filter in handlers.
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
    });
    this.watcher.on("add", (p) => {
      if (p.endsWith(".jsonl")) void this.onFileChanged(p);
    });
    this.watcher.on("change", (p) => {
      if (p.endsWith(".jsonl")) void this.onFileChanged(p);
    });
    // Wait for the initial scan so appends right after start() are not missed.
    await new Promise<void>((resolve) => {
      const w = this.watcher;
      if (!w) return resolve();
      w.once("ready", () => resolve());
    });
  }

  private async onFileChanged(file: string): Promise<void> {
    const id = basename(file, ".jsonl");
    const from = this.offsets.get(file) ?? 0;
    const size = (await safeSize(file)) ?? 0;
    if (size < from) {
      // file truncated/rewritten — reset
      this.offsets.set(file, 0);
      return this.onFileChanged(file);
    }
    if (size > from) {
      const chunk = await readRange(file, from, size);
      // keep only complete lines; stash partial remainder by rewinding offset
      const lastNl = chunk.lastIndexOf("\n");
      const consumable = lastNl >= 0 ? chunk.slice(0, lastNl) : "";
      const consumedBytes = lastNl >= 0 ? Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8") : 0;
      this.offsets.set(file, from + consumedBytes);
      for (const line of consumable.split("\n")) {
        const parsed = parseLine(line);
        if (parsed?.message) {
          this.bus?.emit("claude:message", parsed.message.sessionId, parsed.message);
        }
      }
    }
    // refresh session meta regardless (isLive / counts changed)
    const meta = await this.readSessionMeta(file);
    if (meta) this.bus?.emit("claude:session_updated", meta);
    void id;
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

/* ─────────────────────────── fs helpers ─────────────────────────── */

function nowMs(): number {
  return Date.now();
}

async function safeList(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function safeListDirs(dir: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function safeMtimeMs(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

async function safeSize(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return null;
  }
}

async function readRange(file: string, start: number, end: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const len = end - start;
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}
