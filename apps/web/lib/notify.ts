/**
 * Lightweight notifications. Real OS notifications need a secure context
 * (https/localhost); over plain-http remote we fall back to flashing the tab
 * title so a backgrounded tab still signals "Claude needs you / is done".
 */
import { isPushActive } from "./push";

let originalTitle = "";
let flashTimer: ReturnType<typeof setInterval> | null = null;

const IN_APP_KEY = "mac.inAppNotify";

/** Whether the foreground in-app notifier (OS notification + title flash) is on. Default on. */
export function getInAppNotify(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(IN_APP_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setInAppNotify(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(IN_APP_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

function canSystemNotify(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "Notification" in window &&
    Notification.permission === "granted"
  );
}

/** Ask for notification permission (no-op outside a secure context). */
export function ensureNotificationPermission(): void {
  if (typeof window === "undefined" || !window.isSecureContext) return;
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    void Notification.requestPermission().catch(() => {});
  }
}

/**
 * Foreground fallback notifier (desktop). Only fires when the page is NOT visible —
 * in the foreground the in-app UI already shows everything, so notifying there is just
 * noise. Real backgrounded/closed delivery is handled by Web Push (the service worker).
 */
export function notify(title: string, body?: string): void {
  if (typeof document === "undefined") return;
  if (!getInAppNotify()) return; // user disabled foreground in-app notifications
  if (!document.hidden) return; // viewing the app → no redundant notification
  // When Web Push is active, the service worker shows the notification — don't double up.
  if (canSystemNotify() && !isPushActive()) {
    try {
      new Notification(title, { body, icon: "/icon-192.png?v=3", tag: "claude-console" });
    } catch {
      /* ignore */
    }
  }
  startTitleFlash(title);
}

function startTitleFlash(msg: string): void {
  if (typeof document === "undefined") return;
  if (!originalTitle) originalTitle = document.title;
  stopTitleFlash(false);
  let on = false;
  flashTimer = setInterval(() => {
    document.title = on ? originalTitle : `🔔 ${msg}`;
    on = !on;
  }, 1000);
}

function stopTitleFlash(restore = true): void {
  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  if (restore && originalTitle && typeof document !== "undefined") {
    document.title = originalTitle;
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) stopTitleFlash(true);
  });
  window.addEventListener("focus", () => stopTitleFlash(true));
}
