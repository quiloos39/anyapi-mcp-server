import { describe, it, expect } from "vitest";
import { generateSuggestions } from "../src/query-suggestions.js";
import { buildSchemaFromData } from "../src/graphql-schema.js";
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from "graphql";

describe("generateSuggestions", () => {
  it("returns empty array for schema with no query type", () => {
    // Build a schema with no query type is not possible via GraphQLSchema constructor,
    // but we can test with a minimal schema that has no useful fields
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {},
      }),
    });
    const suggestions = generateSuggestions(schema);
    expect(suggestions).toEqual([]);
  });

  it("generates scalar fields suggestion for object response", () => {
    const data = { id: 1, name: "test", email: "test@example.com" };
    const schema = buildSchemaFromData(data, "GET", "/test/suggest-scalar");
    const suggestions = generateSuggestions(schema);
    const scalar = suggestions.find((s) => s.name === "All top-level scalar fields");
    expect(scalar).toBeDefined();
    expect(scalar!.query).toContain("id");
    expect(scalar!.query).toContain("name");
    expect(scalar!.query).toContain("email");
  });

  it("generates list suggestion for array fields", () => {
    const data = {
      users: [{ id: 1, name: "Alice" }],
      count: 1,
    };
    const schema = buildSchemaFromData(data, "GET", "/test/suggest-list");
    const suggestions = generateSuggestions(schema);
    const list = suggestions.find((s) => s.name.startsWith("List"));
    expect(list).toBeDefined();
    expect(list!.query).toContain("users");
  });

  it("generates items+count suggestion for array responses", () => {
    const data = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ];
    const schema = buildSchemaFromData(data, "GET", "/test/suggest-items");
    const suggestions = generateSuggestions(schema);
    const itemsCount = suggestions.find((s) => s.name === "Items with count");
    expect(itemsCount).toBeDefined();
    expect(itemsCount!.query).toContain("items");
    expect(itemsCount!.query).toContain("_count");
  });

  it("generates depth-2 full query suggestion", () => {
    const data = { id: 1, user: { name: "test", address: { city: "NYC" } } };
    const schema = buildSchemaFromData(data, "GET", "/test/suggest-depth");
    const suggestions = generateSuggestions(schema);
    const depth2 = suggestions.find((s) => s.name === "Full query (depth 2)");
    expect(depth2).toBeDefined();
    expect(depth2!.query).toContain("user");
  });

  it("generates mutation suggestion when mutation type exists", () => {
    const bodySchema = {
      contentType: "application/json" as const,
      properties: {
        name: { type: "string", required: true },
      },
    };
    const schema = buildSchemaFromData({ id: 1 }, "POST", "/test/suggest-mut", bodySchema);
    const suggestions = generateSuggestions(schema);
    const mutation = suggestions.find((s) => s.name.startsWith("Mutation:"));
    expect(mutation).toBeDefined();
    expect(mutation!.query).toContain("mutation");
  });

  it("mutation suggestion includes (input: { ... }) when args exist", () => {
    const bodySchema = {
      contentType: "application/json" as const,
      properties: {
        name: { type: "string", required: false },
      },
    };
    const schema = buildSchemaFromData({ id: 1 }, "POST", "/test/suggest-mut-args", bodySchema);
    const suggestions = generateSuggestions(schema);
    const mutation = suggestions.find((s) => s.name.startsWith("Mutation:"));
    expect(mutation!.query).toContain("(input: { ... })");
  });

  it("generates mutation suggestion for PUT", () => {
    const bodySchema = {
      contentType: "application/json" as const,
      properties: { name: { type: "string", required: false } },
    };
    const schema = buildSchemaFromData({ id: 1 }, "PUT", "/test/suggest-mut-put", bodySchema);
    const suggestions = generateSuggestions(schema);
    const mutation = suggestions.find((s) => s.name.startsWith("Mutation:"));
    expect(mutation).toBeDefined();
    expect(mutation!.query).toContain("mutation");
    expect(mutation!.query).toContain("put_");
  });

  it("generates mutation suggestion for DELETE", () => {
    const bodySchema = {
      contentType: "application/json" as const,
      properties: { id: { type: "integer", required: true } },
    };
    const schema = buildSchemaFromData({ deleted: true }, "DELETE", "/test/suggest-mut-del", bodySchema);
    const suggestions = generateSuggestions(schema);
    const mutation = suggestions.find((s) => s.name.startsWith("Mutation:"));
    expect(mutation).toBeDefined();
    expect(mutation!.query).toContain("delete_");
  });

  it("generates mutation suggestion for PATCH", () => {
    const bodySchema = {
      contentType: "application/json" as const,
      properties: { name: { type: "string", required: false } },
    };
    const schema = buildSchemaFromData({ id: 1, name: "patched" }, "PATCH", "/test/suggest-mut-patch", bodySchema);
    const suggestions = generateSuggestions(schema);
    const mutation = suggestions.find((s) => s.name.startsWith("Mutation:"));
    expect(mutation).toBeDefined();
    expect(mutation!.query).toContain("patch_");
  });

  it("mutation suggestion omits input args when properties are empty", () => {
    const bodySchema = {
      contentType: "application/json" as const,
      properties: {},
    };
    const schema = buildSchemaFromData({ id: 1 }, "POST", "/test/suggest-mut-empty", bodySchema);
    const suggestions = generateSuggestions(schema);
    const mutation = suggestions.find((s) => s.name.startsWith("Mutation:"));
    expect(mutation).toBeDefined();
    expect(mutation!.query).not.toContain("(input:");
  });
});

describe("generateSuggestions - JSON scalar handling", () => {
  it("excludes JSON fields from 'All top-level scalar fields' suggestion", () => {
    // mixed-type array → inferred as JSON scalar
    const data = { id: 1, name: "test", dynamic: ["string", 42, true] };
    const schema = buildSchemaFromData(data, "GET", "/test/json-suggest-1");
    const suggestions = generateSuggestions(schema);

    const scalarSuggestion = suggestions.find(
      (s) => s.name === "All top-level scalar fields"
    );
    expect(scalarSuggestion).toBeDefined();
    expect(scalarSuggestion!.query).toContain("id");
    expect(scalarSuggestion!.query).toContain("name");
    expect(scalarSuggestion!.query).not.toContain("dynamic");
  });

  it("generates 'Dynamic JSON fields' suggestion when JSON fields exist", () => {
    const data = { id: 1, attrs: ["string", 42, true] };
    const schema = buildSchemaFromData(data, "GET", "/test/json-suggest-2");
    const suggestions = generateSuggestions(schema);

    const jsonSuggestion = suggestions.find(
      (s) => s.name === "Dynamic JSON fields"
    );
    expect(jsonSuggestion).toBeDefined();
    expect(jsonSuggestion!.query).toContain("attrs");
    expect(jsonSuggestion!.description).toContain("dynamic JSON");
    expect(jsonSuggestion!.description).toContain("jsonFilter");
  });

  it("no 'Dynamic JSON fields' suggestion when no JSON fields", () => {
    const data = { id: 1, name: "test" };
    const schema = buildSchemaFromData(data, "GET", "/test/json-suggest-3");
    const suggestions = generateSuggestions(schema);

    const jsonSuggestion = suggestions.find(
      (s) => s.name === "Dynamic JSON fields"
    );
    expect(jsonSuggestion).toBeUndefined();
  });

  it("depth-limited query does not add (limit: 10) to JSON scalar lists", () => {
    // mixed array inside an object → JSON scalar
    const data = { id: 1, blob: { a: 1, b: "str", c: [1, "two"] } };
    const schema = buildSchemaFromData(data, "GET", "/test/json-suggest-5");
    const suggestions = generateSuggestions(schema);
    const depth2 = suggestions.find((s) => s.name === "Full query (depth 2)");
    expect(depth2).toBeDefined();
    // "c" is a JSON scalar, should not have (limit: 10)
    expect(depth2!.query).not.toMatch(/c\(limit:/);
  });
});
