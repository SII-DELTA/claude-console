import chokidar, { type FSWatcher } from "chokidar";
import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ulid } from "ulid";
import simpleGit, { type SimpleGit } from "simple-git";
import type { FileChange, FileChangeKind } from "@mac/shared";
import type { Bus } from "./bus.js";
import type { HistoryStore } from "./history-store.js";
import type { SessionManager } from "./session-manager.js";

const IGNORED = [
  /(^|[\\/])\../, // dot-files
  /node_modules/,
  /dist/,
  /build/,
  /out\b/,
  /\.next/,
  /\.turbo/,
  /coverage/,
  /\.dart_tool/,
];

const MAX_DIFF_SIZE = 256 * 1024;

export interface FileChangeTrackerOptions {
  workspaceRoot: string;
  /** Force a stable session id for tracker (used in tests). */
  fixedSessionId?: string;
}

export class FileChangeTracker {
  private watcher: FSWatcher | null = null;
  private readonly snapshots = new Map<string, string>();
  private git: SimpleGit | null = null;
  private gitAvailable = false;

  constructor(
    private readonly store: HistoryStore,
    private readonly bus: Bus,
    private readonly sessions: SessionManager,
    private readonly opts: FileChangeTrackerOptions,
  ) {}

  async start(): Promise<void> {
    const root = resolve(this.opts.workspaceRoot);
    try {
      const stat = await fs.stat(join(root, ".git"));
      this.gitAvailable = stat.isDirectory();
    } catch {
      this.gitAvailable = false;
    }
    if (this.gitAvailable) {
      this.git = simpleGit(root);
    }

    this.watcher = chokidar.watch(root, {
      ignored: IGNORED,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watcher.on("add", (p) => void this.onChange(p, "added"));
    this.watcher.on("change", (p) => void this.onChange(p, "modified"));
    this.watcher.on("unlink", (p) => void this.onChange(p, "deleted"));
    await new Promise<void>((resolve) => {
      this.watcher!.once("ready", () => resolve());
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }

  private currentSessionId(): string | null {
    if (this.opts.fixedSessionId) return this.opts.fixedSessionId;
    const list = this.sessions.list();
    return list[0]?.id ?? null;
  }

  private async onChange(absPath: string, kind: FileChangeKind): Promise<void> {
    const sessionId = this.currentSessionId();
    if (!sessionId) return;
    const rel = relative(resolve(this.opts.workspaceRoot), absPath);
    if (!rel || rel.startsWith("..")) return;

    let diff: string | undefined;
    let added = 0;
    let removed = 0;
    try {
      if (this.gitAvailable && this.git) {
        diff = await this.git.diff(["--", rel]).catch(() => "");
        if (!diff || diff.length === 0) {
          // Untracked or staged-only — still try to show file content as added.
          if (kind === "added") {
            const content = await fs.readFile(absPath, "utf-8").catch(() => "");
            if (content.length <= MAX_DIFF_SIZE) {
              const lines = content.split(/\r?\n/);
              added = lines.length;
              diff = lines.map((l) => `+${l}`).join("\n");
            }
          }
        } else {
          ({ added, removed } = countDiff(diff));
        }
      } else {
        const result = await this.computeMemoryDiff(absPath, kind);
        diff = result.diff;
        added = result.added;
        removed = result.removed;
      }
    } catch {
      diff = undefined;
    }

    const change: FileChange = {
      id: ulid(),
      sessionId,
      path: rel,
      kind,
      addedLines: added,
      removedLines: removed,
      timestamp: new Date().toISOString(),
      diff: diff && diff.length <= MAX_DIFF_SIZE ? diff : undefined,
    };
    this.store.appendFileChange(change);
    this.bus.emit("session:file_changed", change);
  }

  private async computeMemoryDiff(
    absPath: string,
    kind: FileChangeKind,
  ): Promise<{ diff: string; added: number; removed: number }> {
    const prev = this.snapshots.get(absPath) ?? "";
    let next = "";
    if (kind !== "deleted") {
      try {
        next = await fs.readFile(absPath, "utf-8");
      } catch {
        next = "";
      }
    }
    if (next.length > MAX_DIFF_SIZE || prev.length > MAX_DIFF_SIZE) {
      this.snapshots.set(absPath, next);
      return { diff: "", added: 0, removed: 0 };
    }
    const prevLines = prev.split(/\r?\n/);
    const nextLines = next.split(/\r?\n/);
    const diffLines: string[] = [];
    const max = Math.max(prevLines.length, nextLines.length);
    let added = 0;
    let removed = 0;
    for (let i = 0; i < max; i++) {
      const a = prevLines[i];
      const b = nextLines[i];
      if (a === b) {
        if (a !== undefined) diffLines.push(` ${a}`);
      } else {
        if (a !== undefined) {
          diffLines.push(`-${a}`);
          removed += 1;
        }
        if (b !== undefined) {
          diffLines.push(`+${b}`);
          added += 1;
        }
      }
    }
    if (kind === "deleted") this.snapshots.delete(absPath);
    else this.snapshots.set(absPath, next);
    return { diff: diffLines.join("\n"), added, removed };
  }
}

function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}
