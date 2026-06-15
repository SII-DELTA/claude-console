import * as nodePty from "node-pty";

export interface IPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals | number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (info: { exitCode: number | null; signal: number | null }) => void): void;
  readonly pid: number | undefined;
}

export interface PtySpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  shell?: string;
}

/**
 * Real PTY backed by node-pty.
 *
 * node-pty allocates a kernel PTY pair so child processes see
 * `stdin.isTTY === true`, which is required by codex, gh copilot, etc.
 */
class NodePty implements IPty {
  private readonly terminal: nodePty.IPty;
  private readonly dataCbs = new Set<(d: string) => void>();
  private readonly exitCbs = new Set<
    (info: { exitCode: number | null; signal: number | null }) => void
  >();

  constructor(opts: PtySpawnOptions) {
    let file: string;
    let args: string[];

    if (opts.args !== undefined) {
      file = opts.command;
      args = opts.args;
    } else {
      // Split "gh copilot suggest" → file="gh", args=["copilot", "suggest"]
      const parts = opts.command.split(/\s+/).filter(Boolean);
      file = parts[0] ?? opts.command;
      args = parts.slice(1);
    }

    this.terminal = nodePty.spawn(file, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 30,
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });

    this.terminal.onData((data) => {
      for (const cb of this.dataCbs) cb(data);
    });

    this.terminal.onExit(({ exitCode, signal }) => {
      for (const cb of this.exitCbs) {
        cb({ exitCode: exitCode ?? null, signal: signal ?? null });
      }
    });
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): void {
    try {
      const sig = typeof signal === "number" ? String(signal) : signal;
      this.terminal.kill(sig);
    } catch {
      /* noop */
    }
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.add(cb);
  }

  onExit(cb: (info: { exitCode: number | null; signal: number | null }) => void): void {
    this.exitCbs.add(cb);
  }

  get pid(): number | undefined {
    return this.terminal.pid;
  }
}

/**
 * Pluggable factory so tests can swap in a mock IPty.
 */
export type PtyFactory = (opts: PtySpawnOptions) => IPty;

export const defaultPtyFactory: PtyFactory = (opts) => new NodePty(opts);
