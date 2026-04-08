import { describe, it, expect } from "vitest";
import {
  findPrimaryArray,
  findPrimaryArrayLength,
  truncateToTokenBudget,
  buildStatusMessage,
  findDeepestLargestArray,
  truncateDeepArray,
  estimateResultTokens,
} from "../src/token-budget.js";

describe("findPrimaryArray", () => {
  it("finds items array first", () => {
    const obj = { items: [1, 2, 3], other: [4, 5] };
    expect(findPrimaryArray(obj)).toEqual([1, 2, 3]);
  });

  it("falls back to first non-_ array field", () => {
    const obj = { _count: 5, products: [{ id: 1 }], tags: ["a"] };
    expect(findPrimaryArray(obj)).toEqual([{ id: 1 }]);
  });

  it("returns null when no arrays", () => {
    expect(findPrimaryArray({ id: 1, name: "test" })).toBeNull();
  });

  it("returns null for non-objects", () => {
    expect(findPrimaryArray(null)).toBeNull();
    expect(findPrimaryArray([1, 2])).toBeNull();
    expect(findPrimaryArray("string")).toBeNull();
  });

  it("skips _-prefixed array fields when items not present", () => {
    const obj = { _internal: [1, 2], data: [3, 4] };
    expect(findPrimaryArray(obj)).toEqual([3, 4]);
  });
});

describe("findPrimaryArrayLength", () => {
  it("returns length of primary array", () => {
    expect(findPrimaryArrayLength({ items: [1, 2, 3] })).toBe(3);
  });

  it("returns null when no arrays", () => {
    expect(findPrimaryArrayLength({ id: 1 })).toBeNull();
  });
});

describe("truncateToTokenBudget", () => {
  it("truncates large array to fit budget", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      description: `A somewhat long description for item number ${i} that adds tokens`,
    }));
    const obj = { items, _count: 100 };
    const { result, originalCount, keptCount } = truncateToTokenBudget(obj, 500);
    expect(keptCount).toBeLessThan(originalCount);
    expect(keptCount).toBeGreaterThanOrEqual(1);
    expect(originalCount).toBe(100);
    expect((result.items as unknown[]).length).toBe(keptCount);
  });

  it("keeps at least 1 item even with tiny budget", () => {
    const items = [{ id: 1, name: "test", data: "x".repeat(1000) }];
    const obj = { items };
    const { keptCount } = truncateToTokenBudget(obj, 10);
    expect(keptCount).toBe(1);
  });

  it("returns as-is when no array found", () => {
    const obj = { id: 1, name: "test" };
    const { result, originalCount, keptCount } = truncateToTokenBudget(obj, 100);
    expect(result).toEqual(obj);
    expect(originalCount).toBe(0);
    expect(keptCount).toBe(0);
  });

  it("returns as-is when array fits within budget", () => {
    const obj = { items: [{ id: 1 }, { id: 2 }] };
    const { result, originalCount, keptCount } = truncateToTokenBudget(obj, 10000);
    expect(keptCount).toBe(2);
    expect(originalCount).toBe(2);
    expect(result).toEqual(obj);
  });
});

describe("buildStatusMessage", () => {
  it("small response returns COMPLETE with item count", () => {
    const obj = { items: [{ id: 1 }, { id: 2 }], _count: 2 };
    const { status, result } = buildStatusMessage(obj, 10000);
    expect(status).toBe("COMPLETE (2 items)");
    expect(result).toEqual(obj);
  });

  it("large response returns TRUNCATED with counts", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      description: `Long description for item ${i} with lots of extra text to inflate token count`,
    }));
    const obj = { items, _count: 200 };
    const { status } = buildStatusMessage(obj, 500);
    expect(status).toContain("TRUNCATED");
    expect(status).toContain("of 200 items");
    expect(status).toContain("token budget 500");
    expect(status).toContain("_count");
  });

  it("non-array response returns COMPLETE", () => {
    const obj = { id: 1, name: "test" };
    const { status } = buildStatusMessage(obj, 10000);
    expect(status).toBe("COMPLETE");
  });

  it("non-object returns COMPLETE", () => {
    const { status } = buildStatusMessage("hello", 10000);
    expect(status).toBe("COMPLETE");
  });

  it("returns COMPLETE with no truncation when maxTokens is omitted", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      description: `Long description for item ${i} with lots of extra text to inflate token count`,
    }));
    const obj = { items, _count: 200 };
    const { status, result } = buildStatusMessage(obj);
    expect(status).toBe("COMPLETE (200 items)");
    expect((result as Record<string, unknown>).items).toHaveLength(200);
  });
});

describe("findDeepestLargestArray", () => {
  it("finds top-level array", () => {
    const obj = { data: [1, 2, 3] };
    const result = findDeepestLargestArray(obj);
    expect(result).not.toBeNull();
    expect(result!.path).toEqual(["data"]);
    expect(result!.array).toEqual([1, 2, 3]);
  });

  it("finds nested array over top-level", () => {
    const obj = {
      meta: { total: 5 },
      messages: { matches: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    };
    const result = findDeepestLargestArray(obj);
    expect(result).not.toBeNull();
    expect(result!.path).toEqual(["messages", "matches"]);
    expect(result!.array).toHaveLength(3);
  });

  it("picks largest by cost at same depth", () => {
    const obj = {
      wrapper: {
        small: [1],
        large: [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }],
      },
    };
    const result = findDeepestLargestArray(obj);
    expect(result).not.toBeNull();
    expect(result!.path).toEqual(["wrapper", "large"]);
  });

  it("skips _-prefixed keys", () => {
    const obj = { _internal: [1, 2, 3, 4, 5], data: [1] };
    const result = findDeepestLargestArray(obj);
    expect(result).not.toBeNull();
    expect(result!.path).toEqual(["data"]);
  });

  it("returns null for non-objects", () => {
    expect(findDeepestLargestArray(null)).toBeNull();
    expect(findDeepestLargestArray([1, 2])).toBeNull();
    expect(findDeepestLargestArray("string")).toBeNull();
  });

  it("returns null when no arrays found", () => {
    expect(findDeepestLargestArray({ id: 1, name: "test" })).toBeNull();
  });
});

describe("truncateDeepArray", () => {
  it("truncates nested array preserving parent structure", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      description: `A long description for item ${i} to inflate tokens`,
    }));
    const obj = { meta: { total: 100 }, messages: { matches: items } };
    const { result, originalCount, keptCount } = truncateDeepArray(obj, 500);
    expect(originalCount).toBe(100);
    expect(keptCount).toBeLessThan(100);
    expect(keptCount).toBeGreaterThanOrEqual(1);
    const r = result as Record<string, unknown>;
    expect((r.meta as Record<string, unknown>).total).toBe(100);
    const messages = r.messages as Record<string, unknown>;
    expect((messages.matches as unknown[]).length).toBe(keptCount);
  });

  it("returns as-is when no array found", () => {
    const obj = { id: 1, name: "test" };
    const { result, originalCount, keptCount } = truncateDeepArray(obj, 100);
    expect(result).toEqual(obj);
    expect(originalCount).toBe(0);
    expect(keptCount).toBe(0);
  });

  it("returns as-is when fits budget", () => {
    const obj = { data: [{ id: 1 }, { id: 2 }] };
    const { result, originalCount, keptCount } = truncateDeepArray(obj, 100000);
    expect(result).toEqual(obj);
    expect(originalCount).toBe(2);
    expect(keptCount).toBe(2);
  });

  it("does not mutate the original object", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      data: "x".repeat(100),
    }));
    const obj = { wrapper: { list: items } };
    const originalLength = obj.wrapper.list.length;
    truncateDeepArray(obj, 200);
    expect(obj.wrapper.list.length).toBe(originalLength);
  });
});

describe("estimateResultTokens", () => {
  it("returns a positive number for objects", () => {
    expect(estimateResultTokens({ id: 1, name: "test" })).toBeGreaterThan(0);
  });

  it("returns a positive number for arrays", () => {
    expect(estimateResultTokens([1, 2, 3])).toBeGreaterThan(0);
  });

  it("returns a positive number for strings", () => {
    expect(estimateResultTokens("hello world")).toBeGreaterThan(0);
  });

  it("larger objects have more tokens", () => {
    const small = { id: 1 };
    const large = { id: 1, name: "test", description: "a long description with many words" };
    expect(estimateResultTokens(large)).toBeGreaterThan(estimateResultTokens(small));
  });

  it("large response exceeds 10K token threshold", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      description: `A fairly long description for item number ${i} that adds token cost`,
    }));
    expect(estimateResultTokens({ items })).toBeGreaterThan(10000);
  });

  it("small response stays under 10K token threshold", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `item-${i}` }));
    expect(estimateResultTokens({ items })).toBeLessThan(10000);
  });
});
