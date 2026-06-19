// Tiny in-memory fixed-window rate limiter. Guards billable/expensive routes (session
// spawn, ASR, push) from being hammered into runaway cost by a single caller. Per-process,
// best-effort — not a security boundary, just an abuse cap.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** True if `key` has exceeded `max` hits within `windowMs` (and should be rejected). */
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    sweep(now);
    return false;
  }
  if (b.count >= max) return true;
  b.count += 1;
  return false;
}

// Drop expired buckets so the map can't grow without bound. Only runs when it's worth it.
let lastSweep = 0;
function sweep(now: number): void {
  if (buckets.size < 500 || now - lastSweep < 30_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(k);
  }
}

/** Test hook: clear all windows. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}
