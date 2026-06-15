import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiClient, isLiveConflict } from "../lib/api";

describe("ApiClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends Bearer token on authenticated requests", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sessions: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = new ApiClient("http://x", "tok");
    await api.listSessions();
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = (fetchMock.mock.calls as unknown as unknown[][])[0]!;
    expect((call[1] as RequestInit | undefined)?.headers).toMatchObject({
      authorization: "Bearer tok",
    });
  });

  it("throws on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const api = new ApiClient("http://x", "tok");
    await expect(api.listSessions()).rejects.toThrow(/500/);
  });

  it("pair() does not require token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          token: "t",
          device: { id: "d", name: "n", platform: "web" },
          workspace: { id: "w", name: "w", rootPath: "/" },
          serverVersion: "0.1.0",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient("http://x");
    const res = await api.pair({ pairCode: "12345678", deviceName: "b", platform: "web" });
    expect(res.token).toBe("t");
    const call = (fetchMock.mock.calls as unknown as unknown[][])[0]!;
    expect((call[1] as RequestInit | undefined)?.headers).not.toHaveProperty("authorization");
  });

  it("newClaudeSession posts prompt to /claude/sessions", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sessionId: "abc" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient("http://x", "tok");
    const res = await api.newClaudeSession("do it");
    expect(res.sessionId).toBe("abc");
    const call = (fetchMock.mock.calls as unknown as unknown[][])[0]!;
    expect(call[0]).toBe("http://x/claude/sessions");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ prompt: "do it" });
  });

  it("continueClaudeSession passes force and surfaces 409 as live conflict", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "session_live", message: "live" }), { status: 409 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient("http://x", "tok");
    const err = await api.continueClaudeSession("s1", "go").catch((e) => e);
    expect(isLiveConflict(err)).toBe(true);

    // force path sends force:true
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", ok);
    await api.continueClaudeSession("s1", "go", true);
    const fcall = (ok.mock.calls as unknown as unknown[][])[0]!;
    const body = JSON.parse((fcall[1] as RequestInit).body as string);
    expect(body).toEqual({ prompt: "go", force: true });
  });
});
