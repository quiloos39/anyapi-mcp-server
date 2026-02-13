import { describe, it, expect } from "vitest";
import { generateSuggestions } from "./query-suggestions.js";
import { buildSchemaFromData } from "./graphql-schema.js";
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
});
