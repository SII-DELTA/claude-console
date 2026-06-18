import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { Bus } from "./bus.js";

export type LivenessState = "idle" | "busy" | "ended" | "dead";

export interface SessionLiveInfo {
  sessionId: string;
  state: LivenessState;
  currentTool: string | null;
  pid: number | null;
  cwd: string | null;
  lastEventAt: string | null;
}

const REAP_INTERVAL_MS = 20_000;
/** A `busy` state with no active tool and no new hook event for this long is treated
 * as a missed-`Stop` residue and downgraded to idle. Generous so genuine long
 * tool runs (which keep `currentTool` set) and long generations are never misjudged. */
const BUSY_STALE_MS = 10 * 60_000;

/**
 * Tracks per-session run state written by the Claude lifecycle hooks
 * (`~/.claude/session-state/<sessionId>.json`). Event-driven (chokidar), with a
 * low-frequency reaper that uses the official PID registry (`~/.claude/sessions/*.json`)
 * + `kill -0` to clear crash residue where Stop/SessionEnd never fired.
 *
 * Emits `claude:driving(sessionId, busy)` on a busy↔idle transition so the ws layer
 * can push instant updates; the authoritative per-session `driving` field is the union
 * of this and the agent's own driver (see claude-store.buildSession).
 */
export class SessionLiveness {
  private readonly dir: string;
  private readonly registryDir: string;
  private readonly states = new Map<string, SessionLiveInfo>();
  private watcher: FSWatcher | null = null;
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bus?: Bus,
    opts?: { stateDir?: string; registryDir?: string },
  ) {
    this.dir = opts?.stateDir ?? join(homedir(), ".claude", "session-state");
    this.registryDir = opts?.registryDir ?? join(homedir(), ".claude", "sessions");
  }

  start(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      /* ignore */
    }
    this.loadAll();
    this.reap(); // clear crash residue from a previous run immediately, not after one interval
    this.watcher = chokidar.watch(this.dir, { ignoreInitial: true, depth: 0 });
    this.watcher.on("add", (f) => this.onWrite(f));
    this.watcher.on("change", (f) => this.onWrite(f));
    this.watcher.on("unlink", (f) => this.onUnlink(f));
    this.reaper = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref?.();
  }

  stop(): void {
    void this.watcher?.close();
    this.watcher = null;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
  }

  /** A turn is actively running for this session (hook-derived). */
  isBusy(sessionId: string): boolean {
    return this.states.get(sessionId)?.state === "busy";
  }

  /** Session has a tracked, non-terminated process (busy or idle). */
  isAlive(sessionId: string): boolean {
    const s = this.states.get(sessionId)?.state;
    return s === "busy" || s === "idle";
  }

  getState(sessionId: string): SessionLiveInfo | undefined {
    return this.states.get(sessionId);
  }

  /** Re-read all state files then run the reaper once (used by tests / on-demand). */
  refreshAndReap(): void {
    this.loadAll();
    this.reap();
  }

  private sidOf(file: string): string {
    return basename(file).replace(/\.json$/, "");
  }

  private loadAll(): void {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (f.endsWith(".json")) this.read(join(this.dir, f));
    }
  }

  /** Read one state file into the map (no emit). Returns the busy flag, or null if unreadable. */
  private read(file: string): boolean | null {
    try {
      const info = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionLiveInfo>;
      const sessionId = info.sessionId ?? this.sidOf(file);
      const rec: SessionLiveInfo = {
        sessionId,
        state: (info.state as LivenessState) ?? "idle",
        currentTool: info.currentTool ?? null,
        pid: info.pid ?? null,
        cwd: info.cwd ?? null,
        lastEventAt: info.lastEventAt ?? null,
      };
      this.states.set(sessionId, rec);
      return rec.state === "busy";
    } catch {
      return null;
    }
  }

  private onWrite(file: string): void {
    const sid = this.sidOf(file);
    const before = this.isBusy(sid);
    const busy = this.read(file);
    if (busy == null) return;
    if (busy !== before) this.bus?.emit("claude:driving", sid, busy);
  }

  private onUnlink(file: string): void {
    const sid = this.sidOf(file);
    const wasBusy = this.isBusy(sid);
    this.states.delete(sid);
    if (wasBusy) this.bus?.emit("claude:driving", sid, false);
  }

  /** Clear crash residue: a state file whose owning process is gone but Stop/End never fired. */
  private reap(): void {
    // Which sessionIds still have a live PID per the official registry?
    const liveSids = new Set<string>();
    try {
      if (existsSync(this.registryDir)) {
        for (const f of readdirSync(this.registryDir)) {
          if (!f.endsWith(".json")) continue;
          try {
            const reg = JSON.parse(readFileSync(join(this.registryDir, f), "utf8")) as {
              pid?: number;
              sessionId?: string;
            };
            if (reg.pid != null && reg.sessionId && this.pidAlive(reg.pid)) liveSids.add(reg.sessionId);
          } catch {
            /* skip bad file */
          }
        }
      }
    } catch {
      return; // registry unreadable → skip this round rather than wrongly reaping
    }
    const now = Date.now();
    for (const [sid, rec] of this.states) {
      if (rec.state === "ended" || rec.state === "dead") continue;
      // also accept our own recorded pid as alive (covers agent-spawned procs)
      const ownPidAlive = rec.pid != null && this.pidAlive(rec.pid);
      if (!liveSids.has(sid) && !ownPidAlive) {
        // owning process is gone but Stop/SessionEnd never fired → dead residue
        const wasBusy = rec.state === "busy";
        this.states.set(sid, { ...rec, state: "dead" });
        if (wasBusy) this.bus?.emit("claude:driving", sid, false);
        this.removeStateFile(sid); // don't let dead files accumulate on disk
        continue;
      }
      // 4b: process alive but stuck `busy` with no active tool and no new event for
      // a long time → a missed `Stop`. Downgrade to idle so it stops showing "running".
      if (
        rec.state === "busy" &&
        rec.currentTool == null &&
        rec.lastEventAt != null &&
        now - Date.parse(rec.lastEventAt) > BUSY_STALE_MS
      ) {
        this.states.set(sid, { ...rec, state: "idle" });
        this.bus?.emit("claude:driving", sid, false);
      }
    }
  }

  private removeStateFile(sid: string): void {
    try {
      unlinkSync(join(this.dir, `${sid}.json`));
    } catch {
      /* already gone */
    }
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
    }
  }
}
