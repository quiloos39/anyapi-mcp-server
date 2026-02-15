import { describe, it, expect } from "vitest";
import {
  truncateIfArray,
  buildSchemaFromData,
  getOrBuildSchema,
  schemaToSDL,
  executeQuery,
  computeShapeHash,
} from "../src/graphql-schema.js";

describe("truncateIfArray", () => {
  it("returns non-array data unchanged", () => {
    const result = truncateIfArray({ a: 1 });
    expect(result).toEqual({ data: { a: 1 }, truncated: false, total: null });
  });

  it("slices array with default limit", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const result = truncateIfArray(arr);
    expect((result.data as number[]).length).toBe(50);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(100);
  });

  it("slices array with custom limit and offset", () => {
    const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const result = truncateIfArray(arr, 3, 2);
    expect(result.data).toEqual([2, 3, 4]);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(10);
  });

  it("returns truncated=false when array fits in limit", () => {
    const result = truncateIfArray([1, 2, 3], 10);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(3);
  });

  it("returns correct total", () => {
    const result = truncateIfArray([1, 2, 3, 4, 5], 2);
    expect(result.total).toBe(5);
  });
});

describe("buildSchemaFromData - object responses", () => {
  it("creates schema with scalar fields", async () => {
    const data = { name: "Alice", age: 30, score: 9.5, active: true };
    const schema = buildSchemaFromData(data, "GET", "/test/scalars");
    const result = await executeQuery(schema, data, "{ name age score active }");
    expect(result).toEqual({ name: "Alice", age: 30, score: 9.5, active: true });
  });

  it("creates schema with nested object fields", async () => {
    const data = { user: { name: "Bob", address: { city: "NYC" } } };
    const schema = buildSchemaFromData(data, "GET", "/test/nested");
    const result = await executeQuery(schema, data, "{ user { name address { city } } }");
    expect(result).toEqual({ user: { name: "Bob", address: { city: "NYC" } } });
  });

  it("handles null values as String type", () => {
    const data = { name: "Alice", optional: null };
    const schema = buildSchemaFromData(data, "GET", "/test/nulls");
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("optional");
  });

  it("sanitizes dashes in field names", async () => {
    const data = { "my-field": "value" };
    const schema = buildSchemaFromData(data, "GET", "/test/dash");
    const result = await executeQuery(schema, data, "{ my_field }");
    expect(result).toEqual({ my_field: "value" });
  });

  it("sanitizes dots in field names", async () => {
    const data = { "my.field": "value" };
    const schema = buildSchemaFromData(data, "GET", "/test/dot");
    const result = await executeQuery(schema, data, "{ my_field }");
    expect(result).toEqual({ my_field: "value" });
  });

  it("sanitizes leading digits in field names", async () => {
    const data = { "3items": "value" };
    const schema = buildSchemaFromData(data, "GET", "/test/digit");
    const result = await executeQuery(schema, data, "{ _3items }");
    expect(result).toEqual({ _3items: "value" });
  });
});

describe("buildSchemaFromData - array responses", () => {
  it("wraps as items + _count", async () => {
    const data = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ];
    const schema = buildSchemaFromData(data, "GET", "/test/array");
    const result = await executeQuery(schema, data, "{ items { id name } _count }");
    expect(result).toEqual({
      items: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
      _count: 2,
    });
  });

  it("handles empty array", () => {
    const data: unknown[] = [];
    const schema = buildSchemaFromData(data, "GET", "/test/empty-array");
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("items");
    expect(sdl).toContain("_count");
  });

  it("handles mixed-type arrays as JSON scalar", () => {
    const data = ["string", 42, { key: "val" }];
    const schema = buildSchemaFromData(data, "GET", "/test/mixed-array");
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("JSON");
  });

  it("handles array of scalars", async () => {
    const data = [1, 2, 3];
    const schema = buildSchemaFromData(data, "GET", "/test/scalar-array");
    const result = await executeQuery(schema, data, "{ items _count }");
    expect(result).toEqual({ items: [1, 2, 3], _count: 3 });
  });

  it("merges multiple samples for richer schema", async () => {
    const data = [
      { id: 1, name: "a" },
      { id: 2, name: "b", extra: "field" },
    ];
    const schema = buildSchemaFromData(data, "GET", "/test/merge-samples");
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("extra");
  });
});

describe("buildSchemaFromData - scalar responses", () => {
  it("wraps as { value }", async () => {
    const schema = buildSchemaFromData("hello", "GET", "/test/scalar-resp");
    const result = await executeQuery(schema, "hello", "{ value }");
    expect(result).toEqual({ value: "hello" });
  });
});

describe("buildSchemaFromData - mutation types", () => {
  const bodySchema = {
    contentType: "application/json" as const,
    properties: {
      name: { type: "string", required: true },
      age: { type: "integer", required: false },
    },
  };

  it("creates Mutation type for POST", () => {
    const schema = buildSchemaFromData({}, "POST", "/test/mut-post", bodySchema);
    expect(schema.getMutationType()).toBeDefined();
  });

  it("creates Mutation type for PUT", () => {
    const schema = buildSchemaFromData({}, "PUT", "/test/mut-put", bodySchema);
    expect(schema.getMutationType()).toBeDefined();
  });

  it("creates Mutation type for DELETE", () => {
    const schema = buildSchemaFromData({}, "DELETE", "/test/mut-del", bodySchema);
    expect(schema.getMutationType()).toBeDefined();
  });

  it("creates Mutation type for PATCH", () => {
    const schema = buildSchemaFromData({}, "PATCH", "/test/mut-patch", bodySchema);
    expect(schema.getMutationType()).toBeDefined();
  });

  it("no Mutation type for GET", () => {
    const schema = buildSchemaFromData({}, "GET", "/test/no-mut", bodySchema);
    expect(schema.getMutationType()).toBeUndefined();
  });

  it("marks required fields as NonNull in input type", () => {
    const schema = buildSchemaFromData({}, "POST", "/test/mut-required", bodySchema);
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("name: String!");
  });

  it("maps OpenAPI types to GraphQL input types", () => {
    const schema = buildSchemaFromData(
      {},
      "POST",
      "/test/mut-types",
      {
        contentType: "application/json",
        properties: {
          s: { type: "string", required: false },
          i: { type: "integer", required: false },
          n: { type: "number", required: false },
          b: { type: "boolean", required: false },
        },
      }
    );
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("s: String");
    expect(sdl).toContain("i: Int");
    expect(sdl).toContain("n: Float");
    expect(sdl).toContain("b: Boolean");
  });
});

describe("getOrBuildSchema", () => {
  it("caches schema by method + path + shape", () => {
    const data = { id: 1 };
    const r1 = getOrBuildSchema(data, "GET", "/test/cache-a2");
    const r2 = getOrBuildSchema(data, "GET", "/test/cache-a2");
    expect(r1.schema).toBe(r2.schema); // same reference
    expect(r1.shapeHash).toBe(r2.shapeHash);
  });

  it("different method+path produces different schema", () => {
    const data = { id: 1 };
    const r1 = getOrBuildSchema(data, "GET", "/test/cache-b2");
    const r2 = getOrBuildSchema(data, "POST", "/test/cache-b2");
    expect(r1.schema).not.toBe(r2.schema);
  });

  it("different shapes on same path produce different schemas", () => {
    const data1 = { id: 1, name: "Alice" };
    const data2 = { id: 2, score: 99, tags: ["a", "b"] };
    const r1 = getOrBuildSchema(data1, "GET", "/test/cache-shape");
    const r2 = getOrBuildSchema(data2, "GET", "/test/cache-shape");
    expect(r1.schema).not.toBe(r2.schema);
    expect(r1.shapeHash).not.toBe(r2.shapeHash);
  });

  it("same shape different values reuses cached schema", () => {
    const data1 = { id: 1, name: "Alice" };
    const data2 = { id: 2, name: "Bob" };
    const r1 = getOrBuildSchema(data1, "GET", "/test/cache-same");
    const r2 = getOrBuildSchema(data2, "GET", "/test/cache-same");
    expect(r1.schema).toBe(r2.schema);
    expect(r1.shapeHash).toBe(r2.shapeHash);
  });

  it("uses cacheHash for cache key when provided", () => {
    const data = { id: 1, status: "ok" };
    const bodyHash = computeShapeHash({ name: "test" });
    const r1 = getOrBuildSchema(data, "PUT", "/test/cache-body", undefined, bodyHash);
    const r2 = getOrBuildSchema(data, "PUT", "/test/cache-body", undefined, bodyHash);
    expect(r1.schema).toBe(r2.schema);
    expect(r1.shapeHash).toBe(r2.shapeHash);
  });

  it("returns a 12-character hex shapeHash", () => {
    const { shapeHash } = getOrBuildSchema({ id: 1 }, "GET", "/test/hash-fmt");
    expect(shapeHash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("computeShapeHash", () => {
  it("same structure different values produce same hash", () => {
    expect(computeShapeHash({ id: 1, name: "Alice" }))
      .toBe(computeShapeHash({ id: 42, name: "Bob" }));
  });

  it("different structure produces different hash", () => {
    expect(computeShapeHash({ id: 1, name: "Alice" }))
      .not.toBe(computeShapeHash({ id: 1, score: 99.5 }));
  });

  it("key order does not affect hash", () => {
    expect(computeShapeHash({ a: 1, b: "two" }))
      .toBe(computeShapeHash({ b: "hello", a: 42 }));
  });

  it("arrays with same element shape produce same hash", () => {
    expect(computeShapeHash([{ id: 1, name: "a" }]))
      .toBe(computeShapeHash([{ id: 3, name: "c" }]));
  });

  it("arrays with different element shapes produce different hash", () => {
    expect(computeShapeHash([{ id: 1, name: "a" }]))
      .not.toBe(computeShapeHash([{ id: 1, tags: ["x"] }]));
  });

  it("returns 12-char hex string", () => {
    expect(computeShapeHash({ x: 1 })).toMatch(/^[0-9a-f]{12}$/);
  });

  it("handles null and undefined", () => {
    expect(computeShapeHash(null)).toMatch(/^[0-9a-f]{12}$/);
    expect(computeShapeHash(undefined)).toMatch(/^[0-9a-f]{12}$/);
    expect(computeShapeHash(null)).toBe(computeShapeHash(undefined));
  });

  it("same scalar type produces same hash", () => {
    expect(computeShapeHash("hello")).toBe(computeShapeHash("world"));
    expect(computeShapeHash(1)).toBe(computeShapeHash(99));
  });
});

describe("mutation execution", () => {
  const bodySchema = {
    contentType: "application/json" as const,
    properties: {
      name: { type: "string", required: true },
      age: { type: "integer", required: false },
    },
  };

  it("executes mutation query on POST with object response", async () => {
    const data = { id: 1, name: "created", status: "ok" };
    const schema = buildSchemaFromData(data, "POST", "/test/exec-mut-post", bodySchema);
    const result = await executeQuery(
      schema, data,
      "mutation { post_POST_test_exec_mut_post { id name status } }"
    );
    expect(result).toEqual({
      post_POST_test_exec_mut_post: { id: 1, name: "created", status: "ok" },
    });
  });

  it("executes mutation query on PUT with object response", async () => {
    const data = { id: 1, name: "updated" };
    const schema = buildSchemaFromData(data, "PUT", "/test/exec-mut-put", bodySchema);
    const result = await executeQuery(
      schema, data,
      "mutation { put_PUT_test_exec_mut_put { id name } }"
    );
    expect(result).toEqual({
      put_PUT_test_exec_mut_put: { id: 1, name: "updated" },
    });
  });

  it("executes mutation query on DELETE with object response", async () => {
    const data = { deleted: true, id: 42 };
    const schema = buildSchemaFromData(data, "DELETE", "/test/exec-mut-del", bodySchema);
    const result = await executeQuery(
      schema, data,
      "mutation { delete_DELETE_test_exec_mut_del { deleted id } }"
    );
    expect(result).toEqual({
      delete_DELETE_test_exec_mut_del: { deleted: true, id: 42 },
    });
  });

  it("executes mutation query on PATCH with object response", async () => {
    const data = { id: 5, name: "patched" };
    const schema = buildSchemaFromData(data, "PATCH", "/test/exec-mut-patch", bodySchema);
    const result = await executeQuery(
      schema, data,
      "mutation { patch_PATCH_test_exec_mut_patch { id name } }"
    );
    expect(result).toEqual({
      patch_PATCH_test_exec_mut_patch: { id: 5, name: "patched" },
    });
  });

  it("executes mutation query on POST with array response", async () => {
    const data = [{ id: 1 }, { id: 2 }];
    const schema = buildSchemaFromData(data, "POST", "/test/exec-mut-arr", bodySchema);
    const result = await executeQuery(
      schema, data,
      "mutation { post_POST_test_exec_mut_arr { items { id } _count } }"
    );
    expect(result).toEqual({
      post_POST_test_exec_mut_arr: { items: [{ id: 1 }, { id: 2 }], _count: 2 },
    });
  });

  it("accepts input args in mutation without affecting result", async () => {
    const data = { id: 1, name: "created" };
    const schema = buildSchemaFromData(data, "POST", "/test/exec-mut-input", bodySchema);
    const result = await executeQuery(
      schema, data,
      'mutation { post_POST_test_exec_mut_input(input: { name: "test" }) { id name } }'
    );
    expect(result).toEqual({
      post_POST_test_exec_mut_input: { id: 1, name: "created" },
    });
  });

  it("write method without requestBodySchema uses Query syntax", async () => {
    const data = { id: 1, status: "deleted" };
    const schema = buildSchemaFromData(data, "DELETE", "/test/no-body-schema");
    expect(schema.getMutationType()).toBeUndefined();
    const result = await executeQuery(schema, data, "{ id status }");
    expect(result).toEqual({ id: 1, status: "deleted" });
  });

  it("POST without requestBodySchema uses Query syntax", async () => {
    const data = { id: 99, created: true };
    const schema = buildSchemaFromData(data, "POST", "/test/post-no-schema");
    expect(schema.getMutationType()).toBeUndefined();
    const result = await executeQuery(schema, data, "{ id created }");
    expect(result).toEqual({ id: 99, created: true });
  });

  it("mutation SDL includes input type name and fields", () => {
    const data = { id: 1 };
    const schema = buildSchemaFromData(data, "POST", "/api/users", bodySchema);
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("type Mutation");
    expect(sdl).toContain("POST_api_users_Input");
    expect(sdl).toContain("name: String!");
    expect(sdl).toContain("age: Int");
  });

  it("bodyHash discriminates cache for different bodies on same endpoint", () => {
    const data = { id: 1, status: "ok" };
    const bodyA = computeShapeHash({ name: "test" });
    const bodyB = computeShapeHash({ title: "post", count: 1 });
    const r1 = getOrBuildSchema(data, "POST", "/test/cache-body-disc", bodySchema, bodyA);
    const r2 = getOrBuildSchema(data, "POST", "/test/cache-body-disc", bodySchema, bodyB);
    expect(r1.schema).not.toBe(r2.schema);
    expect(bodyA).not.toBe(bodyB);
    // Same bodyHash reuses cache
    const r3 = getOrBuildSchema(data, "POST", "/test/cache-body-disc", bodySchema, bodyA);
    expect(r3.schema).toBe(r1.schema);
  });
});

describe("schemaToSDL", () => {
  it("returns valid SDL string", () => {
    const schema = buildSchemaFromData({ id: 1, name: "test" }, "GET", "/test/sdl");
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("type Query");
    expect(sdl).toContain("id:");
    expect(sdl).toContain("name:");
  });
});

describe("executeQuery", () => {
  it("executes simple field selection", async () => {
    const data = { id: 1, name: "test", extra: "ignore" };
    const schema = buildSchemaFromData(data, "GET", "/test/exec-simple");
    const result = await executeQuery(schema, data, "{ id name }");
    expect(result).toEqual({ id: 1, name: "test" });
  });

  it("wraps bare selection set in braces", async () => {
    const data = { id: 1 };
    const schema = buildSchemaFromData(data, "GET", "/test/exec-bare");
    const result = await executeQuery(schema, data, "id");
    expect(result).toEqual({ id: 1 });
  });

  it("handles query prefix", async () => {
    const data = { id: 1 };
    const schema = buildSchemaFromData(data, "GET", "/test/exec-prefix");
    const result = await executeQuery(schema, data, "query { id }");
    expect(result).toEqual({ id: 1 });
  });

  it("throws on invalid query", async () => {
    const data = { id: 1 };
    const schema = buildSchemaFromData(data, "GET", "/test/exec-invalid");
    await expect(executeQuery(schema, data, "{ nonexistent }")).rejects.toThrow(
      "GraphQL query error"
    );
  });
});
