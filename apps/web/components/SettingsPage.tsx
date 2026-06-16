"use client";

import { useEffect, useState } from "react";
import type { ClaudePermissionMode } from "@mac/shared";
import { useAppStore } from "../lib/store";
import { disablePush, enablePush, getPushStatus, isIosNonStandalone, isPushSupported, type PushStatus } from "../lib/push";

const PERM_OPTIONS: { value: ClaudePermissionMode; label: string; hint: string }[] = [
  { value: "plan", label: "计划", hint: "只规划不执行" },
  { value: "auto", label: "自动", hint: "按风险放行" },
  { value: "acceptEdits", label: "接受编辑", hint: "自动改文件" },
  { value: "default", label: "默认", hint: "" },
  { value: "bypassPermissions", label: "全部放行", hint: "危险" },
];

export function SettingsPage({
  serverUrl,
  wsConnected,
  permissionMode,
  onPermissionChange,
}: {
  serverUrl?: string;
  wsConnected: boolean;
  permissionMode: ClaudePermissionMode;
  onPermissionChange: (m: ClaudePermissionMode) => void;
}) {
  return (
    <div className="h-full overflow-y-auto overscroll-contain px-4 py-4 scroll-thin">
      <section className="mb-5">
        <h2 className="mb-2 text-[12px] font-semibold text-ink-dim">连接</h2>
        <div className="space-y-2.5 rounded-xl border border-line bg-bg-alt p-3 text-[13px]">
          <div>
            <div className="text-[12px] text-ink-faint">服务器</div>
            <div className="mt-0.5 break-all font-mono text-[12px] text-ink">{serverUrl ?? "—"}</div>
          </div>
          <Row label="状态" value={wsConnected ? "已连接" : "未连接"} tone={wsConnected ? "text-success" : "text-ink-faint"} />
        </div>
      </section>

      <PushSection />

      <section className="mb-5">
        <h2 className="mb-2 text-[12px] font-semibold text-ink-dim">默认权限模式</h2>
        <div className="overflow-hidden rounded-xl border border-line bg-bg-alt">
          {PERM_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => onPermissionChange(o.value)}
              className={`flex w-full items-center gap-2 border-b border-line/40 px-3 py-2.5 text-left text-[13px] last:border-0 hover:bg-bg-raised ${
                o.value === permissionMode ? "bg-bg-raised" : ""
              }`}
            >
              <span className="w-3 shrink-0 text-accent">{o.value === permissionMode ? "✓" : ""}</span>
              <span className="text-ink">{o.label}</span>
              {o.hint && (
                <span className={`ml-auto text-[11px] ${o.value === "bypassPermissions" ? "text-danger/80" : "text-ink-faint"}`}>
                  {o.hint}
                </span>
              )}
            </button>
          ))}
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-ink-faint">会话内仍可临时切换；此处为默认值。</p>
      </section>
    </div>
  );
}

function PushSection() {
  const api = useAppStore((s) => s.api);
  const [status, setStatus] = useState<PushStatus>("unsupported");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void getPushStatus().then(setStatus);
  }, []);

  const on = status === "subscribed";
  async function toggle() {
    if (!api || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      if (on) {
        await disablePush(api);
      } else {
        const r = await enablePush(api);
        if (!r.ok) setMsg(r.reason ?? "开启失败");
      }
      setStatus(await getPushStatus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-5">
      <h2 className="mb-2 text-[12px] font-semibold text-ink-dim">推送通知</h2>
      <div className="rounded-xl border border-line bg-bg-alt p-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink">需要回答 / 出错 / 完成时推送到本机</div>
            <div className="mt-0.5 text-[11px] text-ink-faint">
              {status === "unsupported"
                ? "此环境不支持（需 HTTPS）"
                : status === "denied"
                  ? "通知权限已被拒绝，请在系统设置中允许"
                  : on
                    ? "已开启"
                    : "关闭后台离线也能收到提醒"}
            </div>
          </div>
          <button
            onClick={() => void toggle()}
            disabled={busy || status === "unsupported" || status === "denied"}
            className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-40 ${
              on ? "bg-accent" : "bg-line"
            }`}
            aria-pressed={on}
            aria-label="推送通知开关"
          >
            <span
              className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${
                on ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
        {isIosNonStandalone() && (
          <p className="mt-2 rounded-lg bg-bg-raised px-2.5 py-1.5 text-[11px] text-ink-faint">
            iPhone：需用 Safari「添加到主屏幕」打开本应用，才能开启推送（浏览器标签页不支持）。
          </p>
        )}
        {msg && <p className="mt-2 text-[11px] text-danger">{msg}</p>}
      </div>
    </section>
  );
}

function Row({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className={`ml-auto truncate ${mono ? "font-mono text-[12px]" : ""} ${tone ?? "text-ink"}`}>{value}</span>
    </div>
  );
}
