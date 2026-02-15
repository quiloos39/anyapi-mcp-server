import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callApi } from "../src/api-client.js";
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
});
