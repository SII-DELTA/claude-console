import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";
import type { PushSubscriptionJSON } from "@mac/shared";
import type { HistoryStore } from "./history-store.js";

export type PushKind = "question" | "error" | "done";

export interface PushPayload {
  sessionId: string;
  title: string;
  body: string;
  kind: PushKind;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Re-notifying the same session+kind within this window is suppressed (anti-spam). */
const THROTTLE_MS = 8_000;

/**
 * Web Push sender. Owns the VAPID keypair (generated once, persisted to the agent's
 * storage dir) and pushes notifications to every stored browser subscription. Failed
 * subscriptions (404/410 gone) are pruned automatically.
 */
export class PushManager {
  private keys: VapidKeys;
  private readonly lastSent = new Map<string, number>(); // `${sessionId}:${kind}` → ts
  private nowFn: () => number = () => Date.now();

  constructor(
    private readonly store: HistoryStore,
    opts: { storagePath: string; subject?: string; now?: () => number },
  ) {
    this.keys = loadOrCreateVapid(opts.storagePath);
    if (opts.now) this.nowFn = opts.now;
    webpush.setVapidDetails(opts.subject ?? "mailto:claude-console@localhost", this.keys.publicKey, this.keys.privateKey);
  }

  /** Public VAPID key the browser needs to create a subscription. */
  get publicKey(): string {
    return this.keys.publicKey;
  }

  subscribe(sub: PushSubscriptionJSON): void {
    this.store.savePushSubscription({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth });
  }

  unsubscribe(endpoint: string): void {
    this.store.deletePushSubscription(endpoint);
  }

  hasSubscriptions(): boolean {
    return this.store.listPushSubscriptions().length > 0;
  }

  /** Push to all subscriptions. De-duped per session+kind within THROTTLE_MS. */
  async notify(payload: PushPayload): Promise<void> {
    const key = `${payload.sessionId}:${payload.kind}`;
    const now = this.nowFn();
    const last = this.lastSent.get(key);
    if (last != null && now - last < THROTTLE_MS) return;
    this.lastSent.set(key, now);
    // Prune expired throttle keys so the map doesn't grow unbounded with session count.
    if (this.lastSent.size > 256) {
      for (const [k, ts] of this.lastSent) if (now - ts >= THROTTLE_MS) this.lastSent.delete(k);
    }

    const subs = this.store.listPushSubscriptions();
    if (subs.length === 0) return;
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) this.store.deletePushSubscription(s.endpoint); // gone → prune
        }
      }),
    );
  }
}

function loadOrCreateVapid(storagePath: string): VapidKeys {
  // ":memory:" (tests) → ephemeral keys, no file
  if (!storagePath || storagePath === ":memory:") return webpush.generateVAPIDKeys();
  const file = join(storagePath, "push-vapid.json");
  if (existsSync(file)) {
    try {
      const k = JSON.parse(readFileSync(file, "utf8")) as VapidKeys;
      if (k.publicKey && k.privateKey) return k;
    } catch {
      /* regenerate below */
    }
  }
  const keys = webpush.generateVAPIDKeys();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(keys, null, 2));
  } catch {
    /* non-persistent fallback (still works for this run) */
  }
  return keys;
}
