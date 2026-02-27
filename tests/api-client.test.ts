import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callApi, parseRateLimits } from "../src/api-client.js";
import { ApiError } from "../src/error-context.js";
import type { AnyApiConfig } from "../src/config.js";

const baseConfig: AnyApiConfig = {
  name: "test",
  specs: [],
  baseUrl: "https://api.test",
  headers: {},
};

describe("callApi - query parameters for non-GET methods", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends remaining params as query string for POST", async () => {
    await callApi(baseConfig, "POST", "/items", { notify: "true" }, { title: "test" });
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe("https://api.test/items?notify=true");
  });

  it("appends remaining params as query string for DELETE", async () => {
    await callApi(baseConfig, "DELETE", "/items/{id}", { id: "123", force: "true" });
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe("https://api.test/items/123?force=true");
  });

  it("appends remaining params as query string for PUT", async () => {
    await callApi(baseConfig, "PUT", "/items/{id}", { id: "5", upsert: "true" }, { name: "updated" });
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe("https://api.test/items/5?upsert=true");
  });

  it("appends remaining params as query string for PATCH", async () => {
    await callApi(baseConfig, "PATCH", "/items/{id}", { id: "7", partial: "true" }, { name: "patched" });
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe("https://api.test/items/7?partial=true");
  });

  it("still appends query params for GET (regression)", async () => {
    await callApi(baseConfig, "GET", "/items", { page: "2", limit: "10" });
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe("https://api.test/items?page=2&limit=10");
  });

  it("sends body as JSON for non-GET methods", async () => {
    await callApi(baseConfig, "POST", "/items", undefined, { title: "test" });
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.body).toBe('{"title":"test"}');
  });

  it("does not send body for GET even if provided", async () => {
    await callApi(baseConfig, "GET", "/items", undefined, { title: "test" });
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.body).toBeUndefined();
  });

  it("sends body for DELETE when provided", async () => {
    await callApi(baseConfig, "DELETE", "/items/{id}", { id: "1" }, { reason: "cleanup" });
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.body).toBe('{"reason":"cleanup"}');
  });

  it("returns data and responseHeaders", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-request-id": "abc" },
      })
    );
    const result = await callApi(baseConfig, "GET", "/items");
    expect(result.data).toEqual({ id: 1 });
    expect(result.responseHeaders["x-request-id"]).toBe("abc");
  });
});

describe("callApi - error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws ApiError with full context for non-retryable HTTP errors", async () => {
    const errorBody = JSON.stringify({ message: "User not found" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(errorBody, {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json", "x-request-id": "req-123" },
      })
    );

    try {
      await callApi(baseConfig, "GET", "/users/{id}", { id: "999" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.statusText).toBe("Not Found");
      expect(apiErr.bodyText).toBe(errorBody);
      expect(apiErr.responseHeaders["x-request-id"]).toBe("req-123");
    }
  });

  it("throws ApiError for 400 with structured body", async () => {
    const errorBody = JSON.stringify({ error: { message: "Invalid email", code: "validation_error" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(errorBody, { status: 400, statusText: "Bad Request" })
    );

    await expect(callApi(baseConfig, "POST", "/users", undefined, { email: "bad" }))
      .rejects.toThrow(ApiError);
  });

});

describe("parseRateLimits", () => {
  it("parses x-ratelimit-* headers", () => {
    const rl = parseRateLimits({
      "x-ratelimit-remaining": "5",
      "x-ratelimit-limit": "100",
      "x-ratelimit-reset": "1700000000",
    });
    expect(rl).not.toBeNull();
    expect(rl!.remaining).toBe(5);
    expect(rl!.limit).toBe(100);
    expect(rl!.resetAt).toMatch(/^\d{4}-/); // ISO date
  });

  it("parses ratelimit-* headers (IETF draft)", () => {
    const rl = parseRateLimits({
      "ratelimit-remaining": "10",
      "ratelimit-limit": "60",
    });
    expect(rl).not.toBeNull();
    expect(rl!.remaining).toBe(10);
    expect(rl!.limit).toBe(60);
    expect(rl!.resetAt).toBeNull();
  });

  it("parses x-rate-limit-* headers (hyphenated)", () => {
    const rl = parseRateLimits({
      "x-rate-limit-remaining": "0",
      "x-rate-limit-limit": "3",
      "x-rate-limit-reset": "30",
    });
    expect(rl).not.toBeNull();
    expect(rl!.remaining).toBe(0);
    expect(rl!.limit).toBe(3);
    expect(rl!.resetAt).toBe("30s"); // seconds, not unix timestamp
  });

  it("returns null when no rate limit headers present", () => {
    expect(parseRateLimits({ "content-type": "application/json" })).toBeNull();
  });

  it("handles case-insensitive headers", () => {
    const rl = parseRateLimits({ "X-RateLimit-Remaining": "7" });
    expect(rl).not.toBeNull();
    expect(rl!.remaining).toBe(7);
  });
});
