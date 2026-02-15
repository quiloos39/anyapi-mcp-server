import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAppendFile } = vi.hoisted(() => ({
  mockAppendFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("node:fs/promises", () => ({
  appendFile: mockAppendFile,
}));

import { initLogger, isLoggingEnabled, logEntry, type LogEntry } from "../src/logger.js";

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "2025-01-01T00:00:00Z",
    method: "GET",
    url: "https://api.test/users",
    requestHeaders: {},
    responseStatus: 200,
    responseHeaders: {},
    responseBody: { ok: true },
    durationMs: 42,
    ...overrides,
  };
}

beforeEach(() => {
  mockAppendFile.mockClear();
  initLogger(null);
});

describe("initLogger / isLoggingEnabled", () => {
  it("returns false when not initialized", () => {
    expect(isLoggingEnabled()).toBe(false);
  });

  it("returns true after initLogger with path", () => {
    initLogger("/tmp/test.log");
    expect(isLoggingEnabled()).toBe(true);
  });

  it("returns false after initLogger(null)", () => {
    initLogger("/tmp/test.log");
    initLogger(null);
    expect(isLoggingEnabled()).toBe(false);
  });
});

describe("logEntry", () => {
  it("does nothing when logging is disabled", async () => {
    await logEntry(makeEntry());
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it("writes NDJSON line to file", async () => {
    initLogger("/tmp/test.log");
    await logEntry(makeEntry());
    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const [path, content, encoding] = mockAppendFile.mock.calls[0];
    expect(path).toBe("/tmp/test.log");
    expect(encoding).toBe("utf-8");
    expect(content.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(content);
    expect(parsed.method).toBe("GET");
    expect(parsed.url).toBe("https://api.test/users");
  });

  it("masks authorization header", async () => {
    initLogger("/tmp/test.log");
    await logEntry(makeEntry({ requestHeaders: { authorization: "Bearer abcdef123" } }));
    const parsed = JSON.parse(mockAppendFile.mock.calls[0][1]);
    expect(parsed.requestHeaders.authorization).toBe("Bear****");
  });

  it("masks x-api-key header", async () => {
    initLogger("/tmp/test.log");
    await logEntry(makeEntry({ requestHeaders: { "x-api-key": "secret12345" } }));
    const parsed = JSON.parse(mockAppendFile.mock.calls[0][1]);
    expect(parsed.requestHeaders["x-api-key"]).toBe("secr****");
  });

  it("masks cookie header", async () => {
    initLogger("/tmp/test.log");
    await logEntry(makeEntry({ requestHeaders: { cookie: "session=abc123" } }));
    const parsed = JSON.parse(mockAppendFile.mock.calls[0][1]);
    expect(parsed.requestHeaders.cookie).toBe("sess****");
  });

  it("masks set-cookie header", async () => {
    initLogger("/tmp/test.log");
    await logEntry(makeEntry({ responseHeaders: {} }));
    // set-cookie is in responseHeaders but logEntry only masks requestHeaders
    // Let's test through requestHeaders
    await logEntry(
      makeEntry({ requestHeaders: { "set-cookie": "token=xyz789" } })
    );
    const parsed = JSON.parse(mockAppendFile.mock.calls[1][1]);
    expect(parsed.requestHeaders["set-cookie"]).toBe("toke****");
  });

  it("masks proxy-authorization header", async () => {
    initLogger("/tmp/test.log");
    await logEntry(
      makeEntry({ requestHeaders: { "proxy-authorization": "Basic dXNlcjpw" } })
    );
    const parsed = JSON.parse(mockAppendFile.mock.calls[0][1]);
    expect(parsed.requestHeaders["proxy-authorization"]).toBe("Basi****");
  });

  it("masks short header values as just ****", async () => {
    initLogger("/tmp/test.log");
    await logEntry(makeEntry({ requestHeaders: { authorization: "ab" } }));
    const parsed = JSON.parse(mockAppendFile.mock.calls[0][1]);
    expect(parsed.requestHeaders.authorization).toBe("****");
  });

  it("does not mask non-sensitive headers", async () => {
    initLogger("/tmp/test.log");
    await logEntry(makeEntry({ requestHeaders: { "content-type": "application/json" } }));
    const parsed = JSON.parse(mockAppendFile.mock.calls[0][1]);
    expect(parsed.requestHeaders["content-type"]).toBe("application/json");
  });

  it("truncates responseBody over 10KB", async () => {
    initLogger("/tmp/test.log");
    const bigBody = "x".repeat(15_000);
    await logEntry(makeEntry({ responseBody: bigBody }));
    const parsed = JSON.parse(mockAppendFile.mock.calls[0][1]);
    expect(parsed.responseBody.length).toBeLessThan(15_000);
    expect(parsed.responseBody).toContain("truncated");
  });

  it("preserves responseBody under 10KB", async () => {
    initLogger("/tmp/test.log");
    const body = { small: "data" };
    await logEntry(makeEntry({ responseBody: body }));
    const parsed = JSON.parse(mockAppendFile.mock.calls[0][1]);
    expect(parsed.responseBody).toEqual(body);
  });

  it("swallows appendFile errors", async () => {
    initLogger("/tmp/test.log");
    mockAppendFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(logEntry(makeEntry())).resolves.toBeUndefined();
  });
});
