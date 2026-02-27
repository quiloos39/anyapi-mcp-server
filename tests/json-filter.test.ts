import { describe, it, expect } from "vitest";
import { applyJsonFilter } from "../src/json-filter.js";

describe("applyJsonFilter", () => {
  it("simple dot-path", () => {
    expect(applyJsonFilter({ a: { b: 1 } }, "a.b")).toBe(1);
  });

  it("array traversal", () => {
    expect(
      applyJsonFilter({ data: [{ msg: "hi" }, { msg: "bye" }] }, "data[].msg")
    ).toEqual(["hi", "bye"]);
  });

  it("nested array traversal", () => {
    expect(
      applyJsonFilter(
        { data: [{ attrs: { msg: "hi" } }] },
        "data[].attrs.msg"
      )
    ).toEqual(["hi"]);
  });

  it("missing path returns null", () => {
    expect(applyJsonFilter({ a: 1 }, "b.c")).toBe(null);
  });

  it("non-object at segment returns null", () => {
    expect(applyJsonFilter({ a: "string" }, "a.b")).toBe(null);
  });

  it("empty filter returns data unchanged", () => {
    const data = { a: 1 };
    expect(applyJsonFilter(data, "")).toBe(data);
  });

  it("multiple [] segments (nested arrays)", () => {
    const data = {
      groups: [
        { items: [{ id: 1 }, { id: 2 }] },
        { items: [{ id: 3 }] },
      ],
    };
    expect(applyJsonFilter(data, "groups[].items[].id")).toEqual([
      [1, 2],
      [3],
    ]);
  });

  it("root [] on array input", () => {
    const data = [{ name: "a" }, { name: "b" }];
    expect(applyJsonFilter(data, "[].name")).toEqual(["a", "b"]);
  });

  it("[] on non-array returns null", () => {
    expect(applyJsonFilter({ data: "not-array" }, "data[].id")).toBe(null);
  });

  it("null data returns null", () => {
    expect(applyJsonFilter(null, "a.b")).toBe(null);
  });

  it("deep dot-path", () => {
    expect(
      applyJsonFilter({ a: { b: { c: { d: 42 } } } }, "a.b.c.d")
    ).toBe(42);
  });

  it("single segment", () => {
    expect(applyJsonFilter({ name: "test" }, "name")).toBe("test");
  });
});
