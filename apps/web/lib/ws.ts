import type { ServerMessage } from "@mac/shared";

export interface WsClientOptions {
  url: string;
  token: string;
  onMessage: (msg: ServerMessage) => void;
  onClose?: () => void;
  onOpen?: () => void;
  onError?: (err: Event) => void;
}

export class WsClient {
  private socket: WebSocket | null = null;
  /** Messages queued while the socket is still connecting. */
  private readonly pending: string[] = [];

  constructor(private readonly opts: WsClientOptions) {}

  open(): void {
    const url = new URL(this.opts.url);
    url.searchParams.set("token", this.opts.token);
    const ws = new WebSocket(url.toString());
    this.socket = ws;

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as ServerMessage;
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
      this.opts.onOpen?.();
    });

    ws.addEventListener("close", () => this.opts.onClose?.());

    ws.addEventListener("error", (ev) => {
      console.error("[WsClient] socket error", ev);
      this.opts.onError?.(ev);
    });
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
    this.pending.length = 0;
    this.socket?.close();
    this.socket = null;
  }
}
