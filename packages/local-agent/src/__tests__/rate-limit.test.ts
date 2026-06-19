import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { rateLimited, resetRateLimits } from "../rate-limit.js";

describe("rateLimited", () => {
  beforeEach(() => resetRateLimits());
  afterEach(() => vi.useRealTimers());

  it("allows up to max hits then blocks within the window", () => {
    for (let i = 0; i < 3; i++) expect(rateLimited("k", 3, 1000)).toBe(false);
    expect(rateLimited("k", 3, 1000)).toBe(true);
    expect(rateLimited("k", 3, 1000)).toBe(true);
  });

  it("tracks keys independently", () => {
    expect(rateLimited("a", 1, 1000)).toBe(false);
    expect(rateLimited("a", 1, 1000)).toBe(true);
    expect(rateLimited("b", 1, 1000)).toBe(false); // different key unaffected
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    expect(rateLimited("k", 1, 1000)).toBe(false);
    expect(rateLimited("k", 1, 1000)).toBe(true);
    vi.setSystemTime(1001);
    expect(rateLimited("k", 1, 1000)).toBe(false); // window rolled over
  });
});
