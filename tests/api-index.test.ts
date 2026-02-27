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
    const index = new ApiIndex([OPENAPI_SPEC]);
    const categories = index.listAllCategories();
    expect(categories.length).toBeGreaterThanOrEqual(2);
  });

  it("parses YAML OpenAPI spec", () => {
    const index = new ApiIndex([OPENAPI_YAML]);
    const categories = index.listAllCategories();
    expect(categories).toEqual([{ tag: "items", endpointCount: 1 }]);
  });

  it("extracts method, path, summary, description, tag", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const ep = index.getEndpoint("GET", "/pets");
    expect(ep).toBeDefined();
    expect(ep!.method).toBe("GET");
    expect(ep!.path).toBe("/pets");
    expect(ep!.summary).toBe("List pets");
    expect(ep!.description).toBe("Returns all pets");
    expect(ep!.tag).toBe("pets");
  });

  it("extracts parameters", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const ep = index.getEndpoint("GET", "/pets");
    expect(ep!.parameters).toEqual([
      { name: "limit", in: "query", required: false, description: "Max items" },
    ]);
  });

  it("detects hasRequestBody on POST", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const ep = index.getEndpoint("POST", "/pets");
    expect(ep!.hasRequestBody).toBe(true);
  });

  it("extracts requestBodySchema", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const ep = index.getEndpoint("POST", "/pets");
    expect(ep!.requestBodySchema).toBeDefined();
    expect(ep!.requestBodySchema!.properties.name.type).toBe("string");
    expect(ep!.requestBodySchema!.properties.name.required).toBe(true);
    expect(ep!.requestBodySchema!.properties.age.type).toBe("integer");
    expect(ep!.requestBodySchema!.properties.age.required).toBe(false);
  });

  it("resolves $ref in requestBody schema", () => {
    const index = new ApiIndex([OPENAPI_WITH_REF]);
    const ep = index.getEndpoint("POST", "/pets");
    expect(ep!.requestBodySchema).toBeDefined();
    expect(ep!.requestBodySchema!.properties.name.type).toBe("string");
    expect(ep!.requestBodySchema!.properties.name.required).toBe(true);
    expect(ep!.requestBodySchema!.properties.breed.type).toBe("string");
  });

  it("extracts response descriptions", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const ep = index.getEndpoint("GET", "/pets");
    expect(ep!.responses).toEqual([{ statusCode: "200", description: "Success" }]);
  });

  it("extracts operationId, deprecated, externalDocs", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const ep = index.getEndpoint("GET", "/pets/{petId}");
    expect(ep!.operationId).toBe("getPetById");
    expect(ep!.deprecated).toBe(true);
    expect(ep!.externalDocs).toEqual({
      url: "https://docs.test/pets",
      description: "Pet docs",
    });
  });

  it("defaults tag to 'untagged'", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const ep = index.getEndpoint("GET", "/untagged-endpoint");
    expect(ep!.tag).toBe("untagged");
  });
});

describe("ApiIndex - Postman Collection", () => {
  it("parses Postman Collection", () => {
    const index = new ApiIndex([POSTMAN_COLLECTION]);
    const categories = index.listAllCategories();
    expect(categories.length).toBeGreaterThanOrEqual(1);
  });

  it("uses folder names as tags", () => {
    const index = new ApiIndex([POSTMAN_COLLECTION]);
    const eps = index.listAllByCategory("Users");
    expect(eps.length).toBe(2);
  });

  it("converts :param to {param}", () => {
    const index = new ApiIndex([POSTMAN_COLLECTION]);
    const ep = index.getEndpoint("GET", "/users/{userId}");
    expect(ep).toBeDefined();
  });

  it("extracts query parameters", () => {
    const index = new ApiIndex([POSTMAN_COLLECTION]);
    const ep = index.getEndpoint("GET", "/users");
    expect(ep!.parameters.some((p) => p.name === "page" && p.in === "query")).toBe(true);
  });

  it("extracts path variables", () => {
    const index = new ApiIndex([POSTMAN_COLLECTION]);
    const ep = index.getEndpoint("GET", "/users/{userId}");
    expect(ep!.parameters.some((p) => p.name === "userId" && p.in === "path")).toBe(true);
  });

  it("detects hasRequestBody", () => {
    const index = new ApiIndex([POSTMAN_COLLECTION]);
    const ep = index.getEndpoint("POST", "/posts");
    expect(ep!.hasRequestBody).toBe(true);
  });
});

describe("listAllCategories", () => {
  it("returns sorted categories with endpoint counts", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
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
    const index = new ApiIndex([OPENAPI_SPEC]);
    const eps = index.listAllByCategory("stores");
    expect(eps.length).toBe(1);
    expect(eps[0].path).toBe("/stores");
  });

  it("returns empty array for unknown category", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    expect(index.listAllByCategory("nonexistent")).toEqual([]);
  });

  it("is case-insensitive", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const eps = index.listAllByCategory("Stores");
    expect(eps.length).toBe(1);
    expect(eps[0].path).toBe("/stores");
    expect(index.listAllByCategory("PETS").length).toBe(3);
  });
});

describe("searchAll", () => {
  it("matches by path", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const results = index.searchAll("stores");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toBe("/stores");
  });

  it("matches by summary", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const results = index.searchAll("Create pet");
    expect(results.length).toBe(1);
    expect(results[0].method).toBe("POST");
  });

  it("does not match by description", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    // "Returns all" only appears in description, not path or summary
    const results = index.searchAll("Returns all");
    expect(results.length).toBe(0);
  });

  it("is case-insensitive", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const results = index.searchAll("LIST PETS");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for no matches", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    expect(index.searchAll("zzz_nonexistent")).toEqual([]);
  });

  it("supports regex patterns", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const results = index.searchAll("^/pets$");
    expect(results.length).toBe(2); // GET /pets, POST /pets (not /pets/{petId})
  });

  it("supports regex alternation", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const results = index.searchAll("stores|untagged");
    expect(results.length).toBe(2);
  });

  it("falls back to literal match on invalid regex", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    // Invalid regex — should fall back to substring match and find nothing
    expect(index.searchAll("[invalid")).toEqual([]);
  });
});

describe("getEndpoint", () => {
  it("finds endpoint by method + path", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const ep = index.getEndpoint("GET", "/pets");
    expect(ep).toBeDefined();
  });

  it("returns undefined for non-existent endpoint", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    expect(index.getEndpoint("DELETE", "/pets")).toBeUndefined();
  });

  it("method matching is case-insensitive (uppercase)", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    const ep = index.getEndpoint("get", "/pets");
    // The method is stored as uppercase, so lowercase search should not match
    // unless the code uppercases the search. Let's check actual behavior:
    // getEndpoint does: ep.method === method.toUpperCase()
    expect(ep).toBeDefined();
  });
});

describe("Multiple specs", () => {
  const ORDERS_SPEC = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Orders API", version: "1.0" },
    paths: {
      "/orders": {
        get: { summary: "List orders", tags: ["orders"] },
        post: { summary: "Create order", tags: ["orders"] },
      },
    },
  });

  it("merges endpoints from multiple specs", () => {
    const index = new ApiIndex([OPENAPI_SPEC, ORDERS_SPEC]);
    const categories = index.listAllCategories();
    const tags = categories.map((c) => c.tag);
    expect(tags).toContain("pets");
    expect(tags).toContain("orders");
  });

  it("all endpoints are searchable across specs", () => {
    const index = new ApiIndex([OPENAPI_SPEC, ORDERS_SPEC]);
    expect(index.getEndpoint("GET", "/pets")).toBeDefined();
    expect(index.getEndpoint("GET", "/orders")).toBeDefined();
    expect(index.getEndpoint("POST", "/orders")).toBeDefined();
  });

  it("search spans all specs", () => {
    const index = new ApiIndex([OPENAPI_SPEC, ORDERS_SPEC]);
    const results = index.searchAll("List");
    const paths = results.map((r) => r.path);
    expect(paths).toContain("/pets");
    expect(paths).toContain("/orders");
  });

  it("merges endpoints under the same tag from different specs", () => {
    const extraPetsSpec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Extra Pets", version: "1.0" },
      paths: {
        "/pets/{petId}/toys": {
          get: { summary: "List pet toys", tags: ["pets"] },
        },
      },
    });
    const index = new ApiIndex([OPENAPI_SPEC, extraPetsSpec]);
    const pets = index.listAllCategories().find((c) => c.tag === "pets");
    expect(pets!.endpointCount).toBe(4); // 3 from OPENAPI_SPEC + 1 from extraPetsSpec
  });

  it("mixes JSON and YAML specs", () => {
    const index = new ApiIndex([OPENAPI_SPEC, OPENAPI_YAML]);
    expect(index.getEndpoint("GET", "/pets")).toBeDefined();
    expect(index.getEndpoint("GET", "/items")).toBeDefined();
  });

  it("first spec takes precedence for duplicate endpoints", () => {
    const altSpec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Alt", version: "1.0" },
      paths: {
        "/pets": {
          get: { summary: "Alt list pets", tags: ["pets"] },
        },
      },
    });
    const index = new ApiIndex([OPENAPI_SPEC, altSpec]);
    // getEndpoint uses find(), so the first match (from OPENAPI_SPEC) wins
    const ep = index.getEndpoint("GET", "/pets");
    expect(ep!.summary).toBe("List pets");
  });
});

// Datadog-style spec with nested request body schemas
const OPENAPI_NESTED_BODY = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Datadog-style API", version: "1.0" },
  components: {
    schemas: {
      LogsQueryFilter: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          from: { type: "string", description: "Start time" },
          to: { type: "string", description: "End time" },
          indexes: { type: "array", items: { type: "string" } },
        },
      },
      LogsListRequestPage: {
        type: "object",
        properties: {
          cursor: { type: "string", description: "Pagination cursor" },
          limit: { type: "integer", description: "Max results" },
        },
      },
      LogsListRequest: {
        type: "object",
        required: ["filter"],
        properties: {
          filter: { $ref: "#/components/schemas/LogsQueryFilter" },
          page: { $ref: "#/components/schemas/LogsListRequestPage" },
          sort: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/api/v2/logs/events/search": {
      post: {
        summary: "Search logs",
        tags: ["logs"],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/LogsListRequest" },
            },
          },
        },
      },
    },
  },
});

const OPENAPI_CIRCULAR_REF = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Circular API", version: "1.0" },
  components: {
    schemas: {
      TreeNode: {
        type: "object",
        properties: {
          name: { type: "string" },
          children: {
            type: "array",
            items: { $ref: "#/components/schemas/TreeNode" },
          },
          parent: { $ref: "#/components/schemas/TreeNode" },
        },
      },
    },
  },
  paths: {
    "/tree": {
      post: {
        summary: "Create tree node",
        tags: ["tree"],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TreeNode" },
            },
          },
        },
      },
    },
  },
});

const OPENAPI_ARRAY_OBJECT_ITEMS = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Array Items API", version: "1.0" },
  components: {
    schemas: {
      BatchRequest: {
        type: "object",
        properties: {
          requests: {
            type: "array",
            items: {
              type: "object",
              required: ["method", "url"],
              properties: {
                method: { type: "string" },
                url: { type: "string" },
                body: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  paths: {
    "/batch": {
      post: {
        summary: "Batch request",
        tags: ["batch"],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BatchRequest" },
            },
          },
        },
      },
    },
  },
});

describe("Nested request body schema extraction", () => {
  it("extracts nested object properties via $ref", () => {
    const index = new ApiIndex([OPENAPI_NESTED_BODY]);
    const ep = index.getEndpoint("POST", "/api/v2/logs/events/search");
    expect(ep!.requestBodySchema).toBeDefined();
    const props = ep!.requestBodySchema!.properties;

    // filter should have nested properties
    expect(props.filter.type).toBe("object");
    expect(props.filter.properties).toBeDefined();
    expect(props.filter.properties!.query.type).toBe("string");
    expect(props.filter.properties!.from.type).toBe("string");
    expect(props.filter.properties!.to.type).toBe("string");
    expect(props.filter.properties!.indexes.type).toBe("array");
    expect(props.filter.properties!.indexes.items!.type).toBe("string");
  });

  it("extracts page sub-fields via $ref", () => {
    const index = new ApiIndex([OPENAPI_NESTED_BODY]);
    const ep = index.getEndpoint("POST", "/api/v2/logs/events/search");
    const props = ep!.requestBodySchema!.properties;

    expect(props.page.type).toBe("object");
    expect(props.page.properties).toBeDefined();
    expect(props.page.properties!.cursor.type).toBe("string");
    expect(props.page.properties!.limit.type).toBe("integer");
  });

  it("flat properties remain flat", () => {
    const index = new ApiIndex([OPENAPI_NESTED_BODY]);
    const ep = index.getEndpoint("POST", "/api/v2/logs/events/search");
    const props = ep!.requestBodySchema!.properties;

    expect(props.sort.type).toBe("string");
    expect(props.sort.properties).toBeUndefined();
  });

  it("marks required fields at top level", () => {
    const index = new ApiIndex([OPENAPI_NESTED_BODY]);
    const ep = index.getEndpoint("POST", "/api/v2/logs/events/search");
    const props = ep!.requestBodySchema!.properties;

    expect(props.filter.required).toBe(true);
    expect(props.page.required).toBe(false);
    expect(props.sort.required).toBe(false);
  });

  it("handles circular $ref without crashing", () => {
    const index = new ApiIndex([OPENAPI_CIRCULAR_REF]);
    const ep = index.getEndpoint("POST", "/tree");
    expect(ep!.requestBodySchema).toBeDefined();
    const props = ep!.requestBodySchema!.properties;

    expect(props.name.type).toBe("string");
    // parent is a circular ref — should terminate as a flat object
    expect(props.parent.type).toBe("object");
  });

  it("extracts array items with object properties", () => {
    const index = new ApiIndex([OPENAPI_ARRAY_OBJECT_ITEMS]);
    const ep = index.getEndpoint("POST", "/batch");
    expect(ep!.requestBodySchema).toBeDefined();
    const props = ep!.requestBodySchema!.properties;

    expect(props.requests.type).toBe("array");
    expect(props.requests.items).toBeDefined();
    expect(props.requests.items!.type).toBe("object");
    expect(props.requests.items!.properties).toBeDefined();
    expect(props.requests.items!.properties!.method.type).toBe("string");
    expect(props.requests.items!.properties!.url.type).toBe("string");
    expect(props.requests.items!.properties!.body.type).toBe("string");
  });

  it("extracts required fields for array item objects", () => {
    const index = new ApiIndex([OPENAPI_ARRAY_OBJECT_ITEMS]);
    const ep = index.getEndpoint("POST", "/batch");
    const items = ep!.requestBodySchema!.properties.requests.items!;
    expect(items.required).toEqual(["method", "url"]);
  });
});

describe("getOAuthSchemes - OpenAPI 3.x", () => {
  it("extracts OAuth2 authorizationCode flow", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0" },
      paths: { "/test": { get: { summary: "Test" } } },
      components: {
        securitySchemes: {
          oauth2: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://auth.example.com/authorize",
                tokenUrl: "https://auth.example.com/token",
                scopes: {
                  "read:data": "Read data",
                  "write:data": "Write data",
                },
              },
            },
          },
        },
      },
    });
    const index = new ApiIndex([spec]);
    const schemes = index.getOAuthSchemes();
    expect(schemes).toHaveLength(1);
    expect(schemes[0].authorizationUrl).toBe("https://auth.example.com/authorize");
    expect(schemes[0].tokenUrl).toBe("https://auth.example.com/token");
    expect(schemes[0].scopes).toEqual(["read:data", "write:data"]);
  });

  it("extracts multiple flows from a single scheme", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0" },
      paths: { "/test": { get: { summary: "Test" } } },
      components: {
        securitySchemes: {
          oauth2: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://auth.example.com/authorize",
                tokenUrl: "https://auth.example.com/token",
                scopes: { read: "Read" },
              },
              clientCredentials: {
                tokenUrl: "https://auth.example.com/token",
                scopes: { admin: "Admin" },
              },
            },
          },
        },
      },
    });
    const index = new ApiIndex([spec]);
    const schemes = index.getOAuthSchemes();
    expect(schemes).toHaveLength(2);
  });

  it("ignores non-oauth2 security schemes", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0" },
      paths: { "/test": { get: { summary: "Test" } } },
      components: {
        securitySchemes: {
          apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
          bearer: { type: "http", scheme: "bearer" },
        },
      },
    });
    const index = new ApiIndex([spec]);
    expect(index.getOAuthSchemes()).toHaveLength(0);
  });

  it("returns empty for specs without securitySchemes", () => {
    const index = new ApiIndex([OPENAPI_SPEC]);
    expect(index.getOAuthSchemes()).toHaveLength(0);
  });
});

describe("getOAuthSchemes - OpenAPI 2.x (Swagger)", () => {
  it("extracts OAuth2 from securityDefinitions", () => {
    const spec = JSON.stringify({
      swagger: "2.0",
      info: { title: "Test", version: "1.0" },
      basePath: "/",
      paths: { "/test": { get: { summary: "Test" } } },
      securityDefinitions: {
        oauth2: {
          type: "oauth2",
          authorizationUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          scopes: { read: "Read", write: "Write" },
        },
      },
    });
    const index = new ApiIndex([spec]);
    const schemes = index.getOAuthSchemes();
    expect(schemes).toHaveLength(1);
    expect(schemes[0].authorizationUrl).toBe("https://auth.example.com/authorize");
    expect(schemes[0].tokenUrl).toBe("https://auth.example.com/token");
    expect(schemes[0].scopes).toEqual(["read", "write"]);
  });
});
