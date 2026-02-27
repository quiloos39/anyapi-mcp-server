import { describe, it, expect, beforeEach, vi } from "vitest";
import { trackRateLimit, waitIfNeeded, resetTracker } from "../src/rate-limit-tracker.js";

beforeEach(() => {
  resetTracker();
});

describe("waitIfNeeded", () => {
  it("does not delay when untracked", async () => {
    const start = Date.now();
    await waitIfNeeded();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("does not delay when remaining > 1", async () => {
    trackRateLimit({ remaining: 10, limit: 100, resetAt: null });
    const start = Date.now();
    await waitIfNeeded();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("delays when remaining <= 1 with near-future reset (ISO)", async () => {
    const resetAt = new Date(Date.now() + 200).toISOString();
    trackRateLimit({ remaining: 1, limit: 100, resetAt });
    const start = Date.now();
    await waitIfNeeded();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1000);
  });

  it("delays when remaining is 0", async () => {
    const resetAt = new Date(Date.now() + 200).toISOString();
    trackRateLimit({ remaining: 0, limit: 100, resetAt });
    const start = Date.now();
    await waitIfNeeded();
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  it("does not delay after reset time has passed", async () => {
    const resetAt = new Date(Date.now() - 1000).toISOString();
    trackRateLimit({ remaining: 0, limit: 100, resetAt });
    const start = Date.now();
    await waitIfNeeded();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("caps wait time at 30s", async () => {
    // Use fake timers for this test to avoid actually waiting 30s
    vi.useFakeTimers();
    const resetAt = new Date(Date.now() + 120_000).toISOString(); // 2 min from now
    trackRateLimit({ remaining: 0, limit: 100, resetAt });

    const promise = waitIfNeeded();
    // Should cap at 30s, not 120s
    vi.advanceTimersByTime(30_000);
    await promise;

    vi.useRealTimers();
  });

  it("clears state after waiting", async () => {
    const resetAt = new Date(Date.now() + 100).toISOString();
    trackRateLimit({ remaining: 1, limit: 100, resetAt });
    await waitIfNeeded();

    // Second call should not delay
    const start = Date.now();
    await waitIfNeeded();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("parses seconds format (Ns)", async () => {
    trackRateLimit({ remaining: 0, limit: 100, resetAt: "1s" });
    const start = Date.now();
    await waitIfNeeded();
    const elapsed = Date.now() - start;
    // Should wait roughly 1 second (with some tolerance)
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(2000);
  });

  it("does not delay when resetAt is null", async () => {
    trackRateLimit({ remaining: 0, limit: 100, resetAt: null });
    const start = Date.now();
    await waitIfNeeded();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("does not delay when remaining is null", async () => {
    trackRateLimit({ remaining: null, limit: 100, resetAt: "30s" });
    const start = Date.now();
    await waitIfNeeded();
    expect(Date.now() - start).toBeLessThan(50);
  });
});
