import { describe, it, expect } from "vitest";
import {
  truncateIfArray,
  buildSchemaFromData,
  getOrBuildSchema,
  schemaToSDL,
  executeQuery,
  computeShapeHash,
  collectJsonFields,
  computeFieldCosts,
} from "../src/graphql-schema.js";
import type { FieldCostNode } from "../src/graphql-schema.js";

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

describe("buildSchemaFromData - nested mutation input types", () => {
  const nestedBodySchema = {
    contentType: "application/json" as const,
    properties: {
      filter: {
        type: "object",
        required: false,
        properties: {
          query: { type: "string", required: false, description: "Search query" },
          from: { type: "string", required: false },
          to: { type: "string", required: false },
        },
        required_fields: ["query"],
      },
      page: {
        type: "object",
        required: false,
        properties: {
          cursor: { type: "string", required: false },
          limit: { type: "integer", required: false },
        },
      },
      sort: { type: "string", required: false },
    },
  };

  it("creates nested input types for object properties", () => {
    const data = { data: [] };
    const schema = buildSchemaFromData(data, "POST", "/test/nested-input", nestedBodySchema);
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("input POST_test_nested_input_Input_filter");
    expect(sdl).toContain("query: String!");
    expect(sdl).toContain("from: String");
    expect(sdl).toContain("to: String");
  });

  it("creates separate input type for each nested object", () => {
    const data = { data: [] };
    const schema = buildSchemaFromData(data, "POST", "/test/nested-sep", nestedBodySchema);
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("input POST_test_nested_sep_Input_filter");
    expect(sdl).toContain("input POST_test_nested_sep_Input_page");
    expect(sdl).toContain("cursor: String");
    expect(sdl).toContain("limit: Int");
  });

  it("keeps scalar properties as leaf types", () => {
    const data = {};
    const schema = buildSchemaFromData(data, "POST", "/test/nested-leaf", nestedBodySchema);
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("sort: String");
  });

  it("handles array-of-objects input type", () => {
    const arrayBodySchema = {
      contentType: "application/json" as const,
      properties: {
        requests: {
          type: "array",
          required: false,
          items: {
            type: "object",
            properties: {
              method: { type: "string", required: true },
              url: { type: "string", required: true },
            },
            required: ["method", "url"],
          },
        },
      },
    };
    const data = {};
    const schema = buildSchemaFromData(data, "POST", "/test/arr-obj-input", arrayBodySchema);
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("requests: [POST_test_arr_obj_input_Input_requests_Item]");
    expect(sdl).toContain("method: String!");
    expect(sdl).toContain("url: String!");
  });

  it("falls back to String at depth limit", () => {
    // Build a 7-level nested body schema (exceeds MAX_INPUT_DEPTH = 6)
    let innermost: Record<string, { type: string; required: boolean; properties?: Record<string, unknown> }> = {
      value: { type: "string", required: false },
    };
    for (let i = 0; i < 7; i++) {
      innermost = {
        nested: {
          type: "object",
          required: false,
          properties: innermost as unknown as Record<string, unknown>,
        } as unknown as typeof innermost["nested"],
      };
    }
    const deepSchema = {
      contentType: "application/json" as const,
      properties: innermost as unknown as Record<string, import("../src/types.js").RequestBodyProperty>,
    };
    const data = {};
    const schema = buildSchemaFromData(data, "POST", "/test/deep-input", deepSchema);
    const sdl = schemaToSDL(schema);
    // At some depth it should fall back to String instead of creating more input types
    expect(sdl).toContain("String");
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

describe("recursive array pagination", () => {
  it("caps nested arrays at default limit (50)", async () => {
    const data = {
      products: Array.from({ length: 3 }, (_, i) => ({
        id: i,
        tags: Array.from({ length: 100 }, (_, j) => `tag-${j}`),
      })),
    };
    const schema = buildSchemaFromData(data, "GET", "/test/nested-cap");
    const result = await executeQuery(schema, data, "{ products { id tags } }");
    const products = (result as Record<string, unknown[]>).products as Array<{ id: number; tags: string[] }>;
    expect(products).toHaveLength(3);
    for (const p of products) {
      expect(p.tags).toHaveLength(50);
    }
  });

  it("supports limit arg on nested list fields", async () => {
    const data = {
      products: Array.from({ length: 5 }, (_, i) => ({
        id: i,
        tags: Array.from({ length: 20 }, (_, j) => `tag-${j}`),
      })),
    };
    const schema = buildSchemaFromData(data, "GET", "/test/nested-limit");
    const result = await executeQuery(schema, data, "{ products(limit: 2) { id tags(limit: 3) } }");
    const products = (result as Record<string, unknown[]>).products as Array<{ id: number; tags: string[] }>;
    expect(products).toHaveLength(2);
    for (const p of products) {
      expect(p.tags).toHaveLength(3);
    }
  });

  it("supports offset arg on nested list fields", async () => {
    const data = {
      items: Array.from({ length: 10 }, (_, i) => ({ id: i })),
    };
    const schema = buildSchemaFromData(data, "GET", "/test/nested-offset");
    const result = await executeQuery(schema, data, "{ items(limit: 3, offset: 5) { id } }");
    const items = (result as Record<string, unknown[]>).items as Array<{ id: number }>;
    expect(items).toEqual([{ id: 5 }, { id: 6 }, { id: 7 }]);
  });

  it("caps arrays at multiple nesting levels independently", async () => {
    const data = {
      users: Array.from({ length: 60 }, (_, i) => ({
        id: i,
        tags: Array.from({ length: 80 }, (_, k) => `tag-${k}`),
      })),
    };
    const schema = buildSchemaFromData(data, "GET", "/test/deep-cap");
    const sdl = schemaToSDL(schema);
    // Extract the dynamic limits from SDL
    const usersMatch = sdl.match(/users\(limit: Int = (\d+)/);
    const tagsMatch = sdl.match(/tags\(limit: Int = (\d+)/);
    const usersLimit = parseInt(usersMatch![1], 10);
    const tagsLimit = parseInt(tagsMatch![1], 10);
    expect(usersLimit).toBeLessThanOrEqual(50);
    expect(tagsLimit).toBeLessThanOrEqual(50);

    const result = await executeQuery(
      schema, data,
      "{ users { id tags } }"
    );
    const users = (result as Record<string, unknown[]>).users as Array<{
      id: number;
      tags: string[];
    }>;
    expect(users).toHaveLength(usersLimit); // capped by dynamic limit
    for (const user of users) {
      expect(user.tags).toHaveLength(tagsLimit); // capped by dynamic limit
    }
  });

  it("does not truncate arrays under the default limit", async () => {
    const data = {
      users: Array.from({ length: 5 }, (_, i) => ({ id: i })),
    };
    const schema = buildSchemaFromData(data, "GET", "/test/no-cap");
    const result = await executeQuery(schema, data, "{ users { id } }");
    expect((result as Record<string, unknown[]>).users).toHaveLength(5);
  });

  it("caps top-level array items with default limit", async () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const schema = buildSchemaFromData(data, "GET", "/test/top-array-cap");
    const result = await executeQuery(schema, data, "{ items { id } _count }");
    const r = result as { items: Array<{ id: number }>; _count: number };
    expect(r.items).toHaveLength(50);
    expect(r._count).toBe(100); // _count reflects original size
  });

  it("supports limit/offset on top-level array items", async () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    const schema = buildSchemaFromData(data, "GET", "/test/top-array-paginate");
    const result = await executeQuery(schema, data, "{ items(limit: 3, offset: 5) { id } _count }");
    const r = result as { items: Array<{ id: number }>; _count: number };
    expect(r.items).toEqual([{ id: 5 }, { id: 6 }, { id: 7 }]);
    expect(r._count).toBe(20);
  });

  it("SDL includes limit/offset args on list fields", () => {
    const data = { tags: ["a", "b"] };
    const schema = buildSchemaFromData(data, "GET", "/test/sdl-args");
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("tags(limit: Int = 50, offset: Int = 0)");
  });

  it("uses lower default limit for complex array items", async () => {
    const complexItem = {
      id: 1, type: "log",
      attributes: {
        message: "hello", status: "info", service: "web",
        host: "i-abc", timestamp: "2024-01-01",
        http: { method: "GET", url: "/api", status_code: 200 },
        user: { id: "u1", name: "Alice", email: "a@b.com" },
        geo: { country: "US", city: "NYC", lat: 40.7, lng: -74.0 },
      },
    };
    // ~18 leaf fields → limit should be well below 50
    const data = Array.from({ length: 100 }, () => ({ ...complexItem }));
    const schema = buildSchemaFromData(data, "GET", "/test/dynamic-limit");
    const sdl = schemaToSDL(schema);
    const match = sdl.match(/items\(limit: Int = (\d+)/);
    expect(match).not.toBeNull();
    const limit = parseInt(match![1], 10);
    expect(limit).toBeLessThan(50);
    expect(limit).toBeGreaterThanOrEqual(3);

    // Verify the limit is actually applied in execution
    const result = await executeQuery(schema, data, "{ items { id } _count }");
    const r = result as { items: unknown[]; _count: number };
    expect(r.items).toHaveLength(limit);
    expect(r._count).toBe(100);
  });

  it("keeps high limit for very simple array items", () => {
    // Items with only tiny scalars should get a high limit
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const schema = buildSchemaFromData(data, "GET", "/test/simple-limit");
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("items(limit: Int = 50");
  });

  it("uses lower limit for long-string arrays (like k8s tags)", async () => {
    // Simulate Datadog-style tags: 30 strings averaging ~60 chars
    const tags = Array.from({ length: 30 }, (_, i) =>
      `kube_container_name:my-production-storefront-${i}-with-long-suffix`
    );
    const data = { tags };
    const schema = buildSchemaFromData(data, "GET", "/test/long-tags");
    const sdl = schemaToSDL(schema);
    const match = sdl.match(/tags\(limit: Int = (\d+)/);
    expect(match).not.toBeNull();
    const limit = parseInt(match![1], 10);
    // Long strings (~65 chars each ≈ 19 tokens) should get a much lower limit than 50
    expect(limit).toBeLessThan(15);
    expect(limit).toBeGreaterThanOrEqual(3);

    // Verify the limit is enforced
    const result = await executeQuery(schema, data, "{ tags }") as { tags: string[] };
    expect(result.tags).toHaveLength(limit);
  });
});

describe("deep inference (MAX_INFER_DEPTH = 8)", () => {
  it("infers typed fields at depth 6", async () => {
    const data = {
      a: { b: { c: { d: { e: { f: { value: 42 } } } } } },
    };
    const schema = buildSchemaFromData(data, "GET", "/test/deep6");
    const result = await executeQuery(
      schema, data,
      "{ a { b { c { d { e { f { value } } } } } } }"
    );
    expect(result).toEqual({ a: { b: { c: { d: { e: { f: { value: 42 } } } } } } });
  });

  it("falls back to JSON at depth 9", () => {
    // Build a 9-level deep object
    let obj: Record<string, unknown> = { leaf: "hello" };
    for (let i = 0; i < 9; i++) {
      obj = { nested: obj };
    }
    const schema = buildSchemaFromData(obj, "GET", "/test/deep9");
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("JSON");
  });

  it("merges heterogeneous array items with partially overlapping keys", async () => {
    const data = [
      { id: 1, name: "a", tags: ["x"] },
      { id: 2, score: 99.5 },
      { id: 3, name: "c", active: true },
    ];
    const schema = buildSchemaFromData(data, "GET", "/test/hetero-merge");
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("id");
    expect(sdl).toContain("name");
    expect(sdl).toContain("score");
    expect(sdl).toContain("active");
    expect(sdl).toContain("tags");
  });
});

describe("getOrBuildSchema - fromCache flag", () => {
  it("returns fromCache: false on first build", () => {
    const data = { id: 1 };
    const r = getOrBuildSchema(data, "GET", "/test/from-cache-flag-1");
    expect(r.fromCache).toBe(false);
  });

  it("returns fromCache: true on cache hit", () => {
    const data = { id: 1 };
    getOrBuildSchema(data, "GET", "/test/from-cache-flag-2");
    const r2 = getOrBuildSchema(data, "GET", "/test/from-cache-flag-2");
    expect(r2.fromCache).toBe(true);
  });
});

describe("field description on sanitized/colliding names", () => {
  it("sanitized field gets description with original name", () => {
    const data = { "my-field": "value", normal: "ok" };
    const schema = buildSchemaFromData(data, "GET", "/test/desc-sanitized");
    const sdl = schemaToSDL(schema);
    // SDL should include a description for the sanitized field
    expect(sdl).toContain('Original API field: "my-field"');
    expect(sdl).toContain("my_field: String");
    // "normal" field should NOT have a description
    expect(sdl).not.toContain('Original API field: "normal"');
  });

  it("collision between my-field and my_field gives _2 suffix + description", () => {
    const data = { "my-field": "a", "my_field": "b" };
    const schema = buildSchemaFromData(data, "GET", "/test/desc-collision");
    const sdl = schemaToSDL(schema);
    // Both get sanitized to my_field, second should get _2 suffix
    expect(sdl).toContain("my_field_2");
    // The colliding field should have a description
    expect(sdl).toContain("Original API field");
  });

  it("non-sanitized field gets no description", () => {
    const data = { name: "test", age: 30 };
    const schema = buildSchemaFromData(data, "GET", "/test/desc-no-desc");
    const sdl = schemaToSDL(schema);
    expect(sdl).not.toContain("Original API field");
  });
});

describe("collectJsonFields", () => {
  it("returns empty array when no JSON fields", () => {
    const schema = buildSchemaFromData({ id: 1, name: "test" }, "GET", "/test/no-json");
    expect(collectJsonFields(schema)).toEqual([]);
  });

  it("identifies mixed-type array fields as JSON", () => {
    const schema = buildSchemaFromData(
      { id: 1, mixed: ["string", 42, true] },
      "GET",
      "/test/json-mixed"
    );
    const fields = collectJsonFields(schema);
    expect(fields).toContain("mixed");
  });

  it("identifies deeply nested JSON fields with path", () => {
    // Create data deep enough to trigger JSON fallback (depth >= 8)
    let obj: Record<string, unknown> = { leaf: "hello" };
    for (let i = 0; i < 8; i++) {
      obj = { nested: obj };
    }
    const data = { wrapper: obj };
    const schema = buildSchemaFromData(data, "GET", "/test/json-deep");
    const fields = collectJsonFields(schema);
    expect(fields.length).toBeGreaterThan(0);
    // The deepest reachable nested field should be in the list
    expect(fields.some(f => f.includes("nested"))).toBe(true);
  });
});

describe("majority-type conflict resolution", () => {
  it("8 string + 2 number → infers String, not JSON", () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      value: i < 8 ? `text-${i}` : i * 100,
    }));
    const schema = buildSchemaFromData(data, "GET", "/test/majority-str");
    const sdl = schemaToSDL(schema);
    // 'value' should be String, not JSON
    expect(sdl).toContain("value: String");
    expect(sdl).not.toContain("value: JSON");
  });

  it("3 string + 3 number + 4 object → no majority → JSON", () => {
    const data = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: i, value: `text-${i}` })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: i + 3, value: i * 100 })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: i + 6, value: { nested: i } })),
    ];
    const schema = buildSchemaFromData(data, "GET", "/test/majority-none");
    const sdl = schemaToSDL(schema);
    // 'value' should be JSON since no type reaches 60%
    expect(sdl).toContain("value: JSON");
  });

  it("7 number + 3 string → infers numeric type, not JSON", async () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      score: i < 7 ? (i + 1) * 1.5 : `high-${i}`,
    }));
    const schema = buildSchemaFromData(data, "GET", "/test/majority-num");
    const sdl = schemaToSDL(schema);
    // 'score' should be Float, not JSON
    expect(sdl).toContain("score: Float");
    expect(sdl).not.toContain("score: JSON");
  });

  it("single-type fields unaffected", () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
    }));
    const schema = buildSchemaFromData(data, "GET", "/test/majority-single");
    const sdl = schemaToSDL(schema);
    expect(sdl).toContain("name: String");
    expect(sdl).not.toContain("JSON");
  });
});

describe("computeFieldCosts", () => {
  it("flat object: per-field costs sum to _total", () => {
    const data = { id: 1, name: "Alice", active: true };
    const costs = computeFieldCosts(data);
    expect(costs._total).toBeGreaterThan(0);
    const fieldSum = (costs.id as number) + (costs.name as number) + (costs.active as number);
    expect(costs._total).toBe(fieldSum);
  });

  it("array of objects: has _perItem, _avgLength, _total", () => {
    const data = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
      { id: 3, name: "Charlie" },
    ];
    const costs = computeFieldCosts(data);
    expect(costs._perItem).toBeGreaterThan(0);
    expect(costs._avgLength).toBe(3);
    expect(costs._total).toBe(costs._perItem! * 3);
  });

  it("nested objects: recursive tree structure", () => {
    const data = { user: { name: "Alice", address: { city: "NYC" } } };
    const costs = computeFieldCosts(data);
    expect(costs._total).toBeGreaterThan(0);
    const userCosts = costs.user as FieldCostNode;
    expect(userCosts).toBeDefined();
    expect(userCosts._total).toBeGreaterThan(0);
    const addressCosts = userCosts.address as FieldCostNode;
    expect(addressCosts).toBeDefined();
    expect(addressCosts._total).toBeGreaterThan(0);
  });

  it("empty array: _perItem=0, _avgLength=0", () => {
    const costs = computeFieldCosts([]);
    expect(costs._perItem).toBe(0);
    expect(costs._avgLength).toBe(0);
  });

  it("null/undefined: _total=1", () => {
    expect(computeFieldCosts(null)._total).toBe(1);
    expect(computeFieldCosts(undefined)._total).toBe(1);
  });

  it("scalar arrays: _perItem, _avgLength", () => {
    const data = ["hello", "world", "test"];
    const costs = computeFieldCosts(data);
    expect(costs._perItem).toBeGreaterThan(0);
    expect(costs._avgLength).toBe(3);
  });

  it("multi-sample averaging accuracy (varying string lengths)", () => {
    const data = [
      { id: 1, text: "short" },
      { id: 2, text: "a much longer string that takes more tokens" },
    ];
    const costs = computeFieldCosts(data);
    expect(costs._perItem).toBeGreaterThan(0);
    // Cost should reflect the average, not just the first item
    expect(costs._total).toBe(costs._perItem! * 2);
  });

  it("uses sanitized field names", () => {
    const data = { "my-field": "value", "another.field": 42 };
    const costs = computeFieldCosts(data);
    expect(costs.my_field).toBeDefined();
    expect(costs.another_field).toBeDefined();
  });
});
