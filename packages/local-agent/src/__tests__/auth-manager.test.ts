import { describe, expect, it } from "vitest";
import { Bus } from "../bus.js";
import { HistoryStore } from "../history-store.js";
import { AuthManager } from "../auth-manager.js";

describe("AuthManager", () => {
  function setup() {
    const store = new HistoryStore(":memory:");
    const bus = new Bus();
    const auth = new AuthManager(store, bus, { ttlMs: 1_000_000 });
    return { store, bus, auth };
  }

  it("issues + verifies pair code → mints token", () => {
    const { auth } = setup();
    const code = auth.issuePairCode();
    expect(code).toMatch(/^\d{8}$/);
    const result = auth.pair({ pairCode: code, deviceName: "iPhone", platform: "ios" });
    expect("token" in result).toBe(true);
    if (!("token" in result)) throw new Error("expected token");
    const dev = auth.verifyToken(result.token);
    expect(dev?.id).toBe(result.device.id);
  });

  it("rejects wrong code and locks after 5 failures", () => {
    const { auth } = setup();
    auth.issuePairCode();
    for (let i = 0; i < 5; i++) {
      const r = auth.pair({ pairCode: "00000000", deviceName: "x", platform: "web" });
      expect("error" in r).toBe(true);
    }
    auth.issuePairCode();
    const locked = auth.pair({ pairCode: "00000000", deviceName: "x", platform: "web" });
    expect("error" in locked && locked.error).toBe("rate_limited");
  });

  it("rejects expired pair code", () => {
    const store = new HistoryStore(":memory:");
    const bus = new Bus();
    let now = 1_000;
    const auth = new AuthManager(store, bus, { ttlMs: 100, now: () => now });
    const code = auth.issuePairCode();
    now += 200;
    const r = auth.pair({ pairCode: code, deviceName: "x", platform: "web" });
    expect("error" in r && r.error).toBe("expired");
  });

  it("revokes a device", () => {
    const { auth } = setup();
    const code = auth.issuePairCode();
    const r = auth.pair({ pairCode: code, deviceName: "x", platform: "web" });
    if (!("token" in r)) throw new Error("expected token");
    auth.revokeDevice(r.device.id);
    expect(auth.verifyToken(r.token)).toBeNull();
  });

  it("verifyToken returns null for unknown", () => {
    const { auth } = setup();
    expect(auth.verifyToken("nope")).toBeNull();
    expect(auth.verifyToken(null)).toBeNull();
  });

  it("password login: correct password mints a token, wrong is rejected + locks", () => {
    const store = new HistoryStore(":memory:");
    const auth = new AuthManager(store, new Bus(), { password: "s3cret" });
    expect(auth.hasPassword()).toBe(true);
    const ok = auth.loginWithPassword({ password: "s3cret", deviceName: "iPhone", platform: "ios" });
    if (!("token" in ok)) throw new Error("expected token");
    expect(auth.verifyToken(ok.token)?.id).toBe(ok.device.id);
    for (let i = 0; i < 5; i++) {
      const r = auth.loginWithPassword({ password: "nope", deviceName: "x", platform: "web" });
      expect("error" in r).toBe(true);
    }
    const locked = auth.loginWithPassword({ password: "s3cret", deviceName: "x", platform: "web" });
    expect("error" in locked && locked.error).toBe("rate_limited");
  });

  it("password login disabled when no password configured", () => {
    const { auth } = setup();
    expect(auth.hasPassword()).toBe(false);
    const r = auth.loginWithPassword({ password: "anything", deviceName: "x", platform: "web" });
    expect("error" in r).toBe(true);
  });

  it("pair code is single-use", () => {
    const { auth } = setup();
    const code = auth.issuePairCode();
    const a = auth.pair({ pairCode: code, deviceName: "a", platform: "web" });
    const b = auth.pair({ pairCode: code, deviceName: "b", platform: "web" });
    expect("token" in a).toBe(true);
    expect("error" in b).toBe(true);
  });
});
