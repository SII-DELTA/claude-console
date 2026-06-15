"use client";

import { useState } from "react";
import { ApiClient } from "../lib/api";
import { useAppStore } from "../lib/store";
import { ClaudeLogo } from "./ClaudeLogo";

/**
 * Guess the agent address from how the page is being served:
 * - localhost            → the local agent on :7345
 * - served on :3005      → two-port setup, agent on the same host :7345
 * - served via a proxy   → single-origin setup, agent under <origin>/agent
 */
function defaultAgentUrl(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:7345";
  const { hostname, protocol, port, origin } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return "http://127.0.0.1:7345";
  if (port === "3005") return `${protocol}//${hostname}:7345`;
  return `${origin}/agent`;
}
const DEFAULT_URL = defaultAgentUrl();

export function ConnectForm() {
  const setConnection = useAppStore((s) => s.setConnection);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function connect() {
    setErr(null);
    setBusy(true);
    try {
      const base = url.replace(/\/$/, "");
      const api = new ApiClient(base);
      // One generic call decides everything; the server never reveals its mode.
      const res = await api.login({ password, deviceName: deviceName(), platform: "web" });
      setConnection({
        url: base,
        wsUrl: base.replace(/^http/, "ws") + "/ws",
        token: res.token,
        workspaceId: res.workspace.id,
        workspaceName: res.workspace.name,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setErr(
        msg.includes("401")
          ? "登录失败"
          : msg.includes("429")
            ? "尝试过多，请稍后再试"
            : "无法连接",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-bg-alt p-6">
        <div className="flex items-start justify-between mb-3">
          <div></div>
          <button
            onClick={() => window.location.reload()}
            className="h-10 w-10 flex items-center justify-center rounded-lg border border-line hover:bg-bg-raised transition-colors flex-shrink-0 text-lg"
            title="刷新页面"
          >
            ⟳
          </button>
        </div>
        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-accent/15">
            <ClaudeLogo size={26} className="text-[#D97757]" />
          </div>
          <h1 className="text-lg font-semibold text-ink">Claude Console</h1>
        </div>

        <label className="mb-1 block text-xs text-ink-dim">服务器地址</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="field mb-3"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />

        <label className="mb-1 block text-xs text-ink-dim">密码</label>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
          type="password"
          autoComplete="current-password"
          className="field mb-4"
        />

        {err && <p className="mb-3 text-sm text-danger">{err}</p>}

        <button onClick={connect} disabled={busy} className="btn w-full">
          {busy ? "登录中…" : "登录"}
        </button>
      </div>
    </div>
  );
}

function deviceName(): string {
  if (typeof navigator === "undefined") return "web";
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android Web";
  if (/iPhone|iPad/i.test(ua)) return "iOS Web";
  return "Browser";
}
