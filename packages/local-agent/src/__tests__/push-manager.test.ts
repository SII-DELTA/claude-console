import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "PUBKEY", privateKey: "PRIVKEY" }),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({}),
  },
}));

import webpush from "web-push";
import { HistoryStore } from "../history-store.js";
import { PushManager } from "../push-manager.js";

const send = webpush.sendNotification as unknown as ReturnType<typeof vi.fn>;

describe("PushManager", () => {
  let store: HistoryStore;
  let t: number;
  let push: PushManager;

  beforeEach(() => {
    send.mockClear();
    send.mockResolvedValue({});
    store = new HistoryStore(":memory:");
    t = 1000;
    push = new PushManager(store, { storagePath: ":memory:", now: () => t });
    push.subscribe({ endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } });
  });
  afterEach(() => store.close());

  it("exposes the VAPID public key", () => {
    expect(push.publicKey).toBe("PUBKEY");
  });

  it("pushes a payload to each subscription", async () => {
    await push.notify({ sessionId: "s1", title: "T", body: "B", kind: "done" });
    expect(send).toHaveBeenCalledTimes(1);
    const [sub, payload] = send.mock.calls[0]!;
    expect(sub.endpoint).toBe("https://push.example/abc");
    expect(JSON.parse(payload as string)).toMatchObject({ sessionId: "s1", kind: "done" });
  });

  it("throttles repeated same session+kind, but allows a different kind", async () => {
    await push.notify({ sessionId: "s1", title: "T", body: "B", kind: "done" });
    await push.notify({ sessionId: "s1", title: "T", body: "B", kind: "done" }); // within window → skipped
    expect(send).toHaveBeenCalledTimes(1);
    await push.notify({ sessionId: "s1", title: "T", body: "B", kind: "question" }); // different kind → sent
    expect(send).toHaveBeenCalledTimes(2);
    t += 10_000; // window elapsed
    await push.notify({ sessionId: "s1", title: "T", body: "B", kind: "done" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("prunes a subscription that returns 410 Gone", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }));
    await push.notify({ sessionId: "s1", title: "T", body: "B", kind: "error" });
    expect(store.listPushSubscriptions()).toHaveLength(0);
  });
});

describe("HistoryStore push subscriptions", () => {
  it("upserts, lists and deletes subscriptions", () => {
    const store = new HistoryStore(":memory:");
    store.savePushSubscription({ endpoint: "e1", p256dh: "p", auth: "a" });
    store.savePushSubscription({ endpoint: "e1", p256dh: "p2", auth: "a2" }); // upsert
    store.savePushSubscription({ endpoint: "e2", p256dh: "p", auth: "a" });
    const list = store.listPushSubscriptions();
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.endpoint === "e1")?.p256dh).toBe("p2");
    store.deletePushSubscription("e1");
    expect(store.listPushSubscriptions().map((s) => s.endpoint)).toEqual(["e2"]);
    store.close();
  });
});
