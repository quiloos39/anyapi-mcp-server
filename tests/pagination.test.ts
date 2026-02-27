import { describe, it, expect } from "vitest";
import { detectPagination, resolveParamName, PAGINATION_PARAM_NAMES } from "../src/pagination.js";
import type { ApiParameter } from "../src/types.js";

describe("detectPagination", () => {
  it("detects meta.page.after cursor from Datadog response", () => {
    const data = {
      data: [{ id: "log1", type: "log", attributes: { message: "test" } }],
      meta: { page: { after: "eyJhZnR..." }, elapsed: 58, status: "done" },
      links: { next: "https://app.datadoghq.eu/api/v2/logs/events?page%5Bcursor%5D=..." },
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.cursor).toBe("eyJhZnR...");
  });

  it("detects links.next URL from Datadog response", () => {
    const data = {
      data: [{ id: "log1" }],
      meta: { page: { after: "cursor123" } },
      links: { next: "https://app.datadoghq.eu/api/v2/logs/events?page%5Bcursor%5D=cursor123" },
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.nextUrl).toBe(
      "https://app.datadoghq.eu/api/v2/logs/events?page%5Bcursor%5D=cursor123"
    );
  });

  it("detects generic next_cursor", () => {
    const data = { results: [{ id: 1 }], next_cursor: "abc123" };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.cursor).toBe("abc123");
  });

  it("detects has_more boolean", () => {
    const data = { results: [{ id: 1 }], has_more: true };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.hasMore).toBe(true);
  });

  it("detects hasMore boolean", () => {
    const data = { items: [1, 2], hasMore: false };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.hasMore).toBe(false);
  });

  it("detects nextPageToken", () => {
    const data = { items: [{ id: 1 }], nextPageToken: "token_xyz" };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.nextPageToken).toBe("token_xyz");
  });

  it("detects paging.cursors.after (Facebook-style)", () => {
    const data = {
      data: [{ id: 1 }],
      paging: { cursors: { after: "afterCursor123" } },
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.cursor).toBe("afterCursor123");
  });

  it("detects pagination.next_cursor", () => {
    const data = {
      items: [{ id: 1 }],
      pagination: { next_cursor: "pg_cursor_456" },
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.cursor).toBe("pg_cursor_456");
  });

  it("detects _links.next.href (HAL-style)", () => {
    const data = {
      items: [{ id: 1 }],
      _links: { next: { href: "https://api.example.com/items?page=2" } },
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.nextUrl).toBe("https://api.example.com/items?page=2");
  });

  it("returns null for non-paginated response", () => {
    const data = { id: 1, name: "test" };
    expect(detectPagination(data)).toBeNull();
  });

  it("returns null for array responses", () => {
    expect(detectPagination([{ id: 1 }, { id: 2 }])).toBeNull();
  });

  it("returns null for null", () => {
    expect(detectPagination(null)).toBeNull();
  });

  it("returns null for scalar values", () => {
    expect(detectPagination("hello")).toBeNull();
    expect(detectPagination(42)).toBeNull();
  });

  it("hint text explains found fields", () => {
    const data = {
      data: [{ id: 1 }],
      meta: { page: { after: "cursor_val" } },
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!._hint).toContain("Pagination detected");
    expect(hint!._hint).toContain("query_api");
  });

  it("ignores empty string cursor values", () => {
    const data = { next_cursor: "" };
    expect(detectPagination(data)).toBeNull();
  });

  it("ignores non-boolean has_more values", () => {
    const data = { has_more: "yes" };
    expect(detectPagination(data)).toBeNull();
  });

  it("detects multiple pagination fields together", () => {
    const data = {
      data: [{ id: 1 }],
      meta: { page: { after: "cursorABC" } },
      links: { next: "https://example.com/next" },
      has_more: true,
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.cursor).toBe("cursorABC");
    expect(hint!.nextUrl).toBe("https://example.com/next");
    expect(hint!.hasMore).toBe(true);
  });

  // --- nextParams tests ---

  it("populates nextParams from cursor pattern", () => {
    const data = {
      data: [{ id: 1 }],
      meta: { page: { after: "eyJhZnR..." } },
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.nextParams).toBeDefined();
    // Default candidate for meta.page.after is page[cursor]
    expect(hint!.nextParams!["page[cursor]"]).toBe("eyJhZnR...");
  });

  it("resolves param name from spec parameters", () => {
    const data = {
      data: [{ id: 1 }],
      meta: { page: { after: "eyJhZnR..." } },
    };
    const specParams: ApiParameter[] = [
      { name: "page[after]", in: "query", required: false },
      { name: "page[size]", in: "query", required: false },
    ];
    const hint = detectPagination(data, specParams);
    expect(hint).not.toBeNull();
    expect(hint!.nextParams).toBeDefined();
    // Should pick page[after] since it matches a spec param
    expect(hint!.nextParams!["page[after]"]).toBe("eyJhZnR...");
  });

  it("falls back to first candidate when no spec params match", () => {
    const data = {
      data: [{ id: 1 }],
      meta: { page: { after: "eyJhZnR..." } },
    };
    const specParams: ApiParameter[] = [
      { name: "filter", in: "query", required: false },
    ];
    const hint = detectPagination(data, specParams);
    expect(hint).not.toBeNull();
    // Falls back to first candidate: page[cursor]
    expect(hint!.nextParams!["page[cursor]"]).toBe("eyJhZnR...");
  });

  it("parses nextUrl into nextParams", () => {
    const data = {
      items: [{ id: 1 }],
      _links: { next: { href: "https://api.example.com/items?page=2&per_page=25" } },
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.nextParams).toBeDefined();
    expect(hint!.nextParams!["page"]).toBe("2");
    expect(hint!.nextParams!["per_page"]).toBe("25");
  });

  it("populates nextParams for nextPageToken", () => {
    const data = { items: [{ id: 1 }], nextPageToken: "token_xyz" };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.nextParams).toBeDefined();
    // Default candidate for nextPageToken is pageToken
    expect(hint!.nextParams!["pageToken"]).toBe("token_xyz");
  });

  it("resolves nextPageToken param name from spec", () => {
    const data = { items: [{ id: 1 }], nextPageToken: "token_xyz" };
    const specParams: ApiParameter[] = [
      { name: "page_token", in: "query", required: false },
    ];
    const hint = detectPagination(data, specParams);
    expect(hint).not.toBeNull();
    expect(hint!.nextParams!["page_token"]).toBe("token_xyz");
  });

  it("works without specParams (backward compatible)", () => {
    const data = {
      data: [{ id: 1 }],
      meta: { page: { after: "cursor_val" } },
    };
    // Call without second argument
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.cursor).toBe("cursor_val");
    expect(hint!.nextParams).toBeDefined();
  });

  it("hint text includes nextParams JSON for actionable copy-paste", () => {
    const data = {
      data: [{ id: 1 }],
      meta: { page: { after: "cursor_val" } },
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!._hint).toContain("set params to include:");
    expect(hint!._hint).toContain("cursor_val");
  });

  it("has_more only does not produce nextParams", () => {
    const data = { results: [{ id: 1 }], has_more: true };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    // has_more alone has no cursor to build nextParams from
    expect(hint!.nextParams).toBeUndefined();
    // Falls back to old-style hint
    expect(hint!._hint).toContain("Pagination detected:");
  });

  it("merges cursor and nextUrl params together", () => {
    const data = {
      data: [{ id: 1 }],
      meta: { page: { after: "cursorABC" } },
      links: { next: "https://example.com/api?page%5Bcursor%5D=cursorABC&limit=50" },
    };
    const hint = detectPagination(data);
    expect(hint).not.toBeNull();
    expect(hint!.nextParams).toBeDefined();
    // Should have both cursor-derived and URL-derived params
    expect(hint!.nextParams!["limit"]).toBe("50");
  });
});

describe("resolveParamName", () => {
  it("returns matching spec param when available", () => {
    const specParams: ApiParameter[] = [
      { name: "cursor", in: "query", required: false },
    ];
    expect(resolveParamName(["page[cursor]", "cursor"], specParams)).toBe("cursor");
  });

  it("returns first candidate when no spec params match", () => {
    const specParams: ApiParameter[] = [
      { name: "filter", in: "query", required: false },
    ];
    expect(resolveParamName(["page[cursor]", "cursor"], specParams)).toBe("page[cursor]");
  });

  it("returns first candidate when no spec params provided", () => {
    expect(resolveParamName(["page[cursor]", "cursor"])).toBe("page[cursor]");
  });

  it("returns null for empty candidates", () => {
    expect(resolveParamName([])).toBeNull();
  });

  it("ignores non-query spec params", () => {
    const specParams: ApiParameter[] = [
      { name: "cursor", in: "header", required: false },
    ];
    expect(resolveParamName(["page[cursor]", "cursor"], specParams)).toBe("page[cursor]");
  });
});

describe("PAGINATION_PARAM_NAMES", () => {
  it("contains common pagination parameter names", () => {
    expect(PAGINATION_PARAM_NAMES.has("page")).toBe(true);
    expect(PAGINATION_PARAM_NAMES.has("cursor")).toBe(true);
    expect(PAGINATION_PARAM_NAMES.has("limit")).toBe(true);
    expect(PAGINATION_PARAM_NAMES.has("offset")).toBe(true);
    expect(PAGINATION_PARAM_NAMES.has("page[cursor]")).toBe(true);
    expect(PAGINATION_PARAM_NAMES.has("page_token")).toBe(true);
  });

  it("does not contain unrelated names", () => {
    expect(PAGINATION_PARAM_NAMES.has("filter")).toBe(false);
    expect(PAGINATION_PARAM_NAMES.has("sort")).toBe(false);
  });
});
