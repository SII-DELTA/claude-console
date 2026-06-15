import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgent, type AgentRuntimeHandle } from "../runtime.js";
import { createMockPtyFactory } from "./mock-pty.js";
import type { ServerMessage } from "@mac/shared";

let handle: AgentRuntimeHandle;
let storage: string;
let mock: ReturnType<typeof createMockPtyFactory>;

beforeEach(async () => {
  storage = mkdtempSync(join(tmpdir(), "mac-agent-ws-"));
  mock = createMockPtyFactory();
  handle = await startAgent({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: storage,
    storagePath: storage,
    enableFileWatcher: false,
    ptyFactory: mock.factory,
  });
});

afterEach(async () => {
  await handle.stop();
  rmSync(storage, { recursive: true, force: true });
});

async function pair(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${handle.port}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode: handle.pairCode, deviceName: "ws", platform: "web" }),
  });
  const data = (await res.json()) as { token: string };
  return data.token;
}

function collect(ws: WebSocket, n: number, timeoutMs = 2000): Promise<ServerMessage[]> {
  const out: ServerMessage[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws collect timeout")), timeoutMs);
    ws.on("message", (raw) => {
      out.push(JSON.parse(raw.toString()) as ServerMessage);
      if (out.length >= n) {
        clearTimeout(timer);
        resolve(out);
      }
    });
  });
}

describe("WsBridge", () => {
  it("rejects bad token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=bad`);
    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.on("error", () => resolve());
    });
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("accepts valid token, sends hello, broadcasts logs", async () => {
    const token = await pair();
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=${token}`);
    const received: ServerMessage[] = [];
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString()) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    handle.sessions.create({ type: "shell" });
    mock.last().emit("hello world\n");
    await new Promise((r) => setTimeout(r, 100));
    const types = received.map((m) => m.type);
    expect(types).toContain("server:hello");
    expect(types).toContain("server:session_created");
    ws.close();
  });

  it("client:input is forwarded to pty", async () => {
    const token = await pair();
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    const s = handle.sessions.create({ type: "shell" });
    ws.send(JSON.stringify({ type: "client:input", sessionId: s.id, data: "ls", appendNewline: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.last().written.join("")).toContain("ls\n");
    ws.close();
  });

  it("ping → pong", async () => {
    const token = await pair();
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=${token}`);
    await new Promise<void>((res, rej) => {
      ws.on("open", () => res());
      ws.on("error", rej);
    });
    const out: ServerMessage[] = [];
    ws.on("message", (raw) => out.push(JSON.parse(raw.toString())));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "client:ping", ts: 1 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(out.some((m) => m.type === "server:pong")).toBe(true);
    ws.close();
  });
});
