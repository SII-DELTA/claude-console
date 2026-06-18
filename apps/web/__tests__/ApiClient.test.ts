import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiClient, isLiveConflict, isNotFound } from "../lib/api";
import { clearNetErrors, getNetErrors } from "../lib/net-errors";

describe("ApiClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearNetErrors();
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

  it("answerClaudeToolApproval posts the decision", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient("http://x", "tok");
    await api.answerClaudeToolApproval("sess1", "req9", "deny");
    const call = (fetchMock.mock.calls as unknown as unknown[][])[0]!;
    expect(call[0]).toBe("http://x/claude/sessions/sess1/answer-tool-approval");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ requestId: "req9", decision: "deny" });
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

  it("silent404 keeps an expected 404 out of the error log but still throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
      ),
    );
    const api = new ApiClient("http://x", "tok");

    // silent: thrown as 404, but not recorded
    const err = await api.claudeSession("fresh", { limit: 40 }, { silent404: true }).catch((e) => e);
    expect(isNotFound(err)).toBe(true);
    expect(getNetErrors()).toHaveLength(0);

    // default: a real 404 is still recorded for inspection
    await api.claudeSession("gone", { limit: 40 }).catch(() => {});
    expect(getNetErrors()).toHaveLength(1);
    expect(getNetErrors()[0]!.status).toBe(404);
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
