import type { ServerMessage } from "@mac/shared";

export interface WsClientOptions {
  url: string;
  token: string;
  onMessage: (msg: ServerMessage) => void;
  onClose?: () => void;
  onOpen?: () => void;
  onError?: (err: Event) => void;
}

/** App-level heartbeat: how often we ping the server. A dead socket is detected
 * within ~2× this (no pong by the next tick → terminate → reconnect). Kept well below
 * the server's own 30s ping so the client always notices a silent drop first and
 * reconnects, rather than being terminated server-side and going unaware. */
const PING_INTERVAL_MS = 12_000;

export class WsClient {
  private socket: WebSocket | null = null;
  /** Messages queued while the socket is still connecting. */
  private readonly pending: string[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** True once a ping is sent and still awaiting its pong (cleared on pong). */
  private awaitingPong = false;

  constructor(private readonly opts: WsClientOptions) {}

  open(): void {
    const url = new URL(this.opts.url);
    url.searchParams.set("token", this.opts.token);
    const ws = new WebSocket(url.toString());
    this.socket = ws;

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as ServerMessage;
        // Heartbeat reply: consume locally, don't surface to the app.
        if (msg.type === "server:pong") {
          this.awaitingPong = false;
          return;
        }
        this.opts.onMessage(msg);
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.addEventListener("open", () => {
      // Flush any messages that were sent before the connection was ready.
      for (const payload of this.pending) {
        ws.send(payload);
      }
      this.pending.length = 0;
      this.startHeartbeat();
      this.opts.onOpen?.();
    });

    ws.addEventListener("close", () => {
      this.stopHeartbeat();
      this.opts.onClose?.();
    });

    ws.addEventListener("error", (ev) => {
      console.error("[WsClient] socket error", ev);
      this.opts.onError?.(ev);
    });
  }

  /** Socket is open and usable right now. */
  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Proactively probe the link (e.g. on foreground resume): send a ping now and arm the
   * pong watch. A zombie socket (server already terminated us while backgrounded, but the
   * client froze before `close` fired) won't pong → the next heartbeat tick closes it and
   * triggers a reconnect, instead of waiting up to a full ping interval to notice. */
  ping(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.awaitingPong = true;
    try {
      this.socket.send(JSON.stringify({ type: "client:ping", ts: Date.now() }));
    } catch {
      /* noop */
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      // Previous ping never got a pong → the link is silently dead. Closing it
      // triggers onClose, which schedules the reconnect.
      if (this.awaitingPong) {
        this.stopHeartbeat();
        try {
          this.socket.close();
        } catch {
          /* noop */
        }
        return;
      }
      this.awaitingPong = true;
      this.socket.send(JSON.stringify({ type: "client:ping", ts: Date.now() }));
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.awaitingPong = false;
  }

  send(message: object): void {
    const payload = JSON.stringify(message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(payload);
    } else {
      // Socket is still connecting (or not yet opened) — queue for flush.
      this.pending.push(payload);
    }
  }

  close(): void {
    this.stopHeartbeat();
    this.pending.length = 0;
    this.socket?.close();
    this.socket = null;
  }
}
