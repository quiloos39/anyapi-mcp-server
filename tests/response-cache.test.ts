import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildCacheKey,
  getCached,
  consumeCached,
  setCache,
  evictExpired,
  clearCache,
} from "../src/response-cache.js";

beforeEach(() => {
  clearCache();
});

describe("buildCacheKey", () => {
  it("produces key from method + path", () => {
    const key = buildCacheKey("GET", "/users");
    expect(key).toBe("GET|/users");
  });

  it("includes sorted params", () => {
    const a = buildCacheKey("GET", "/users", { b: 1, a: 2 });
    const b = buildCacheKey("GET", "/users", { a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("includes sorted body", () => {
    const a = buildCacheKey("POST", "/users", undefined, { name: "a", age: 1 });
    const b = buildCacheKey("POST", "/users", undefined, { age: 1, name: "a" });
    expect(a).toBe(b);
  });

  it("includes sorted extraHeaders", () => {
    const a = buildCacheKey("GET", "/u", undefined, undefined, { z: "1", a: "2" });
    const b = buildCacheKey("GET", "/u", undefined, undefined, { a: "2", z: "1" });
    expect(a).toBe(b);
  });

  it("omits empty params/body/headers", () => {
    const a = buildCacheKey("GET", "/u");
    const b = buildCacheKey("GET", "/u", {}, {}, {});
    expect(a).toBe(b);
  });

  it("key changes when any component differs", () => {
    const a = buildCacheKey("GET", "/a");
    const b = buildCacheKey("GET", "/b");
    const c = buildCacheKey("POST", "/a");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("setCache / getCached", () => {
  it("stores and retrieves data", () => {
    setCache("k1", { value: 42 });
    expect(getCached("k1")).toEqual({ value: 42 });
  });

  it("returns undefined for missing key", () => {
    expect(getCached("missing")).toBeUndefined();
  });

  it("returns undefined for expired entry", () => {
    vi.useFakeTimers();
    setCache("k1", "data", 100);
    vi.advanceTimersByTime(150);
    expect(getCached("k1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("returns data before TTL expires", () => {
    vi.useFakeTimers();
    setCache("k1", "data", 100);
    vi.advanceTimersByTime(50);
    expect(getCached("k1")).toBe("data");
    vi.useRealTimers();
  });
});

describe("consumeCached", () => {
  it("returns data and removes entry", () => {
    setCache("k1", "data");
    expect(consumeCached("k1")).toBe("data");
    expect(getCached("k1")).toBeUndefined();
  });

  it("second call returns undefined", () => {
    setCache("k1", "data");
    consumeCached("k1");
    expect(consumeCached("k1")).toBeUndefined();
  });

  it("returns undefined for expired entry", () => {
    vi.useFakeTimers();
    setCache("k1", "data", 100);
    vi.advanceTimersByTime(150);
    expect(consumeCached("k1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("returns undefined for missing key", () => {
    expect(consumeCached("missing")).toBeUndefined();
  });
});

describe("evictExpired", () => {
  it("removes only expired entries", () => {
    vi.useFakeTimers();
    setCache("short", "a", 50);
    setCache("long", "b", 200);
    vi.advanceTimersByTime(100);
    evictExpired();
    expect(getCached("short")).toBeUndefined();
    expect(getCached("long")).toBe("b");
    vi.useRealTimers();
  });
});

describe("clearCache", () => {
  it("removes all entries", () => {
    setCache("a", 1);
    setCache("b", 2);
    clearCache();
    expect(getCached("a")).toBeUndefined();
    expect(getCached("b")).toBeUndefined();
  });
});
