/* Claude Console service worker — Web Push only (no offline caching). */
/* eslint-disable no-restricted-globals */

const ICON = "/icon-192.png?v=3";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* non-JSON payload → ignore */
  }
  const sessionId = data.sessionId || "";
  const title = data.title || "Claude Console";
  const body = data.body || "";

  event.waitUntil(
    (async () => {
      // If a visible window is already viewing this session, the in-app UI already
      // shows it — don't double-notify.
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const viewing = wins.some(
        (c) => c.visibilityState === "visible" && sessionId && c.url.includes("s=" + sessionId),
      );
      if (viewing) return;
      await self.registration.showNotification(title, {
        body,
        icon: ICON,
        badge: ICON,
        tag: sessionId || "claude-console",
        renotify: true,
        data: { sessionId },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = (event.notification.data && event.notification.data.sessionId) || "";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of wins) {
        // focus an existing window and tell the app to open the session
        c.postMessage({ type: "open-session", sessionId });
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(sessionId ? "/?s=" + sessionId : "/");
      }
    })(),
  );
});
