"use client";

import { useEffect, useState } from "react";
import { ApiClient } from "../lib/api";
import { useAppStore } from "../lib/store";
import { ClaudeLogo } from "./ClaudeLogo";

// Agent's HTTPS port when fronted by `tailscale serve --https=8443 localhost:7345`.
// Configurable via root .env AGENT_HTTPS_PORT (baked at build by dev-control.sh).
const TS_AGENT_HTTPS_PORT = process.env.NEXT_PUBLIC_AGENT_HTTPS_PORT || "8443";

/**
 * Guess the agent address from how the page is being served:
 * - localhost                → the local agent on :7345
 * - https on a *.ts.net host  → tailscale serve: agent on the same host :8443
 * - served on :3005          → two-port setup, agent on the same host :7345
 * - served via a proxy       → single-origin setup, agent under <origin>/agent
 */
function defaultAgentUrl(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:7345";
  const { hostname, protocol, port, origin } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return "http://127.0.0.1:7345";
  // Tailscale serve puts web on https/443 at <host>.ts.net and the agent on a 2nd https port.
  if (protocol === "https:" && hostname.endsWith(".ts.net")) return `https://${hostname}:${TS_AGENT_HTTPS_PORT}`;
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
  // "unknown": agent unreachable / not probed yet → show full form as fallback.
  const [authMode, setAuthMode] = useState<"unknown" | "none" | "password">("unknown");

  async function connect(pwd = password) {
    setErr(null);
    setBusy(true);
    try {
      const base = url.replace(/\/$/, "");
      const api = new ApiClient(base);
      const res = await api.login({ password: pwd, deviceName: deviceName(), platform: "web" });
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

  /** Probe the agent's auth mode; returns it (or "unknown" if unreachable). */
  async function probe(target: string): Promise<"unknown" | "none" | "password"> {
    try {
      const h = await new ApiClient(target.replace(/\/$/, "")).health();
      const mode = h.auth === "none" ? "none" : "password";
      setAuthMode(mode);
      return mode;
    } catch {
      setAuthMode("unknown");
      return "unknown";
    }
  }

  // On load: if the agent runs open (no password), skip login and connect directly.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mode = await probe(DEFAULT_URL);
      if (!cancelled && mode === "none") void connect("");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needsPassword = authMode !== "none";

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
          onBlur={(e) => void probe(e.target.value)}
          className={needsPassword ? "field mb-3" : "field mb-4"}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />

        {needsPassword && (
          <>
            <label className="mb-1 block text-xs text-ink-dim">密码</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && connect()}
              type="password"
              autoComplete="current-password"
              className="field mb-4"
            />
          </>
        )}

        {err && <p className="mb-3 text-sm text-danger">{err}</p>}

        <button onClick={() => connect()} disabled={busy} className="btn w-full">
          {busy ? "连接中…" : needsPassword ? "登录" : "连接"}
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
