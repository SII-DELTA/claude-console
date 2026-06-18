import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join, basename, dirname, resolve as resolvePath } from "node:path";
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
  /** mtime-keyed cache of the folded accumulator (sans messages), so list scans don't
   * re-parse hundreds of MB of unchanged JSONL on every poll (the /claude/sessions
   * timeout). Bounded; the runtime-/time-dependent fields are recomputed each call. */
  private metaCache = new Map<string, { mtimeMs: number; acc: SessionAccumulator }>();
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
  /** AskUserQuestion ids the user dismissed → excluded from the "question" attention */
  private dismissedQuestions = new Set<string>();
  /** project dirs the user hid → excluded from monitor overview / switcher */
  private hiddenDirs = new Set<string>();
  /** real cwds the user manually added (pinned) → shown even with 0 sessions */
  private pinnedCwds = new Set<string>();

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

  /** Seed the dismissed-question set (from durable storage at startup). */
  setDismissedQuestions(ids: Iterable<string>): void {
    this.dismissedQuestions = new Set(ids);
  }

  /** Mark question ids as dismissed so they stop counting toward "question" attention. */
  addDismissedQuestions(ids: string[]): void {
    for (const id of ids) this.dismissedQuestions.add(id);
  }

  /* ---------------- project hide / pin (durable state injected by runtime) ------- */
  setHiddenProjects(dirs: Iterable<string>): void {
    this.hiddenDirs = new Set(dirs);
  }
  addHiddenProject(dir: string): void {
    this.hiddenDirs.add(dir);
  }
  removeHiddenProject(dir: string): void {
    this.hiddenDirs.delete(dir);
  }
  setPinnedProjects(cwds: Iterable<string>): void {
    this.pinnedCwds = new Set(cwds);
  }
  addPinnedProject(cwd: string): void {
    this.pinnedCwds.add(cwd);
  }
  removePinnedProject(cwd: string): void {
    this.pinnedCwds.delete(cwd);
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

  /** List all Claude Code projects under ~/.claude/projects (incl. hidden + pinned). */
  async listProjects(): Promise<ClaudeProject[]> {
    const activeDirName = this.activeDir ?? encodeProjectDir(this.workspaceRoot);
    const entries = await safeListDirs(this.projectsRoot);
    const scanned = await Promise.all(
      entries.map((dir) => this.readProjectMeta(dir, dir === activeDirName)),
    );
    const byDir = new Map<string, ClaudeProject>();
    for (const p of scanned) {
      if (p) byDir.set(p.dir, { ...p, hidden: this.hiddenDirs.has(p.dir) });
    }
    // pinned cwds with no scanned project yet → synthesize an empty (0-session) entry
    for (const cwd of this.pinnedCwds) {
      const dir = encodeProjectDir(cwd);
      const existing = byDir.get(dir);
      if (existing) {
        byDir.set(dir, { ...existing, pinned: true });
      } else {
        byDir.set(dir, {
          dir,
          cwd,
          name: cwd.split("/").filter(Boolean).pop() ?? dir,
          sessionCount: 0,
          liveCount: 0,
          updatedAt: new Date(0).toISOString(),
          active: dir === activeDirName,
          hidden: this.hiddenDirs.has(dir),
          pinned: true,
        });
      }
    }
    return [...byDir.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Browse a directory (folders only) for the project directory picker. */
  async listDir(input?: string): Promise<{
    path: string;
    parent: string | null;
    home: string;
    entries: { name: string; path: string }[];
  }> {
    const home = homedir();
    const raw = !input || input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
    const path = resolvePath(raw);
    const parent = path === "/" ? null : dirname(path);
    let entries: { name: string; path: string }[] = [];
    try {
      const ents = await fs.readdir(path, { withFileTypes: true });
      const dirs = await Promise.all(
        ents.map(async (e) => {
          let isDir = e.isDirectory();
          if (!isDir && e.isSymbolicLink()) {
            // resolve symlinks that point at a directory
            isDir = (await safeStatIsDir(join(path, e.name)));
          }
          return isDir ? { name: e.name, path: join(path, e.name) } : null;
        }),
      );
      entries = dirs
        .filter((d): d is { name: string; path: string } => !!d)
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // unreadable dir → empty listing (still allow going up via parent)
    }
    return { path, parent, home, entries };
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

  /** Absolute paths of every session jsonl under every (non-hidden) project dir. */
  private async allSessionFiles(includeHidden = false): Promise<string[]> {
    const dirs = await safeListDirs(this.projectsRoot);
    const out: string[] = [];
    for (const d of dirs) {
      if (!includeHidden && this.hiddenDirs.has(d)) continue; // monitor skips hidden projects
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
    /** Byte cursor at end-of-file, for subsequent incremental `tail()` reads. */
    cursor: number;
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
    return { session, messages: all.slice(start, end), total, offset: start, cursor: await consumedOffset(file) };
  }

  /**
   * Incremental tail read for the web client's HTTP-cursor sync (WS-as-hint model):
   * given a byte cursor, return only the messages appended since, plus the new cursor
   * and fresh session meta. O(new bytes), not O(file). Handles partial trailing lines
   * and file truncation the same way the live file watcher does.
   */
  async tail(
    id: string,
    fromByte: number,
  ): Promise<{ session: ClaudeSession; messages: ClaudeMessage[]; cursor: number } | null> {
    if (!SAFE_ID.test(id)) return null;
    const file = this.sessionFile(id);
    if (!existsSync(file)) return null;
    const size = (await safeSize(file)) ?? 0;
    let from = fromByte >= 0 ? fromByte : 0;
    if (size < from) from = 0; // file truncated/rewritten → re-read from the top
    const messages: ClaudeMessage[] = [];
    let cursor = from;
    if (size > from) {
      const chunk = await readRange(file, from, size);
      const lastNl = chunk.lastIndexOf("\n");
      const consumable = lastNl >= 0 ? chunk.slice(0, lastNl) : "";
      cursor = lastNl >= 0 ? from + Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8") : from;
      for (const line of consumable.split("\n")) {
        const parsed = parseLine(line);
        if (parsed?.message) messages.push(parsed.message);
      }
    }
    const session = await this.readSessionMeta(file);
    if (!session) return null;
    return { session, messages, cursor };
  }

  /** Lightweight meta read (no message retention). */
  private async readSessionMeta(file: string): Promise<ClaudeSession | null> {
    const mtimeMs = await safeMtimeMs(file);
    // Reuse the folded accumulator if the file hasn't changed since we last parsed it.
    // foldFile (read + parse the whole JSONL) is the expensive part; buildSession below
    // is cheap and still runs every call so isLive/driving/attention stay fresh.
    const cached = this.metaCache.get(file);
    let acc: SessionAccumulator;
    if (cached && mtimeMs != null && cached.mtimeMs === mtimeMs) {
      acc = cached.acc;
    } else {
      acc = await this.foldFile(file, false);
      if (mtimeMs != null) {
        this.metaCache.set(file, { mtimeMs, acc });
        if (this.metaCache.size > 1000) {
          const oldest = this.metaCache.keys().next().value;
          if (oldest !== undefined) this.metaCache.delete(oldest);
        }
      }
    }
    return this.buildSession(basename(file, ".jsonl"), file, acc, mtimeMs);
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
      aiTitle: acc.aiTitle, // Claude Code's native maintained session title (free, persisted)
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
    // seed offsets to current file sizes so we only stream *new* lines (all dirs,
    // incl. hidden — so unhiding later doesn't replay old lines)
    for (const p of await this.allSessionFiles(true)) {
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

async function safeStatIsDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
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

/** Byte offset just past the last complete line — the resume cursor for incremental tail reads. */
async function consumedOffset(file: string): Promise<number> {
  const size = (await safeSize(file)) ?? 0;
  if (size === 0) return 0;
  const chunk = await readRange(file, 0, size);
  const lastNl = chunk.lastIndexOf("\n");
  return lastNl >= 0 ? Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8") : 0;
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
