import { describe, it, expect } from "vitest";
import {
  findPrimaryArray,
  findPrimaryArrayLength,
  truncateToTokenBudget,
  buildStatusMessage,
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

  it("uses default budget of 4000 when not specified", () => {
    const obj = { items: [{ id: 1 }] };
    const { status } = buildStatusMessage(obj);
    expect(status).toBe("COMPLETE (1 items)");
  });
});
