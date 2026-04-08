import { describe, it, expect } from "vitest";
import { applyPatch, type PatchOperation } from "../src/json-patch.js";

describe("applyPatch", () => {
  describe("replace", () => {
    it("replaces a top-level field", () => {
      const result = applyPatch({ name: "old" }, [
        { op: "replace", path: "/name", value: "new" },
      ]);
      expect(result.name).toBe("new");
    });

    it("replaces a nested field", () => {
      const result = applyPatch({ a: { b: { c: 1 } } }, [
        { op: "replace", path: "/a/b/c", value: 2 },
      ]);
      expect((result.a as Record<string, unknown>).b).toEqual({ c: 2 });
    });

    it("replaces an array element", () => {
      const result = applyPatch({ items: ["a", "b", "c"] }, [
        { op: "replace", path: "/items/1", value: "B" },
      ]);
      expect(result.items).toEqual(["a", "B", "c"]);
    });

    it("throws on non-existent key", () => {
      expect(() =>
        applyPatch({ name: "test" }, [
          { op: "replace", path: "/missing", value: "x" },
        ])
      ).toThrow("non-existent key");
    });

    it("throws without value", () => {
      expect(() =>
        applyPatch({ name: "test" }, [{ op: "replace", path: "/name" }] as PatchOperation[])
      ).toThrow("'value' is required");
    });
  });

  describe("add", () => {
    it("adds a new field to an object", () => {
      const result = applyPatch({ a: 1 }, [
        { op: "add", path: "/b", value: 2 },
      ]);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("overwrites an existing field", () => {
      const result = applyPatch({ a: 1 }, [
        { op: "add", path: "/a", value: 99 },
      ]);
      expect(result.a).toBe(99);
    });

    it("appends to array with -", () => {
      const result = applyPatch({ tags: ["a", "b"] }, [
        { op: "add", path: "/tags/-", value: "c" },
      ]);
      expect(result.tags).toEqual(["a", "b", "c"]);
    });

    it("inserts into array at index", () => {
      const result = applyPatch({ items: [1, 2, 3] }, [
        { op: "add", path: "/items/1", value: 99 },
      ]);
      expect(result.items).toEqual([1, 99, 2, 3]);
    });

    it("throws without value", () => {
      expect(() =>
        applyPatch({}, [{ op: "add", path: "/x" }] as PatchOperation[])
      ).toThrow("'value' is required");
    });
  });

  describe("remove", () => {
    it("removes a field from an object", () => {
      const result = applyPatch({ a: 1, b: 2 }, [
        { op: "remove", path: "/b" },
      ]);
      expect(result).toEqual({ a: 1 });
    });

    it("removes an array element", () => {
      const result = applyPatch({ items: [1, 2, 3] }, [
        { op: "remove", path: "/items/1" },
      ]);
      expect(result.items).toEqual([1, 3]);
    });

    it("throws on non-existent key", () => {
      expect(() =>
        applyPatch({ a: 1 }, [{ op: "remove", path: "/missing" }])
      ).toThrow("non-existent key");
    });

    it("throws on out-of-bounds array index", () => {
      expect(() =>
        applyPatch({ items: [1] }, [{ op: "remove", path: "/items/5" }])
      ).toThrow("out of bounds");
    });
  });

  describe("multiple operations", () => {
    it("applies operations in sequence", () => {
      const result = applyPatch(
        { name: "old", tags: ["a"], count: 1 },
        [
          { op: "replace", path: "/name", value: "new" },
          { op: "add", path: "/tags/-", value: "b" },
          { op: "remove", path: "/count" },
        ]
      );
      expect(result).toEqual({ name: "new", tags: ["a", "b"] });
    });

    it("later operations see earlier changes", () => {
      const result = applyPatch({ items: [1, 2, 3] }, [
        { op: "remove", path: "/items/0" },
        { op: "replace", path: "/items/0", value: 99 },
      ]);
      // After remove [0]: [2, 3], then replace [0]: [99, 3]
      expect(result.items).toEqual([99, 3]);
    });
  });

  describe("does not mutate original", () => {
    it("returns a new object", () => {
      const original = { a: 1, nested: { b: 2 } };
      const result = applyPatch(original, [
        { op: "replace", path: "/nested/b", value: 99 },
      ]);
      expect(original.nested.b).toBe(2);
      expect((result.nested as Record<string, unknown>).b).toBe(99);
    });
  });

  describe("path parsing", () => {
    it("handles escaped characters (~0 and ~1)", () => {
      const result = applyPatch({ "a/b": 1, "c~d": 2 }, [
        { op: "replace", path: "/a~1b", value: 10 },
        { op: "replace", path: "/c~0d", value: 20 },
      ]);
      expect(result["a/b"]).toBe(10);
      expect(result["c~d"]).toBe(20);
    });

    it("throws on invalid pointer (no leading /)", () => {
      expect(() =>
        applyPatch({}, [{ op: "add", path: "bad", value: 1 }])
      ).toThrow("must start with '/'");
    });

    it("throws when targeting root", () => {
      expect(() =>
        applyPatch({}, [{ op: "replace", path: "", value: {} }])
      ).toThrow("cannot target root");
    });
  });

  describe("nested array operations", () => {
    it("replaces field in nested array object", () => {
      const result = applyPatch(
        { panels: [{ id: 1, title: "A" }, { id: 2, title: "B" }] },
        [{ op: "replace", path: "/panels/1/title", value: "Updated" }]
      );
      expect((result.panels as Record<string, unknown>[])[1].title).toBe("Updated");
    });

    it("adds to nested array", () => {
      const result = applyPatch(
        { config: { tags: ["prod"] } },
        [{ op: "add", path: "/config/tags/-", value: "staging" }]
      );
      expect((result.config as Record<string, unknown>).tags).toEqual(["prod", "staging"]);
    });
  });
});
