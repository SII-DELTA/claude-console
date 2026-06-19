import { timingSafeEqual } from "node:crypto";
import { generatePairCode, randomToken, sha256 } from "./util/crypto.js";
import type { Bus } from "./bus.js";
import { HistoryStore, type DeviceRecord } from "./history-store.js";
import { PAIR_CODE_LENGTH, PAIR_CODE_TTL_MS } from "@mac/shared";

/** Constant-time string compare (hashes both sides to equal length first). */
function safeEqual(a: string, b: string): boolean {
  const ha = Buffer.from(sha256(a), "hex");
  const hb = Buffer.from(sha256(b), "hex");
  return timingSafeEqual(ha, hb);
}

interface PairCodeEntry {
  code: string;
  expiresAt: number;
  used: boolean;
}

export interface AuthResult {
  ok: boolean;
  device?: DeviceRecord;
  reason?: "expired" | "invalid" | "rate_limited";
}

export class AuthManager {
  private current: PairCodeEntry | null = null;
  private failedAttempts = 0;
  private lockedUntil = 0;

  constructor(
    private readonly store: HistoryStore,
    private readonly bus: Bus,
    private readonly opts: {
      now?: () => number;
      ttlMs?: number;
      codeLength?: number;
      /** when set, enables password login (cleartext compared constant-time) */
      password?: string;
      /** a token unused for this long is treated as expired (default 90d, 0 = never). */
      tokenIdleTtlMs?: number;
    } = {},
  ) {}

  hasPassword(): boolean {
    return !!this.opts.password;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Generate (or reuse if not yet expired) a pair code. */
  issuePairCode(): string {
    const now = this.now();
    if (this.current && !this.current.used && this.current.expiresAt > now) {
      return this.current.code;
    }
    const code = generatePairCode(this.opts.codeLength ?? PAIR_CODE_LENGTH);
    this.current = {
      code,
      expiresAt: now + (this.opts.ttlMs ?? PAIR_CODE_TTL_MS),
      used: false,
    };
    return code;
  }

  invalidatePairCode(): void {
    this.current = null;
  }

  /** Returns the active pair code (if any) — used for QR rendering. */
  peekPairCode(): { code: string; expiresAt: number } | null {
    if (!this.current || this.current.used) return null;
    if (this.current.expiresAt <= this.now()) return null;
    return { code: this.current.code, expiresAt: this.current.expiresAt };
  }

  /**
   * Verify pair code, mint a long-lived token, persist device.
   * Returns the plaintext token (only ever returned once).
   */
  pair(input: {
    pairCode: string;
    deviceName: string;
    platform: "ios" | "android" | "web" | "unknown";
  }): { token: string; device: DeviceRecord } | { error: AuthResult["reason"] } {
    const now = this.now();
    if (this.lockedUntil > now) return { error: "rate_limited" };
    if (!this.current) return { error: "invalid" };
    if (this.current.used) return { error: "invalid" };
    if (this.current.expiresAt <= now) return { error: "expired" };
    if (!safeEqual(this.current.code, input.pairCode)) {
      this.registerFailure(now);
      return { error: "invalid" };
    }

    this.current.used = true;
    this.failedAttempts = 0;
    return { ...this.mintToken(input.deviceName, input.platform, now) };
  }

  /**
   * Password login: verify against the configured password (constant-time),
   * with the same lockout as pairing, and mint a token. Returns invalid if no
   * password is configured.
   */
  loginWithPassword(input: {
    password: string;
    deviceName: string;
    platform: "ios" | "android" | "web" | "unknown";
  }): { token: string; device: DeviceRecord } | { error: AuthResult["reason"] } {
    const now = this.now();
    if (this.lockedUntil > now) return { error: "rate_limited" };
    if (!this.opts.password) return { error: "invalid" };
    if (!safeEqual(this.opts.password, input.password)) {
      this.registerFailure(now);
      return { error: "invalid" };
    }
    this.failedAttempts = 0;
    return this.mintToken(input.deviceName, input.platform, now);
  }

  private registerFailure(now: number): void {
    this.failedAttempts += 1;
    if (this.failedAttempts >= 5) {
      this.lockedUntil = now + 10 * 60_000;
      this.failedAttempts = 0;
    }
  }

  private mintToken(
    deviceName: string,
    platform: DeviceRecord["platform"],
    now: number,
  ): { token: string; device: DeviceRecord } {
    const token = randomToken(32);
    const device: DeviceRecord = {
      id: `dev_${randomToken(8)}`,
      name: deviceName,
      platform,
      pairedAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      revoked: false,
      tokenHash: sha256(token),
    };
    this.store.saveDevice(device);
    this.bus.emit("device:paired", device.id);
    return { token, device };
  }

  /** Verify a presented Bearer token (or `?token=` query). */
  verifyToken(token: string | undefined | null): DeviceRecord | null {
    if (!token) return null;
    const hash = sha256(token);
    const device = this.store.findDeviceByTokenHash(hash);
    if (!device) return null;
    if (device.revoked) return null;
    const now = this.now();
    // Idle expiry: a token not used within the window is auto-revoked, so a leaked-but-
    // abandoned token can't stay valid forever. Active devices slide the window on each use.
    const idleTtl = this.opts.tokenIdleTtlMs ?? 90 * 24 * 60 * 60_000;
    if (idleTtl > 0 && device.lastSeenAt) {
      const lastSeen = Date.parse(device.lastSeenAt);
      if (Number.isFinite(lastSeen) && now - lastSeen > idleTtl) {
        this.store.revokeDevice(device.id);
        return null;
      }
    }
    this.store.touchDevice(device.id, new Date(now).toISOString());
    return device;
  }

  listDevices(): DeviceRecord[] {
    return this.store.listDevices();
  }

  revokeDevice(id: string): void {
    this.store.revokeDevice(id);
  }

  revokeAll(): void {
    this.store.revokeAllDevices();
  }

  /**
   * Register a long-lived "self" token for the host application (e.g. a VS Code
   * extension that owns this process). Returns the plaintext token only once.
   */
  registerSelfToken(name = "vscode-host"): string {
    const token = randomToken(32);
    const device: DeviceRecord = {
      id: `self_${randomToken(6)}`,
      name,
      platform: "unknown",
      pairedAt: new Date(this.now()).toISOString(),
      lastSeenAt: new Date(this.now()).toISOString(),
      revoked: false,
      tokenHash: sha256(token),
    };
    this.store.saveDevice(device);
    return token;
  }
}
