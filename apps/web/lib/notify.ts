/**
 * Lightweight notifications. Real OS notifications need a secure context
 * (https/localhost); over plain-http remote we fall back to flashing the tab
 * title so a backgrounded tab still signals "Claude needs you / is done".
 */
let originalTitle = "";
let flashTimer: ReturnType<typeof setInterval> | null = null;

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

/** Notify the user a turn finished / needs input. Self-gates on tab visibility. */
export function notify(title: string, body?: string): void {
  if (typeof document === "undefined") return;
  if (canSystemNotify()) {
    try {
      new Notification(title, { body, icon: "/claude-logo.svg", tag: "claude-console" });
    } catch {
      /* ignore */
    }
  }
  if (document.hidden) startTitleFlash(title);
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
