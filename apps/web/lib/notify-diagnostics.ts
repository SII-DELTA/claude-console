"use client";

import type { ApiClient } from "./api";
import { getInAppNotify, notify } from "./notify";

/** Snapshot of every link in the notification delivery chain, for in-app diagnosis. */
export type NotifyDiagnostics = {
  isSecureContext: boolean;
  hasNotificationApi: boolean;
  permission: NotificationPermission | "unsupported";
  hasServiceWorker: boolean;
  swRegistered: boolean;
  swScope: string | null;
  pushSubscribed: boolean;
  swError: string | null;
  backendEnabled: boolean | null;
  backendError: string | null;
  inAppNotify: boolean;
  pushActiveLs: string | null;
  documentHidden: boolean;
};

export async function collectNotifyDiagnostics(api: ApiClient | null): Promise<NotifyDiagnostics> {
  const hasNotificationApi = typeof window !== "undefined" && "Notification" in window;
  const hasServiceWorker = typeof navigator !== "undefined" && "serviceWorker" in navigator;

  const d: NotifyDiagnostics = {
    isSecureContext: typeof window !== "undefined" && window.isSecureContext,
    hasNotificationApi,
    permission: hasNotificationApi ? Notification.permission : "unsupported",
    hasServiceWorker,
    swRegistered: false,
    swScope: null,
    pushSubscribed: false,
    swError: null,
    backendEnabled: null,
    backendError: null,
    inAppNotify: getInAppNotify(),
    pushActiveLs: readLs("mac.pushActive"),
    documentHidden: typeof document !== "undefined" && document.hidden,
  };

  if (hasServiceWorker) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      d.swRegistered = !!reg;
      d.swScope = reg?.scope ?? null;
      const sub = await reg?.pushManager?.getSubscription();
      d.pushSubscribed = !!sub;
    } catch (e) {
      d.swError = String(e);
    }
  }

  if (api) {
    try {
      const r = await api.pushVapidPublicKey();
      d.backendEnabled = r.enabled;
    } catch (e) {
      d.backendError = String(e);
    }
  }

  return d;
}

/** Fire a local notification (if granted) plus the in-app title-flash path, to verify the local chain. */
export async function sendTestNotification(): Promise<{ ok: boolean; reason?: string }> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { ok: false, reason: "此环境不支持 Notification API" };
  }
  if (!window.isSecureContext) {
    return { ok: false, reason: "非安全上下文(需 HTTPS/localhost)" };
  }
  if (Notification.permission !== "granted") {
    return { ok: false, reason: `通知权限为 ${Notification.permission},请先请求授权` };
  }
  try {
    new Notification("🔔 测试通知", { body: "如果你看到这条,本地通知链路正常", icon: "/icon-192.png?v=3", tag: "claude-console-test" });
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
  // Also exercise the in-app fallback (title flash) so it can be verified when backgrounded.
  notify("🔔 测试通知", "本地通知链路测试");
  return { ok: true };
}

function readLs(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
