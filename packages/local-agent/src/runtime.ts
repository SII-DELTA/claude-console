import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AuthManager } from "./auth-manager.js";
import { Bus } from "./bus.js";
import { FileChangeTracker } from "./file-change-tracker.js";
import { HistoryStore } from "./history-store.js";
import { SessionManager } from "./session-manager.js";
import { WorkspaceReader } from "./workspace-reader.js";
import { WsBridge } from "./ws-bridge.js";
import { buildHttpApp } from "./http-server.js";
import { ClaudeStore } from "./claude-store.js";
import { ClaudeDriver } from "./claude-driver.js";
import { SessionLiveness } from "./session-liveness.js";
import { installLivenessHooks } from "./hooks-installer.js";
import { PushManager } from "./push-manager.js";
import type { AgentSession } from "@mac/shared";
import type { PtyFactory } from "./pty.js";

export interface AgentRuntimeConfig {
  port?: number;
  host?: string;
  workspaceRoot: string;
  workspaceName?: string;
  storagePath: string;
  defaultCommands?: Partial<Record<AgentSession["type"], string>>;
  allowedOrigins?: string[];
  serverVersion?: string;
  ptyFactory?: PtyFactory;
  enableFileWatcher?: boolean;
  whisperApiKey?: string;
  /** Password login. Defaults to MAC_AGENT_PASSWORD. Unset → open access (no login). */
  password?: string;
  /** Install lifecycle hooks + watch session-state for run status. Default true; tests pass false. */
  enableSessionLiveness?: boolean;
}

export interface AgentRuntimeHandle {
  port: number;
  host: string;
  pairCode: string;
  url: string;
  wsUrl: string;
  workspaceId: string;
  bus: Bus;
  auth: AuthManager;
  sessions: SessionManager;
  store: HistoryStore;
  workspace: WorkspaceReader;
  claude: ClaudeStore;
  driver: ClaudeDriver;
  stop(): Promise<void>;
  issuePairCode(): string;
}

const DEFAULT_COMMANDS: Record<AgentSession["type"], string> = {
  claude: "claude",
  shell: process.platform === "win32" ? "cmd.exe" : "/bin/zsh -i",
  custom: "",
};

export async function startAgent(config: AgentRuntimeConfig): Promise<AgentRuntimeHandle> {
  const port = config.port ?? 7345;
  // Default bind: loopback only. Set MAC_AGENT_BIND to a Tailscale IP (or 0.0.0.0)
  // to expose the agent. Keeps the agent off the public/LAN interface by default.
  const host = config.host ?? process.env.MAC_AGENT_BIND ?? "127.0.0.1";
  const allowedOrigins = config.allowedOrigins ?? ["*"];
  const dbPath =
    config.storagePath === ":memory:" ? ":memory:" : join(config.storagePath, "history.sqlite");

  const store = new HistoryStore(dbPath);
  const bus = new Bus();
  const workspaceReader = new WorkspaceReader(config.workspaceRoot, config.workspaceName);
  const claude = new ClaudeStore(workspaceReader.current().rootPath, workspaceReader.current().id, bus);
  const driver = new ClaudeDriver({
    // new sessions land in the active project's cwd (follows project switching)
    workspaceRoot: () => claude.activeCwd(),
    store: claude,
    bus,
    // durable pending-permission store so a picker survives reload / restart
    pendingStore: store,
  });
  // let session metadata report which live sessions our own driver owns
  claude.setDrivenPredicate((id) => driver.owns(id));
  // authoritative "running" signal: a turn is in flight for this session, even if the
  // jsonl hasn't been flushed recently (long silent tool/bash). Keeps such sessions
  // showing as live instead of falsely flipping to "stopped" via mtime alone.
  claude.setDrivingPredicate((id) => driver.isDriving(id));
  // hook-derived liveness covers terminal/VSCode/our-own sessions uniformly (event
  // driven, no mtime polling). Union'd with the driver signal in buildSession.
  const liveness = new SessionLiveness(bus);
  const livenessEnabled = config.enableSessionLiveness !== false;
  if (livenessEnabled) {
    liveness.start();
    claude.setLivenessPredicates(
      (id) => liveness.isBusy(id),
      (id) => liveness.isAlive(id),
    );
    // install the lifecycle hooks into the user-level settings (idempotent, best-effort)
    void installLivenessHooks().then(
      (r) => {
        if (r.installed) {
          console.log(`[agent] 已安装会话运行态 hooks → ${r.settingsPath}（已在运行的会话需重启才纳管）`);
        } else if (r.reason && r.reason !== "already installed") {
          console.warn(`[agent] 会话运行态 hooks 未安装：${r.reason}`);
        }
      },
      (e) => console.warn(`[agent] 安装会话运行态 hooks 失败：${e instanceof Error ? e.message : e}`),
    );
  }
  // restore dismissed questions so they stay cleared across restarts
  claude.setDismissedQuestions(store.listDismissedQuestionIds());
  const password = config.password ?? process.env.MAC_AGENT_PASSWORD;
  const auth = new AuthManager(store, bus, { password });
  const sessions = new SessionManager(store, bus, {
    workspaceId: workspaceReader.current().id,
    workspaceRoot: workspaceReader.current().rootPath,
    defaultCommands: { ...DEFAULT_COMMANDS, ...(config.defaultCommands ?? {}) },
    ptyFactory: config.ptyFactory,
  });

  let tracker: FileChangeTracker | null = null;
  if (config.enableFileWatcher !== false) {
    tracker = new FileChangeTracker(store, bus, sessions, {
      workspaceRoot: workspaceReader.current().rootPath,
    });
    await tracker.start();
  }

  await claude.start();

  // No password configured → open access (clients connect directly, no login).
  // Set MAC_AGENT_PASSWORD to enforce password login (required before exposing
  // beyond loopback, e.g. over Tailscale).
  const noAuth = !password;

  // Web Push: agent pushes "needs answer / done / error" to subscribed browsers so
  // notifications arrive even when the PWA is backgrounded/closed. Title cache is fed
  // by session updates so we don't re-parse a transcript on every turn event.
  const push = new PushManager(store, { storagePath: config.storagePath });
  const titleOf = new Map<string, string>();
  bus.on("claude:session_updated", (s) => titleOf.set(s.id, s.title));
  const pushNotify = (sessionId: string, kind: "question" | "error" | "done", body: string) =>
    void push.notify({ sessionId, title: titleOf.get(sessionId) ?? "Claude 会话", body, kind });
  bus.on("claude:permission_request", (sessionId) => pushNotify(sessionId, "question", "需要你回答"));
  bus.on("claude:drive_done", (sessionId) => pushNotify(sessionId, "done", "已完成一轮"));
  bus.on("claude:drive_error", (sessionId, message) => {
    if (sessionId) pushNotify(sessionId, "error", `执行出错：${(message ?? "").slice(0, 80)}`);
  });

  const app = await buildHttpApp({
    auth,
    sessions,
    store,
    workspaceReader,
    claude,
    driver,
    push,
    serverVersion: config.serverVersion ?? "0.1.0",
    allowedOrigins,
    whisperApiKey: config.whisperApiKey,
    noAuth,
    switchWorkspace(input) {
      const next = workspaceReader.switchTo(input);
      if (!next) return false;
      claude.setWorkspace(next.rootPath, next.id);
      sessions.setWorkspace(next.id, next.rootPath);
      return true;
    },
  });

  await app.listen({ port, host });
  const addr = app.server.address() as AddressInfo;
  const realPort = typeof addr === "object" && addr ? addr.port : port;

  const ws = new WsBridge({
    noAuth,
    bus,
    auth,
    sessions,
    workspaceReader,
    serverVersion: config.serverVersion ?? "0.1.0",
  });
  ws.attach(app.server);

  const pairCode = auth.issuePairCode();
  const wsHost = host === "0.0.0.0" ? "127.0.0.1" : host;

  return {
    port: realPort,
    host,
    pairCode,
    url: `http://${wsHost}:${realPort}`,
    wsUrl: `ws://${wsHost}:${realPort}/ws`,
    workspaceId: workspaceReader.current().id,
    bus,
    auth,
    sessions,
    store,
    workspace: workspaceReader,
    claude,
    driver,
    issuePairCode: () => auth.issuePairCode(),
    async stop() {
      sessions.destroyAll();
      driver.destroyAll();
      liveness.stop();
      await claude.stop();
      await ws.close();
      await tracker?.stop();
      await app.close();
      store.close();
    },
  };
}
