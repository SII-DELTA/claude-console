import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { ClientMessageSchema, HEARTBEAT_INTERVAL_MS, PROTOCOL_VERSION } from "@mac/shared";
import type { ServerMessage } from "@mac/shared";
import type { AuthManager } from "./auth-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { Bus } from "./bus.js";
import type { WorkspaceReader } from "./workspace-reader.js";
import { rateLimited } from "./rate-limit.js";

export interface WsServerOptions {
  bus: Bus;
  auth: AuthManager;
  sessions: SessionManager;
  workspaceReader: WorkspaceReader;
  serverVersion: string;
  path?: string;
  /** Skip token auth on the WS upgrade (local convenience). Default false. */
  noAuth?: boolean;
}

interface Client {
  ws: WebSocket;
  deviceId: string;
  alive: boolean;
}

export class WsBridge {
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private clients = new Set<Client>();
  private offBus: Array<() => void> = [];

  constructor(private readonly opts: WsServerOptions) {}

  attach(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    const path = this.opts.path ?? "/ws";

    server.on("upgrade", (req, socket, head) => {
      try {
        const url = new URL(req.url ?? "", "http://localhost");
        if (url.pathname !== path) {
          socket.destroy();
          return;
        }
        let deviceId = "web-client";
        if (!this.opts.noAuth) {
          const token = url.searchParams.get("token");
          const device = this.opts.auth.verifyToken(token);
          if (!device) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          deviceId = device.id;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.bind(ws, deviceId, req);
        });
      } catch {
        socket.destroy();
      }
    });

    this.subscribeBus();
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS);
  }

  private bind(ws: WebSocket, deviceId: string, _req: IncomingMessage): void {
    const client: Client = { ws, deviceId, alive: true };
    this.clients.add(client);

    const ws0 = this.opts.workspaceReader.current();
    this.send(ws, {
      type: "server:hello",
      serverVersion: this.opts.serverVersion,
      workspaceId: ws0.id,
      workspaceName: ws0.name,
      protocolVersion: PROTOCOL_VERSION,
    });

    ws.on("pong", () => (client.alive = true));
    ws.on("close", () => this.clients.delete(client));
    ws.on("error", () => this.clients.delete(client));
    ws.on("message", (data) => this.onMessage(client, data.toString()));
  }

  private onMessage(client: Client, raw: string): void {
    let parsed;
    try {
      parsed = ClientMessageSchema.safeParse(JSON.parse(raw));
    } catch {
      return this.send(client.ws, { type: "server:error", message: "invalid_json" });
    }
    if (!parsed.success) {
      return this.send(client.ws, { type: "server:error", message: "invalid_message" });
    }
    const msg = parsed.data;
    switch (msg.type) {
      case "client:ping":
        this.send(client.ws, { type: "server:pong", ts: msg.ts });
        return;
      case "client:hello":
        return; // already authed during upgrade
      case "client:input":
        this.opts.sessions.writeInput(msg.sessionId, msg.data, msg.appendNewline ?? true);
        return;
      case "client:interrupt":
        this.opts.sessions.interrupt(msg.sessionId);
        return;
      case "client:create_session": {
        // Cap inbound session spawns per device so a runaway client can't fork-bomb ptys.
        if (rateLimited(`ws_create:${client.deviceId}`, 20, 60_000)) {
          this.send(client.ws, { type: "server:error", message: "rate_limited" });
          return;
        }
        const s = this.opts.sessions.create(msg.payload);
        this.send(client.ws, { type: "server:session_created", session: s });
        return;
      }
      case "client:delete_session":
        this.opts.sessions.delete(msg.sessionId);
        return;
      case "client:subscribe":
        // v1: every authed client receives all events; future: filter by sessionId.
        return;
    }
  }

  private subscribeBus(): void {
    const { bus } = this.opts;
    this.offBus.push(
      bus.on("session:created", (s) => this.broadcast({ type: "server:session_created", session: s })),
      bus.on("session:updated", (s) => this.broadcast({ type: "server:session_updated", session: s })),
      bus.on("session:deleted", (id) => this.broadcast({ type: "server:session_deleted", sessionId: id })),
      bus.on("session:log", (log) => this.broadcast({ type: "server:log", log })),
      bus.on("session:file_changed", (c) => this.broadcast({ type: "server:file_changed", change: c })),
      bus.on("session:command_started", (sessionId, command) =>
        this.broadcast({ type: "server:command_started", sessionId, command }),
      ),
      bus.on("session:command_finished", (sessionId, exitCode) =>
        this.broadcast({ type: "server:command_finished", sessionId, exitCode }),
      ),
      bus.on("claude:session_updated", (session) =>
        this.broadcast({ type: "server:claude_session_updated", session }),
      ),
      bus.on("claude:message", (sessionId, message) =>
        this.broadcast({ type: "server:claude_message", sessionId, message }),
      ),
      bus.on("claude:delta", (event) =>
        this.broadcast({
          type: "server:claude_delta",
          sessionId: event.sessionId,
          delta: event.delta,
          blockKind: event.blockKind,
          status: event.status,
          timestamp: event.timestamp,
        }),
      ),
      bus.on("claude:drive_done", (sessionId, timestamp, usage) =>
        this.broadcast({ type: "server:claude_drive_done", sessionId, timestamp, usage }),
      ),
      bus.on("claude:drive_error", (sessionId, message, timestamp) =>
        this.broadcast({ type: "server:claude_drive_error", sessionId, message, timestamp }),
      ),
      bus.on("claude:driving", (sessionId, driving) =>
        this.broadcast({ type: "server:claude_driving", sessionId, driving }),
      ),
      bus.on("claude:rate_limit", (info) =>
        this.broadcast({ type: "server:claude_rate_limit", ...info }),
      ),
      bus.on("claude:permission_request", (sessionId, requestId, toolName, questions) =>
        this.broadcast({
          type: "server:claude_permission_request",
          sessionId,
          requestId,
          toolName,
          questions,
        }),
      ),
      bus.on("claude:tool_approval_request", (sessionId, requestId, toolName, summary) =>
        this.broadcast({
          type: "server:claude_tool_approval_request",
          sessionId,
          requestId,
          toolName,
          summary,
        }),
      ),
      bus.on("claude:permission_cancel", (sessionId, requestId) =>
        this.broadcast({ type: "server:claude_permission_cancel", sessionId, requestId }),
      ),
    );
  }

  private tick(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        try {
          c.ws.terminate();
        } catch {
          /* noop */
        }
        this.clients.delete(c);
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* noop */
      }
    }
  }

  // A client whose socket buffer is this far behind is treated as a slow/zombie consumer.
  // WS is only a hint (clients resync authoritatively via the HTTP byte-cursor tail), so we
  // can safely drop frames for a lagging client instead of letting its buffer grow unbounded.
  private static readonly WS_SOFT_BUFFER = 1 << 20; // 1MB: skip this frame, client polls to catch up
  private static readonly WS_HARD_BUFFER = 8 << 20; // 8MB: hopelessly behind → terminate the zombie

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      const buffered = c.ws.bufferedAmount;
      if (buffered > WsBridge.WS_HARD_BUFFER) {
        try {
          c.ws.terminate();
        } catch {
          /* noop */
        }
        this.clients.delete(c);
        continue;
      }
      if (buffered > WsBridge.WS_SOFT_BUFFER) continue; // slow client: drop this frame, it'll resync
      try {
        c.ws.send(data);
      } catch {
        /* noop */
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const off of this.offBus) off();
    this.offBus = [];
    for (const c of this.clients) {
      try {
        c.ws.close();
      } catch {
        /* noop */
      }
    }
    this.clients.clear();
    if (this.wss) {
      await new Promise<void>((res) => this.wss!.close(() => res()));
      this.wss = null;
    }
  }
}
