"use client";

import { useEffect, useState } from "react";
import type { ClaudePermissionMode } from "@mac/shared";
import { useAppStore, type EnterBehavior } from "../lib/store";
import { getInAppNotify, setInAppNotify } from "../lib/notify";
import { disablePush, enablePush, getCachedPushStatus, getPushStatus, isIosNonStandalone, isPushSupported, type PushStatus } from "../lib/push";
import { collectNotifyDiagnostics, diagnosticsEqual, getCachedDiagnostics, sendTestNotification, type NotifyDiagnostics } from "../lib/notify-diagnostics";
import { getDebugConsole, setDebugConsole } from "../lib/debug-log";
import { clearNetErrors, diagnoseNetError, formatNetErrorsForCopy, getNetErrors, subscribeNetErrors, type NetError } from "../lib/net-errors";
import { copyText } from "../lib/clipboard";

/** Reusable iOS-style switch (track + knob), correctly centered. */
function Toggle({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-40 ${
        on ? "bg-accent" : "bg-line"
      }`}
    >
      <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );
}

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

      <DiagnosticsSection />

      <NetworkErrorsSection serverUrl={serverUrl} />

      <GeneralSection />

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
  const [status, setStatus] = useState<PushStatus>(() => getCachedPushStatus() ?? "unsupported");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void getPushStatus().then((s) => setStatus((prev) => (prev === s ? prev : s)));
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
          <Toggle
            on={on}
            onClick={() => void toggle()}
            disabled={busy || status === "unsupported" || status === "denied"}
            label="推送通知开关"
          />
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

const MSG_PRESETS = [10, 20, 40, 60];
const ENTER_OPTS: { v: EnterBehavior; label: string }[] = [
  { v: "auto", label: "自动" },
  { v: "send", label: "发送" },
  { v: "newline", label: "换行" },
];

function GeneralSection() {
  const initialMessages = useAppStore((s) => s.initialMessages);
  const setInitialMessages = useAppStore((s) => s.setInitialMessages);
  const enterBehavior = useAppStore((s) => s.enterBehavior);
  const setEnterBehavior = useAppStore((s) => s.setEnterBehavior);
  const [inApp, setInApp] = useState(() => getInAppNotify());
  const [dbg, setDbg] = useState(() => getDebugConsole());

  return (
    <section className="mb-5">
      <h2 className="mb-2 text-[12px] font-semibold text-ink-dim">通用</h2>
      <div className="space-y-3.5 rounded-xl border border-line bg-bg-alt p-3">
        <div>
          <div className="text-[13px] text-ink">首屏消息条数</div>
          <div className="mt-1.5 flex gap-1.5">
            {MSG_PRESETS.map((n) => (
              <button
                key={n}
                onClick={() => setInitialMessages(n)}
                className={`flex-1 rounded-lg border py-1.5 text-[13px] transition-colors ${
                  n === initialMessages ? "border-accent bg-accent/15 text-accent" : "border-line text-ink-dim hover:bg-bg-raised"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-faint">打开会话首屏渲染条数；「加载更早」每次仍 +40。</p>
        </div>

        <div>
          <div className="text-[13px] text-ink">回车键</div>
          <div className="mt-1.5 flex gap-1.5">
            {ENTER_OPTS.map((o) => (
              <button
                key={o.v}
                onClick={() => setEnterBehavior(o.v)}
                className={`flex-1 rounded-lg border py-1.5 text-[13px] transition-colors ${
                  o.v === enterBehavior ? "border-accent bg-accent/15 text-accent" : "border-line text-ink-dim hover:bg-bg-raised"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-faint">自动：触屏换行、桌面回车发送。Shift+Enter 始终换行。</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink">前台应用内通知</div>
            <div className="mt-0.5 text-[11px] text-ink-faint">App 在前台但页面隐藏时的系统通知与标题提醒。</div>
          </div>
          <Toggle
            on={inApp}
            onClick={() => {
              const v = !inApp;
              setInAppNotify(v);
              setInApp(v);
            }}
            label="前台通知开关"
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink">调试控制台</div>
            <div className="mt-0.5 text-[11px] text-ink-faint">页面浮出可查看 console 日志与网络请求；手机排查用。</div>
          </div>
          <Toggle
            on={dbg}
            onClick={() => {
              const v = !dbg;
              setDebugConsole(v);
              setDbg(v);
            }}
            label="调试控制台开关"
          />
        </div>
      </div>
    </section>
  );
}

function DiagRow({ label, value, ok }: { label: string; value: string; ok?: boolean | null }) {
  const tone = ok == null ? "text-ink-dim" : ok ? "text-success" : "text-danger";
  return (
    <div className="flex items-center gap-3 py-1 text-[12px]">
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className={`ml-auto truncate font-mono ${tone}`}>{value}</span>
    </div>
  );
}

function NetworkErrorsSection({ serverUrl }: { serverUrl?: string }) {
  const [errs, setErrs] = useState<NetError[]>([]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setErrs([...getNetErrors()].reverse());
    return subscribeNetErrors(() => setErrs([...getNetErrors()].reverse()));
  }, []);

  async function copyAll() {
    const ok = await copyText(
      formatNetErrorsForCopy({
        serverUrl,
        appUrl: typeof location !== "undefined" ? location.href : undefined,
        ua: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      }),
    );
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  const btn = "rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-ink-dim hover:bg-bg-raised disabled:opacity-40";
  const tone = (e: NetError) => (e.status === 0 || e.status >= 500 ? "text-danger" : e.status === 409 ? "text-warning" : "text-ink-dim");

  return (
    <section className="mb-5">
      <h2 className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-ink-dim">
        接口错误
        {errs.length > 0 && (
          <span className="rounded-full bg-danger/15 px-1.5 text-[11px] font-medium text-danger">{errs.length}</span>
        )}
      </h2>
      <div className="rounded-xl border border-line bg-bg-alt p-3">
        {errs.length === 0 ? (
          <div className="py-1.5 text-[12px] text-ink-faint">暂无接口错误 ✓</div>
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto scroll-thin">
            {errs.map((e) => (
              <div key={e.id} className="rounded-lg border border-line/60 bg-bg p-2">
                <div className="flex items-baseline gap-2 font-mono text-[11px]">
                  <span className="text-ink-faint">{fmtClock(e.ts)}</span>
                  <span className={`font-semibold ${tone(e)}`}>{e.status === 0 ? e.kind : e.status}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-dim">
                    {e.method} {e.path}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-ink-dim">{diagnoseNetError(e)}</p>
                {e.detail && <p className="mt-0.5 break-all font-mono text-[10px] text-ink-faint">{e.detail}</p>}
              </div>
            ))}
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button onClick={() => void copyAll()} disabled={errs.length === 0} className={btn}>
            {copied ? "已复制" : "复制给 AI 分析"}
          </button>
          <button onClick={() => clearNetErrors()} disabled={errs.length === 0} className={btn}>
            清空
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-faint">出错时可截图本面板，或「复制给 AI 分析」粘贴给我排查。</p>
      </div>
    </section>
  );
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function DiagnosticsSection() {
  const api = useAppStore((s) => s.api);
  const [d, setD] = useState<NotifyDiagnostics | null>(() => getCachedDiagnostics());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const next = await collectNotifyDiagnostics(api ?? null);
    setD((prev) => (diagnosticsEqual(prev, next) ? prev : next));
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function requestPerm() {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    setBusy(true);
    setMsg(null);
    try {
      const p = await Notification.requestPermission();
      setMsg(`授权结果：${p}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function resubscribe() {
    if (!api) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await enablePush(api);
      setMsg(r.ok ? "已重新注册并订阅推送" : `订阅失败：${r.reason ?? "未知"}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await sendTestNotification();
      setMsg(r.ok ? "已发送测试通知（页面隐藏时更明显）" : `测试失败：${r.reason}`);
    } finally {
      setBusy(false);
    }
  }

  async function testPush() {
    if (!api) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.pushTest();
      const failed = r.results.filter((x) => !x.ok);
      setMsg(
        r.total === 0
          ? "后端没有任何推送订阅 —— 先「重新订阅推送」"
          : failed.length === 0
            ? `服务器已推送到 ${r.sent}/${r.total} 个设备（应已收到）`
            : `推送失败：${r.sent}/${r.total} 成功，失败状态码 ${failed.map((x) => x.status ?? "?").join("/")}`,
      );
    } catch (e) {
      setMsg(`后端推送测试失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  }

  const btn = "rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-ink-dim hover:bg-bg-raised disabled:opacity-40";

  return (
    <section className="mb-5">
      <h2 className="mb-2 text-[12px] font-semibold text-ink-dim">通知诊断</h2>
      <div className="rounded-xl border border-line bg-bg-alt p-3">
        {!d ? (
          <div className="py-2 text-[12px] text-ink-faint">采集中…</div>
        ) : (
          <div className="divide-y divide-line/30">
            <DiagRow label="安全上下文" value={String(d.isSecureContext)} ok={d.isSecureContext} />
            <DiagRow label="通知 API" value={String(d.hasNotificationApi)} ok={d.hasNotificationApi} />
            <DiagRow label="通知权限" value={d.permission} ok={d.permission === "granted"} />
            <DiagRow label="SW 支持" value={String(d.hasServiceWorker)} ok={d.hasServiceWorker} />
            <DiagRow label="SW 已注册" value={String(d.swRegistered)} ok={d.swRegistered} />
            <DiagRow label="推送已订阅" value={String(d.pushSubscribed)} ok={d.pushSubscribed} />
            {d.swError && <DiagRow label="SW 错误" value={d.swError} ok={false} />}
            <DiagRow
              label="后端推送"
              value={d.backendError ? "请求失败" : d.backendEnabled == null ? "—" : String(d.backendEnabled)}
              ok={d.backendError ? false : d.backendEnabled}
            />
            <DiagRow label="前台通知开关" value={d.inAppNotify ? "开" : "关"} ok={d.inAppNotify} />
            <DiagRow label="推送本地标记" value={d.pushActiveLs ?? "null"} ok={d.pushActiveLs === "1"} />
            <DiagRow label="页面隐藏" value={String(d.documentHidden)} />
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button onClick={() => void refresh()} disabled={busy} className={btn}>
            刷新
          </button>
          <button onClick={() => void requestPerm()} disabled={busy} className={btn}>
            请求通知授权
          </button>
          <button onClick={() => void resubscribe()} disabled={busy || !api} className={btn}>
            重新订阅推送
          </button>
          <button onClick={() => void test()} disabled={busy} className={btn}>
            发送测试通知
          </button>
          <button onClick={() => void testPush()} disabled={busy || !api} className={btn}>
            测试服务器推送
          </button>
        </div>
        {msg && <p className="mt-2 text-[11px] text-ink-dim">{msg}</p>}
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
