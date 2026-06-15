"use client";

import type { ClaudePermissionMode } from "@mac/shared";

const PERM_OPTIONS: { value: ClaudePermissionMode; label: string; hint: string }[] = [
  { value: "plan", label: "计划", hint: "只规划不执行" },
  { value: "auto", label: "自动", hint: "按风险放行" },
  { value: "acceptEdits", label: "接受编辑", hint: "自动改文件" },
  { value: "default", label: "默认", hint: "" },
  { value: "bypassPermissions", label: "全部放行", hint: "危险" },
];

export function SettingsPage({
  serverUrl,
  workspaceName,
  wsConnected,
  permissionMode,
  onPermissionChange,
  onDisconnect,
}: {
  serverUrl?: string;
  workspaceName?: string;
  wsConnected: boolean;
  permissionMode: ClaudePermissionMode;
  onPermissionChange: (m: ClaudePermissionMode) => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="h-full overflow-y-auto overscroll-contain px-4 py-4 scroll-thin">
      <section className="mb-5">
        <h2 className="mb-2 text-[12px] font-semibold text-ink-dim">连接</h2>
        <div className="space-y-2 rounded-xl border border-line bg-bg-alt p-3 text-[13px]">
          <Row label="服务器" value={serverUrl ?? "—"} mono />
          <Row label="项目" value={workspaceName ?? "—"} />
          <Row label="状态" value={wsConnected ? "已连接" : "未连接"} tone={wsConnected ? "text-success" : "text-ink-faint"} />
        </div>
        <button
          onClick={onDisconnect}
          className="mt-2 w-full rounded-xl border border-danger/40 bg-danger/10 py-2 text-[13px] text-danger transition-colors hover:bg-danger/20"
        >
          断开连接
        </button>
      </section>

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

function Row({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className={`ml-auto truncate ${mono ? "font-mono text-[12px]" : ""} ${tone ?? "text-ink"}`}>{value}</span>
    </div>
  );
}
