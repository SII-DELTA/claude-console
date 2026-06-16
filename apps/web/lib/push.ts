"use client";

import type { ApiClient } from "./api";

export type PushStatus = "unsupported" | "denied" | "default" | "subscribed" | "unsubscribed";

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

/** iOS only allows Web Push for home-screen PWAs (not in a browser tab). */
export function isIosNonStandalone(): boolean {
  if (typeof navigator === "undefined") return false;
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone =
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return iOS && !standalone;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  return existing ?? (await navigator.serviceWorker.register("/sw.js"));
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "default";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? "subscribed" : "unsubscribed";
  } catch {
    return "unsubscribed";
  }
}

/** Register SW, request permission, subscribe, and report to the agent. */
export async function enablePush(api: ApiClient): Promise<{ ok: boolean; reason?: string }> {
  if (!isPushSupported()) return { ok: false, reason: "此环境不支持推送（需 HTTPS）" };
  const { enabled, publicKey } = await api.pushVapidPublicKey();
  if (!enabled || !publicKey) return { ok: false, reason: "后端未启用推送" };

  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: "未授予通知权限" };

  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));
  await api.pushSubscribe(sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } });
  try {
    localStorage.setItem(PUSH_ACTIVE_KEY, "1"); // tell the page-level fallback to step aside
  } catch {
    /* ignore */
  }
  return { ok: true };
}

/** localStorage flag: Web Push is active, so the page-level notifier shouldn't double up. */
export const PUSH_ACTIVE_KEY = "mac.pushActive";
export function isPushActive(): boolean {
  try {
    return localStorage.getItem(PUSH_ACTIVE_KEY) === "1";
  } catch {
    return false;
  }
}

export async function disablePush(api: ApiClient): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api.pushUnsubscribe(sub.endpoint).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {
    /* best effort */
  } finally {
    try {
      localStorage.removeItem(PUSH_ACTIVE_KEY);
    } catch {
      /* ignore */
    }
  }
}

/** Listen for the SW asking the app to open a session (notification click). */
export function onPushOpenSession(cb: (sessionId: string) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const handler = (e: MessageEvent) => {
    if (e.data?.type === "open-session" && e.data.sessionId) cb(e.data.sessionId);
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
