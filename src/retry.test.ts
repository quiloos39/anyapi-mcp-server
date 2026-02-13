import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isRetryableStatus, RetryableError, withRetry } from "./retry.js";

describe("isRetryableStatus", () => {
  it.each([429, 500, 502, 503, 504])("returns true for %d", (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([200, 201, 400, 401, 403, 404])("returns false for %d", (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});

describe("RetryableError", () => {
  it("has correct name property", () => {
    const err = new RetryableError("fail", 429);
    expect(err.name).toBe("RetryableError");
  });

  it("stores status and retryAfterMs", () => {
    const err = new RetryableError("fail", 503, 5000);
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBe(5000);
  });

  it("is instanceof Error", () => {
    const err = new RetryableError("fail", 500);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns value on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on RetryableError and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("fail", 429))
      .mockRejectedValueOnce(new RetryableError("fail", 500))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 });
    // Advance through two retry delays
    await vi.advanceTimersByTimeAsync(100); // attempt 0 delay: 100 * 2^0 + 0 = 100
    await vi.advanceTimersByTimeAsync(200); // attempt 1 delay: 100 * 2^1 + 0 = 200

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on TypeError", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws non-retryable errors immediately", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(withRetry(fn)).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after maxRetries exhausted", async () => {
    vi.useRealTimers();
    const fn = vi.fn(() => Promise.reject(new RetryableError("fail", 500)));

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 })
    ).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("respects maxRetries option", async () => {
    vi.useRealTimers();
    const fn = vi.fn(() => Promise.reject(new RetryableError("fail", 500)));

    await expect(
      withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 })
    ).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});
