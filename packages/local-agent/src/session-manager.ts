import { ulid } from "ulid";
import { nanoid } from "nanoid";
import type { AgentLog, AgentSession, CreateSessionInput } from "@mac/shared";
import { MAX_LOG_BUFFER_PER_SESSION } from "@mac/shared";
import type { Bus } from "./bus.js";
import type { HistoryStore } from "./history-store.js";
import { LineBuffer } from "./util/log-parser.js";
import { redactSecrets } from "./util/crypto.js";
import { defaultPtyFactory, type IPty, type PtyFactory } from "./pty.js";

export interface SessionManagerOptions {
  workspaceId: string;
  workspaceRoot: string;
  defaultCommands: Record<AgentSession["type"], string>;
  ptyFactory?: PtyFactory;
  maxLogBuffer?: number;
}

interface RuntimeRecord {
  session: AgentSession;
  pty: IPty;
  buffer: LineBuffer;
}

export class SessionManager {
  private readonly runtime = new Map<string, RuntimeRecord>();
  private readonly ptyFactory: PtyFactory;
  private readonly maxLogBuffer: number;

  constructor(
    private readonly store: HistoryStore,
    private readonly bus: Bus,
    private readonly opts: SessionManagerOptions,
  ) {
    this.ptyFactory = opts.ptyFactory ?? defaultPtyFactory;
    this.maxLogBuffer = opts.maxLogBuffer ?? MAX_LOG_BUFFER_PER_SESSION;
  }

  list(): AgentSession[] {
    return this.store.listSessions();
  }

  setWorkspace(workspaceId: string, workspaceRoot: string): void {
    this.opts.workspaceId = workspaceId;
    this.opts.workspaceRoot = workspaceRoot;
  }

  get(id: string): AgentSession | null {
    return this.store.getSession(id);
  }

  create(input: CreateSessionInput): AgentSession {
    const now = new Date().toISOString();
    const command = input.command?.trim() || this.opts.defaultCommands[input.type] || "/bin/sh";
    const session: AgentSession = {
      id: `s_${nanoid(10)}`,
      workspaceId: this.opts.workspaceId,
      title: input.title?.trim() || defaultTitle(input.type),
      type: input.type,
      command,
      cwd: input.cwd?.trim() || this.opts.workspaceRoot,
      env: input.env,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveSession(session);
    this.bus.emit("session:created", session);
    this.spawn(session);
    return session;
  }

  private spawn(session: AgentSession): void {
    const pty = this.ptyFactory({
      command: session.command,
      cwd: session.cwd,
      env: session.env,
    });
    const buffer = new LineBuffer();
    this.runtime.set(session.id, { session, pty, buffer });

    this.updateStatus(session.id, "running");
    this.bus.emit("session:command_started", session.id, session.command);

    pty.onData((data) => {
      const lines = buffer.push(data);
      for (const line of lines) {
        this.appendLog(session.id, line.level, line.content, line.raw);
      }
    });

    pty.onExit(({ exitCode }) => {
      const tail = buffer.flush();
      for (const line of tail) {
        this.appendLog(session.id, line.level, line.content, line.raw);
      }
      const status: AgentSession["status"] = exitCode === 0 ? "completed" : "error";
      this.updateSessionPartial(session.id, { status, exitCode });
      this.bus.emit("session:command_finished", session.id, exitCode);
      this.runtime.delete(session.id);
    });
  }

  writeInput(id: string, data: string, appendNewline = false): boolean {
    const rec = this.runtime.get(id);
    if (!rec) return false;
    const payload = appendNewline && !data.endsWith("\n") ? `${data}\n` : data;
    rec.pty.write(payload);
    this.updateSessionPartial(id, {
      lastMessage: data.slice(0, 200),
      status: "running",
    });
    return true;
  }

  interrupt(id: string): boolean {
    const rec = this.runtime.get(id);
    if (!rec) return false;
    rec.pty.kill("SIGINT");
    this.updateStatus(id, "waiting");
    return true;
  }

  restart(id: string): AgentSession | null {
    const existing = this.store.getSession(id);
    if (!existing) return null;
    const rec = this.runtime.get(id);
    if (rec) rec.pty.kill("SIGTERM");
    this.runtime.delete(id);
    const refreshed: AgentSession = {
      ...existing,
      status: "idle",
      exitCode: null,
      updatedAt: new Date().toISOString(),
    };
    this.store.saveSession(refreshed);
    this.bus.emit("session:updated", refreshed);
    this.spawn(refreshed);
    return refreshed;
  }

  delete(id: string): boolean {
    const rec = this.runtime.get(id);
    if (rec) {
      try {
        rec.pty.kill("SIGTERM");
      } catch {
        /* noop */
      }
      this.runtime.delete(id);
    }
    const existed = !!this.store.getSession(id);
    if (existed) {
      this.store.deleteSession(id);
      this.bus.emit("session:deleted", id);
    }
    return existed;
  }

  private appendLog(
    sessionId: string,
    level: AgentLog["level"],
    content: string,
    raw: string,
  ): void {
    const log: AgentLog = {
      id: ulid(),
      sessionId,
      timestamp: new Date().toISOString(),
      level,
      content: redactSecrets(content),
      raw: redactSecrets(raw),
    };
    this.store.appendLog(log);
    this.store.trimLogs(sessionId, this.maxLogBuffer);
    this.bus.emit("session:log", log);
    this.updateSessionPartial(sessionId, { lastMessage: log.content.slice(0, 200) });
  }

  private updateStatus(id: string, status: AgentSession["status"]): void {
    this.updateSessionPartial(id, { status });
  }

  private updateSessionPartial(id: string, patch: Partial<AgentSession>): void {
    const current = this.store.getSession(id);
    if (!current) return;
    const updated: AgentSession = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.store.saveSession(updated);
    this.bus.emit("session:updated", updated);
  }

  /** Cleanup hook for shutdown. */
  destroyAll(): void {
    for (const rec of this.runtime.values()) {
      try {
        rec.pty.kill("SIGTERM");
      } catch {
        /* noop */
      }
    }
    this.runtime.clear();
  }
}

function defaultTitle(type: AgentSession["type"]): string {
  switch (type) {
    case "claude":
      return "Claude Session";
    case "shell":
      return "Shell Session";
    case "custom":
      return "Custom Session";
  }
}
