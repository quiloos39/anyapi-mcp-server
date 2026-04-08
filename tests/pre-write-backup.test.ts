import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBackup, extractPathParamNames } from "../src/pre-write-backup.js";
import { _setResponseDirForTests, _clearAllForTests, loadResponse } from "../src/data-cache.js";

// Mock api-client
vi.mock("../src/api-client.js", () => ({
  callApi: vi.fn(),
}));

import { callApi } from "../src/api-client.js";
const mockCallApi = vi.mocked(callApi);

const baseConfig = {
  name: "test",
  specs: [],
  baseUrl: "https://api.example.com",
  headers: { "X-Api-Key": "test" },
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "backup-test-"));
  _setResponseDirForTests(tempDir);
  vi.clearAllMocks();
});

afterEach(() => {
  _clearAllForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createBackup", () => {
  it("returns a dataKey when GET succeeds for PATCH", async () => {
    mockCallApi.mockResolvedValue({
      data: { id: 1, html: "<h1>Original</h1>" },
      responseHeaders: { "content-type": "application/json" },
    });

    const key = await createBackup(baseConfig, "PATCH", "/templates/{id}", { id: "123" }, { "Authorization": "Bearer tok" });
    expect(key).toMatch(/^[0-9a-f]{8}$/);

    // Verify GET was called with correct args
    expect(mockCallApi).toHaveBeenCalledWith(
      baseConfig,
      "GET",
      "/templates/{id}",
      { id: "123" },
      undefined,
      { "Authorization": "Bearer tok" }
    );

    // Verify data is retrievable
    const loaded = loadResponse(key!);
    expect(loaded).not.toBeNull();
    expect(loaded!.data).toEqual({ id: 1, html: "<h1>Original</h1>" });
  });

  it("returns a dataKey when GET succeeds for PUT", async () => {
    mockCallApi.mockResolvedValue({
      data: { id: 2, name: "old" },
      responseHeaders: {},
    });

    const key = await createBackup(baseConfig, "PUT", "/items/{id}", { id: "2" });
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns undefined when GET fails (non-fatal)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockCallApi.mockRejectedValue(new Error("404 Not Found"));

    const key = await createBackup(baseConfig, "PATCH", "/missing/{id}", { id: "999" });
    expect(key).toBeUndefined();

    // Verify error was logged to stderr
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("pre-write-backup")
    );
    stderrSpy.mockRestore();
  });

  it("returns undefined for non-write methods", async () => {
    expect(await createBackup(baseConfig, "GET", "/items")).toBeUndefined();
    expect(await createBackup(baseConfig, "POST", "/items")).toBeUndefined();
    expect(await createBackup(baseConfig, "DELETE", "/items/{id}")).toBeUndefined();
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it("strips query params and only forwards path params to GET", async () => {
    mockCallApi.mockResolvedValue({
      data: { id: 123, items: Array(30).fill({ id: 1 }) },
      responseHeaders: {},
    });

    await createBackup(
      baseConfig, "PATCH", "/templates/{id}",
      { id: "123", limit: 10, filter: "active" }
    );

    expect(mockCallApi).toHaveBeenCalledWith(
      baseConfig,
      "GET",
      "/templates/{id}",
      { id: "123" },
      undefined,
      undefined
    );
  });

  it("strips all params when path has no path params", async () => {
    mockCallApi.mockResolvedValue({
      data: { items: [] },
      responseHeaders: {},
    });

    await createBackup(
      baseConfig, "PUT", "/settings",
      { format: "json", verbose: "true" }
    );

    expect(mockCallApi).toHaveBeenCalledWith(
      baseConfig,
      "GET",
      "/settings",
      undefined,
      undefined,
      undefined
    );
  });

  it("handles multiple path params correctly", async () => {
    mockCallApi.mockResolvedValue({
      data: { ok: true },
      responseHeaders: {},
    });

    await createBackup(
      baseConfig, "PUT", "/orgs/{orgId}/repos/{repoId}",
      { orgId: "acme", repoId: "42", page: 1, per_page: 50 }
    );

    expect(mockCallApi).toHaveBeenCalledWith(
      baseConfig,
      "GET",
      "/orgs/{orgId}/repos/{repoId}",
      { orgId: "acme", repoId: "42" },
      undefined,
      undefined
    );
  });
});

describe("extractPathParamNames", () => {
  it("extracts single param", () => {
    expect(extractPathParamNames("/items/{id}")).toEqual(new Set(["id"]));
  });

  it("extracts multiple params", () => {
    expect(extractPathParamNames("/orgs/{orgId}/repos/{repoId}")).toEqual(new Set(["orgId", "repoId"]));
  });

  it("returns empty set for no params", () => {
    expect(extractPathParamNames("/settings")).toEqual(new Set());
  });
});
