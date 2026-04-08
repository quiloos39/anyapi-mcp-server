import { describe, it, expect } from "vitest";
import { detectArrayShrinkage } from "../src/write-safety.js";

describe("detectArrayShrinkage", () => {
  it("detects significant array shrinkage", () => {
    const body = { dashcards: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] };
    const backup = { dashcards: Array.from({ length: 30 }, (_, i) => ({ id: i })) };
    const warnings = detectArrayShrinkage(body, backup);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("dashcards");
    expect(warnings[0].bodyLength).toBe(4);
    expect(warnings[0].backupLength).toBe(30);
  });

  it("no warning when array only slightly smaller", () => {
    const body = { items: Array(25).fill({ id: 1 }) };
    const backup = { items: Array(30).fill({ id: 1 }) };
    const warnings = detectArrayShrinkage(body, backup);
    expect(warnings).toHaveLength(0); // 25/30 = 0.83 > 0.5
  });

  it("no warning when arrays are same size", () => {
    const body = { items: Array(10).fill({ id: 1 }) };
    const backup = { items: Array(10).fill({ id: 1 }) };
    expect(detectArrayShrinkage(body, backup)).toHaveLength(0);
  });

  it("no warning when body array is larger", () => {
    const body = { items: Array(15).fill({ id: 1 }) };
    const backup = { items: Array(10).fill({ id: 1 }) };
    expect(detectArrayShrinkage(body, backup)).toHaveLength(0);
  });

  it("detects shrinkage in nested object arrays", () => {
    const body = { dashboard: { cards: [{ id: 1 }] } };
    const backup = { dashboard: { cards: Array.from({ length: 20 }, (_, i) => ({ id: i })) } };
    const warnings = detectArrayShrinkage(body, backup);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("dashboard.cards");
    expect(warnings[0].bodyLength).toBe(1);
    expect(warnings[0].backupLength).toBe(20);
  });

  it("no warning for small backup arrays", () => {
    const body = { tags: ["a"] };
    const backup = { tags: ["a", "b", "c"] };
    expect(detectArrayShrinkage(body, backup)).toHaveLength(0); // backup.length < 5
  });

  it("respects custom threshold", () => {
    const body = { items: Array(6).fill(1) };
    const backup = { items: Array(10).fill(1) };
    // 6/10 = 0.6 — passes default 0.5 threshold but fails 0.8
    expect(detectArrayShrinkage(body, backup)).toHaveLength(0);
    expect(detectArrayShrinkage(body, backup, { threshold: 0.8 })).toHaveLength(1);
  });

  it("ignores non-array fields", () => {
    const body = { name: "new" };
    const backup = { name: "old", items: Array(30).fill({ id: 1 }) };
    expect(detectArrayShrinkage(body, backup)).toHaveLength(0);
  });

  it("returns empty for null/non-object backup", () => {
    expect(detectArrayShrinkage({ items: [] }, null)).toHaveLength(0);
    expect(detectArrayShrinkage({ items: [] }, "string")).toHaveLength(0);
    expect(detectArrayShrinkage({ items: [] }, [1, 2, 3])).toHaveLength(0);
  });

  it("detects multiple shrunk arrays", () => {
    const body = { cards: [{ id: 1 }], tabs: [{ id: 1 }] };
    const backup = { cards: Array(20).fill({ id: 1 }), tabs: Array(10).fill({ id: 1 }) };
    const warnings = detectArrayShrinkage(body, backup);
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.field).sort()).toEqual(["cards", "tabs"]);
  });

  it("works with cached data as baseline (simulating dataKey cache-hit path)", () => {
    const cachedData = { dashcards: Array.from({ length: 30 }, (_, i) => ({ id: i })), tabs: Array(5).fill({ id: 1 }) };
    const body = { dashcards: [{ id: 1 }, { id: 2 }], tabs: Array(5).fill({ id: 1 }) };
    const warnings = detectArrayShrinkage(body, cachedData);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("dashcards");
    expect(warnings[0].bodyLength).toBe(2);
    expect(warnings[0].backupLength).toBe(30);
  });

  it("no warning when body has array key absent from backup", () => {
    const body = { newField: Array(20).fill({ id: 1 }), name: "test" };
    const backup = { name: "old", existingItems: Array(30).fill({ id: 1 }) };
    expect(detectArrayShrinkage(body, backup)).toHaveLength(0);
  });
});
