import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  storeResponse,
  loadResponse,
  cleanupExpired,
  _setResponseDirForTests,
  _clearAllForTests,
} from "../src/data-cache.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "data-cache-test-"));
  _setResponseDirForTests(tempDir);
});

afterEach(() => {
  _clearAllForTests();
  rmSync(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("storeResponse", () => {
  it("returns an 8-char hex key", () => {
    const key = storeResponse("GET", "/users", [{ id: 1 }], {});
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns unique keys per call", () => {
    const k1 = storeResponse("GET", "/users", [{ id: 1 }], {});
    const k2 = storeResponse("GET", "/users", [{ id: 1 }], {});
    expect(k1).not.toBe(k2);
  });
});

describe("loadResponse", () => {
  it("returns stored data", () => {
    const data = [{ id: 1, name: "Alice" }];
    const headers = { "content-type": "application/json" };
    const key = storeResponse("GET", "/users", data, headers);
    const loaded = loadResponse(key);
    expect(loaded).not.toBeNull();
    expect(loaded!.method).toBe("GET");
    expect(loaded!.path).toBe("/users");
    expect(loaded!.data).toEqual(data);
    expect(loaded!.responseHeaders).toEqual(headers);
  });

  it("returns null for unknown key", () => {
    expect(loadResponse("deadbeef")).toBeNull();
  });

  it("returns null for expired entry", () => {
    vi.useFakeTimers();
    const key = storeResponse("GET", "/users", { ok: true }, {});
    // Advance past 5 min TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    expect(loadResponse(key)).toBeNull();
  });

  it("returns data before TTL expires", () => {
    vi.useFakeTimers();
    const key = storeResponse("GET", "/users", { ok: true }, {});
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(loadResponse(key)).not.toBeNull();
  });
});

describe("cleanupExpired", () => {
  it("removes only expired files", () => {
    vi.useFakeTimers();
    const k1 = storeResponse("GET", "/old", { old: true }, {});
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    const k2 = storeResponse("GET", "/new", { fresh: true }, {});

    cleanupExpired();

    expect(loadResponse(k1)).toBeNull();
    expect(loadResponse(k2)).not.toBeNull();
  });
});
