import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAgent, type AgentRuntimeHandle } from "../runtime.js";
import { createMockPtyFactory } from "./mock-pty.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let handle: AgentRuntimeHandle;
let storage: string;
let mock: ReturnType<typeof createMockPtyFactory>;

beforeEach(async () => {
  storage = mkdtempSync(join(tmpdir(), "mac-agent-"));
  mock = createMockPtyFactory();
  handle = await startAgent({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: storage,
    storagePath: storage,
    enableFileWatcher: false,
    ptyFactory: mock.factory,
    allowedOrigins: ["*"],
    password: "test-pw", // enforce auth so the 401/bearer checks apply
  });
});

afterEach(async () => {
  await handle.stop();
  rmSync(storage, { recursive: true, force: true });
});

async function pair(): Promise<{ token: string; baseUrl: string }> {
  const code = handle.pairCode;
  const baseUrl = `http://127.0.0.1:${handle.port}`;
  const res = await fetch(`${baseUrl}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode: code, deviceName: "test", platform: "web" }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { token: string };
  return { token: data.token, baseUrl };
}

describe("HTTP server", () => {
  it("GET /health returns ok without auth", async () => {
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns 401 without bearer", async () => {
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(401);
  });

  it("pair → list sessions empty", async () => {
    const { token, baseUrl } = await pair();
    const res = await fetch(`${baseUrl}/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });

  it("pair → create + input + interrupt + logs + delete", async () => {
    const { token, baseUrl } = await pair();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const created = (await (
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "shell" }),
      })
    ).json()) as { session: { id: string } };
    const sid = created.session.id;

    mock.last().emit("hello\n");
    await new Promise((r) => setTimeout(r, 20));

    const inputRes = await fetch(`${baseUrl}/sessions/${sid}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify({ data: "ls", appendNewline: true }),
    });
    expect(inputRes.status).toBe(200);
    expect(mock.last().written.join("")).toContain("ls\n");

    const intr = await fetch(`${baseUrl}/sessions/${sid}/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(intr.status).toBe(200);

    const logsRes = await fetch(`${baseUrl}/sessions/${sid}/logs`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const logsJson = (await logsRes.json()) as { logs: unknown[] };
    expect(logsJson.logs.length).toBeGreaterThan(0);

    const del = await fetch(`${baseUrl}/sessions/${sid}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(200);
  });

  it("rejects bad pair code", async () => {
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const res = await fetch(`${baseUrl}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairCode: "00000000", deviceName: "x", platform: "web" }),
    });
    expect([401, 429]).toContain(res.status);
  });
});
