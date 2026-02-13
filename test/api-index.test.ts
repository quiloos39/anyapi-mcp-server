import { describe, it, expect } from "vitest";
import { ApiIndex } from "../src/api-index.js";

const OPENAPI_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0" },
  paths: {
    "/pets": {
      get: {
        summary: "List pets",
        description: "Returns all pets",
        tags: ["pets"],
        parameters: [
          { name: "limit", in: "query", required: false, description: "Max items" },
        ],
        responses: { "200": { description: "Success" } },
      },
      post: {
        summary: "Create pet",
        tags: ["pets"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string", description: "Pet name" },
                  age: { type: "integer" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
    },
    "/pets/{petId}": {
      get: {
        summary: "Get pet by ID",
        tags: ["pets"],
        operationId: "getPetById",
        deprecated: true,
        externalDocs: { url: "https://docs.test/pets", description: "Pet docs" },
        parameters: [{ name: "petId", in: "path", required: true }],
      },
    },
    "/stores": {
      get: {
        summary: "List stores",
        tags: ["stores"],
      },
    },
    "/untagged-endpoint": {
      get: {
        summary: "No tag",
      },
    },
  },
});

const OPENAPI_YAML = `
openapi: "3.0.0"
info:
  title: YAML API
  version: "1.0"
paths:
  /items:
    get:
      summary: List items
      tags:
        - items
`;

const OPENAPI_WITH_REF = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Ref API", version: "1.0" },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          breed: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/pets": {
      post: {
        summary: "Create pet",
        tags: ["pets"],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
        },
      },
    },
  },
});

const POSTMAN_COLLECTION = JSON.stringify({
  info: {
    name: "Test Collection",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item: [
    {
      name: "Users",
      item: [
        {
          name: "List Users",
          request: {
            method: "GET",
            url: {
              raw: "https://api.test/users?page=1",
              host: ["api", "test"],
              path: ["users"],
              query: [{ key: "page", value: "1", description: "Page number" }],
            },
          },
        },
        {
          name: "Get User",
          request: {
            method: "GET",
            url: {
              raw: "https://api.test/users/:userId",
              host: ["api", "test"],
              path: ["users", ":userId"],
              variable: [{ key: "userId", value: "123", description: "User ID" }],
            },
          },
        },
      ],
    },
    {
      name: "Create Post",
      request: {
        method: "POST",
        url: "https://api.test/posts",
        body: { mode: "raw", raw: '{"title":"test"}' },
      },
    },
  ],
});

describe("ApiIndex - OpenAPI", () => {
  it("parses JSON OpenAPI spec", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const categories = index.listAllCategories();
    expect(categories.length).toBeGreaterThanOrEqual(2);
  });

  it("parses YAML OpenAPI spec", () => {
    const index = new ApiIndex(OPENAPI_YAML);
    const categories = index.listAllCategories();
    expect(categories).toEqual([{ tag: "items", endpointCount: 1 }]);
  });

  it("extracts method, path, summary, description, tag", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const ep = index.getEndpoint("GET", "/pets");
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
    expect(ep!.path).toBe("/pets");
    expect(ep!.summary).toBe("List pets");
    expect(ep!.description).toBe("Returns all pets");
    expect(ep!.tag).toBe("pets");
  });

  it("extracts parameters", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const ep = index.getEndpoint("GET", "/pets");
    expect(ep!.parameters).toEqual([
      { name: "limit", in: "query", required: false, description: "Max items" },
    ]);
  });

  it("detects hasRequestBody on POST", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const ep = index.getEndpoint("POST", "/pets");
    expect(ep!.hasRequestBody).toBe(true);
  });

  it("extracts requestBodySchema", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const ep = index.getEndpoint("POST", "/pets");
    expect(ep!.requestBodySchema).toBeDefined();
    expect(ep!.requestBodySchema!.properties.name.type).toBe("string");
    expect(ep!.requestBodySchema!.properties.name.required).toBe(true);
    expect(ep!.requestBodySchema!.properties.age.type).toBe("integer");
    expect(ep!.requestBodySchema!.properties.age.required).toBe(false);
  });

  it("resolves $ref in requestBody schema", () => {
    const index = new ApiIndex(OPENAPI_WITH_REF);
    const ep = index.getEndpoint("POST", "/pets");
    expect(ep!.requestBodySchema).toBeDefined();
    expect(ep!.requestBodySchema!.properties.name.type).toBe("string");
    expect(ep!.requestBodySchema!.properties.name.required).toBe(true);
    expect(ep!.requestBodySchema!.properties.breed.type).toBe("string");
  });

  it("extracts response descriptions", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const ep = index.getEndpoint("GET", "/pets");
    expect(ep!.responses).toEqual([{ statusCode: "200", description: "Success" }]);
  });

  it("extracts operationId, deprecated, externalDocs", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const ep = index.getEndpoint("GET", "/pets/{petId}");
    expect(ep!.operationId).toBe("getPetById");
    expect(ep!.deprecated).toBe(true);
    expect(ep!.externalDocs).toEqual({
      url: "https://docs.test/pets",
      description: "Pet docs",
    });
  });

  it("defaults tag to 'untagged'", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const ep = index.getEndpoint("GET", "/untagged-endpoint");
    expect(ep!.tag).toBe("untagged");
  });
});

describe("ApiIndex - Postman Collection", () => {
  it("parses Postman Collection", () => {
    const index = new ApiIndex(POSTMAN_COLLECTION);
    const categories = index.listAllCategories();
    expect(categories.length).toBeGreaterThanOrEqual(1);
  });

  it("uses folder names as tags", () => {
    const index = new ApiIndex(POSTMAN_COLLECTION);
    const eps = index.listAllByCategory("Users");
    expect(eps.length).toBe(2);
  });

  it("converts :param to {param}", () => {
    const index = new ApiIndex(POSTMAN_COLLECTION);
    const ep = index.getEndpoint("GET", "/users/{userId}");
    expect(ep).toBeDefined();
  });

  it("extracts query parameters", () => {
    const index = new ApiIndex(POSTMAN_COLLECTION);
    const ep = index.getEndpoint("GET", "/users");
    expect(ep!.parameters.some((p) => p.name === "page" && p.in === "query")).toBe(true);
  });

  it("extracts path variables", () => {
    const index = new ApiIndex(POSTMAN_COLLECTION);
    const ep = index.getEndpoint("GET", "/users/{userId}");
    expect(ep!.parameters.some((p) => p.name === "userId" && p.in === "path")).toBe(true);
  });

  it("detects hasRequestBody", () => {
    const index = new ApiIndex(POSTMAN_COLLECTION);
    const ep = index.getEndpoint("POST", "/posts");
    expect(ep!.hasRequestBody).toBe(true);
  });
});

describe("listAllCategories", () => {
  it("returns sorted categories with endpoint counts", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const categories = index.listAllCategories();
    // Should be sorted alphabetically
    const tags = categories.map((c) => c.tag);
    expect(tags).toEqual([...tags].sort());
    // Check counts
    const pets = categories.find((c) => c.tag === "pets");
    expect(pets!.endpointCount).toBe(3); // GET /pets, POST /pets, GET /pets/{petId}
  });
});

describe("listAllByCategory", () => {
  it("returns endpoints for existing category", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const eps = index.listAllByCategory("stores");
    expect(eps.length).toBe(1);
    expect(eps[0].path).toBe("/stores");
  });

  it("returns empty array for unknown category", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    expect(index.listAllByCategory("nonexistent")).toEqual([]);
  });
});

describe("searchAll", () => {
  it("matches by path", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const results = index.searchAll("stores");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toBe("/stores");
  });

  it("matches by summary", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const results = index.searchAll("Create pet");
    expect(results.length).toBe(1);
    expect(results[0].method).toBe("POST");
  });

  it("matches by description", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const results = index.searchAll("Returns all");
    expect(results.length).toBe(1);
  });

  it("is case-insensitive", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const results = index.searchAll("LIST PETS");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for no matches", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    expect(index.searchAll("zzz_nonexistent")).toEqual([]);
  });
});

describe("getEndpoint", () => {
  it("finds endpoint by method + path", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const ep = index.getEndpoint("GET", "/pets");
    expect(ep).toBeDefined();
  });

  it("returns undefined for non-existent endpoint", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    expect(index.getEndpoint("DELETE", "/pets")).toBeUndefined();
  });

  it("method matching is case-insensitive (uppercase)", () => {
    const index = new ApiIndex(OPENAPI_SPEC);
    const ep = index.getEndpoint("get", "/pets");
    // The method is stored as uppercase, so lowercase search should not match
    // unless the code uppercases the search. Let's check actual behavior:
    // getEndpoint does: ep.method === method.toUpperCase()
    expect(ep).toBeDefined();
  });
});
