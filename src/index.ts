#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { ApiIndex } from "./api-index.js";
import { callApi } from "./api-client.js";
import { initLogger } from "./logger.js";
import { generateSuggestions } from "./query-suggestions.js";
import {
  getOrBuildSchema,
  executeQuery,
  schemaToSDL,
  truncateIfArray,
  computeShapeHash,
} from "./graphql-schema.js";
import { ApiError, buildErrorContext } from "./error-context.js";
import { RetryableError } from "./retry.js";
import { isNonJsonResult } from "./response-parser.js";
import {
  startAuth,
  exchangeCode,
  awaitCallback,
  storeTokens,
  getTokens,
  isTokenExpired,
  initTokenStorage,
} from "./oauth.js";

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

const config = await loadConfig();
initLogger(config.logPath ?? null);
const apiIndex = new ApiIndex(config.specs);

// --- OAuth: merge spec-derived security info and init token storage ---
if (config.oauth) {
  const schemes = apiIndex.getOAuthSchemes();
  if (schemes.length > 0) {
    const scheme = schemes[0];
    if (!config.oauth.authUrl && scheme.authorizationUrl) {
      config.oauth.authUrl = scheme.authorizationUrl;
    }
    if (config.oauth.scopes.length === 0 && scheme.scopes.length > 0) {
      config.oauth.scopes = scheme.scopes;
    }
  }
  initTokenStorage(config.name);
}

function formatToolError(
  error: unknown,
  method?: string,
  path?: string
): { content: { type: "text"; text: string }[]; isError: true } {
  if ((error instanceof ApiError || error instanceof RetryableError) && method && path) {
    const endpoint = apiIndex.getEndpoint(method, path);
    const context = buildErrorContext(error, method, path, endpoint);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(context, null, 2) }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

const server = new McpServer({
  name: config.name,
  version: "1.2.1",
});

// --- Tool 1: list_api ---
server.tool(
  "list_api",
  `List available ${config.name} API endpoints. ` +
    "Call with no arguments to see all endpoints. " +
    "Provide 'category' to filter by tag. " +
    "Provide 'search' to search across paths and summaries (supports regex). " +
    "Results are paginated with limit (default 20) and offset.",
  {
    category: z
      .string()
      .optional()
      .describe("Tag/category to filter by. Case-insensitive."),
    search: z
      .string()
      .optional()
      .describe("Search keyword or regex pattern across endpoint paths and summaries"),
    query: z
      .string()
      .optional()
      .describe(
        "GraphQL selection query. Default: '{ items { method path summary } _count }'. " +
          "Available fields: method, path, summary, tag, parameters { name in required description }"
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Max items to return (default: 20)"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Items to skip (default: 0)"),
  },
  async ({ category, search, query, limit, offset }) => {
    try {
      let data: unknown[];
      if (search) {
        data = apiIndex.searchAll(search);
      } else if (category) {
        data = apiIndex.listAllByCategory(category);
      } else {
        data = apiIndex.listAll();
      }

      // Empty results — return directly to avoid GraphQL schema errors on empty arrays
      if (data.length === 0) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ items: [], _count: 0 }, null, 2) },
          ],
        };
      }

      const defaultQuery = "{ items { method path summary } _count }";
      const effectiveQuery = query ?? defaultQuery;

      const { schema } = getOrBuildSchema(data, "LIST", category ?? search ?? "_all");
      const { data: sliced, truncated, total } = truncateIfArray(data, limit ?? 20, offset);
      const queryResult = await executeQuery(schema, sliced, effectiveQuery);

      if (truncated && typeof queryResult === "object" && queryResult !== null) {
        (queryResult as Record<string, unknown>)._meta = {
          total,
          offset: offset ?? 0,
          limit: limit ?? 20,
          hasMore: true,
        };
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(queryResult, null, 2) },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: message }) },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool 2: call_api ---
server.tool(
  "call_api",
  `Inspect a ${config.name} API endpoint. Makes a real request and returns ONLY the ` +
    "inferred GraphQL schema (SDL) showing all available fields and their types. " +
    "No response data is returned — use query_api to fetch actual data. " +
    "IMPORTANT: Read the returned schema carefully. The root field names in the schema " +
    "are what you must use in query_api — do NOT assume generic names like 'items'. " +
    "For example, if the schema shows 'products: [Product]', query as '{ products { id name } }', not '{ items { id name } }'. " +
    "Also returns accepted parameters (name, location, required) from the API spec, " +
    "and suggestedQueries with ready-to-use GraphQL queries. " +
    "Use list_api first to discover endpoints.",
  {
    method: z
      .enum(["GET", "POST", "PUT", "DELETE", "PATCH"])
      .describe("HTTP method"),
    path: z
      .string()
      .describe(
        "API path template (e.g. '/api/card/{id}'). Use list_api to discover paths."
      ),
    params: z
      .record(z.unknown())
      .optional()
      .describe(
        "Path and query parameters as key-value pairs. " +
          "Path params like {id} are interpolated; remaining become query string for GET."
      ),
    body: z
      .record(z.unknown())
      .optional()
      .describe("Request body for POST/PUT/PATCH"),
    headers: z
      .record(z.string())
      .optional()
      .describe(
        "Additional HTTP headers for this request (e.g. { \"Authorization\": \"Bearer <token>\" }). " +
          "Overrides default --header values."
      ),
  },
  async ({ method, path, params, body, headers }) => {
    try {
      const { data, responseHeaders: respHeaders } = await callApi(
        config,
        method,
        path,
        params as Record<string, unknown> | undefined,
        body as Record<string, unknown> | undefined,
        headers,
        "populate"
      );

      // Non-JSON response — skip GraphQL layer, return raw parsed data
      if (isNonJsonResult(data)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({
              rawResponse: data,
              responseHeaders: respHeaders,
              hint: "This endpoint returned a non-JSON response. The raw parsed content is shown above. " +
                "GraphQL schema inference is not available for non-JSON responses — use the data directly.",
            }, null, 2) },
          ],
        };
      }

      const endpoint = apiIndex.getEndpoint(method, path);
      const bodyHash = WRITE_METHODS.has(method) && body ? computeShapeHash(body) : undefined;
      const { schema, shapeHash } = getOrBuildSchema(data, method, path, endpoint?.requestBodySchema, bodyHash);
      const sdl = schemaToSDL(schema);

      const result: Record<string, unknown> = { graphqlSchema: sdl, shapeHash, responseHeaders: respHeaders };
      if (bodyHash) result.bodyHash = bodyHash;

      if (endpoint && endpoint.parameters.length > 0) {
        result.parameters = endpoint.parameters.map((p) => ({
          name: p.name,
          in: p.in,
          required: p.required,
          ...(p.description ? { description: p.description } : {}),
        }));
      }

      // Smart query suggestions
      const suggestions = generateSuggestions(schema);
      if (suggestions.length > 0) {
        result.suggestedQueries = suggestions;
      }

      if (Array.isArray(data)) {
        result.totalItems = data.length;
        result.hint =
          "Use query_api with field names from the schema above. " +
          "For raw arrays: '{ items { ... } _count }'. " +
          "For paginated APIs, pass limit/offset inside params (as query string parameters to the API), " +
          "NOT as top-level tool parameters.";
      } else {
        result.hint =
          "Use query_api with the exact root field names from the schema above (e.g. if schema shows " +
          "'products: [Product]', query as '{ products { id name } }' — do NOT use '{ items { ... } }'). " +
          "For paginated APIs, pass limit/offset inside params (as query string parameters to the API), " +
          "NOT as top-level tool parameters.";
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error: unknown) {
      return formatToolError(error, method, path);
    }
  }
);

// --- Tool 3: query_api ---
server.tool(
  "query_api",
  `Fetch data from a ${config.name} API endpoint, returning only the fields you select via GraphQL. ` +
    "IMPORTANT: Always run call_api first to discover the actual schema field names. " +
    "Use the exact root field names from the schema — do NOT assume generic names.\n" +
    "- Raw array response ([...]): '{ items { id name } _count }'\n" +
    "- Object response ({products: [...]}): '{ products { id name } }' (use actual field names from schema)\n" +
    "- Write operations with mutation schema: 'mutation { post_endpoint(input: { ... }) { id name } }'\n" +
    "Field names with dashes are converted to underscores (e.g. created-at → created_at). " +
    "PAGINATION: To paginate the API itself, pass limit/offset inside 'params' (they become query string parameters). " +
    "The top-level limit/offset parameters only slice the already-fetched response locally.",
  {
    method: z
      .enum(["GET", "POST", "PUT", "DELETE", "PATCH"])
      .describe("HTTP method"),
    path: z
      .string()
      .describe("API path template (e.g. '/api/card/{id}')"),
    params: z
      .record(z.unknown())
      .optional()
      .describe(
        "Path and query parameters. Path params like {id} are interpolated; " +
          "remaining become query string for GET. " +
          "For API pagination, pass limit/offset here (e.g. { limit: 20, offset: 40 })."
      ),
    body: z
      .record(z.unknown())
      .optional()
      .describe("Request body for POST/PUT/PATCH"),
    query: z
      .string()
      .describe(
        "GraphQL selection query using field names from call_api schema " +
          "(e.g. '{ products { id name } }' — NOT '{ items { ... } }' unless the API returns a raw array)"
      ),
    headers: z
      .record(z.string())
      .optional()
      .describe(
        "Additional HTTP headers for this request (e.g. { \"Authorization\": \"Bearer <token>\" }). " +
          "Overrides default --header values."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Client-side slice: max items from already-fetched response (default: 50). For API pagination, use params instead."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Client-side slice: items to skip in already-fetched response (default: 0). For API pagination, use params instead."),
  },
  async ({ method, path, params, body, query, headers, limit, offset }) => {
    try {
      const { data: rawData, responseHeaders: respHeaders } = await callApi(
        config,
        method,
        path,
        params as Record<string, unknown> | undefined,
        body as Record<string, unknown> | undefined,
        headers,
        "consume"
      );

      // Non-JSON response — skip GraphQL layer, return raw parsed data
      if (isNonJsonResult(rawData)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({
              rawResponse: rawData,
              responseHeaders: respHeaders,
              hint: "This endpoint returned a non-JSON response. GraphQL querying is not available. " +
                "The raw parsed content is shown above.",
            }, null, 2) },
          ],
        };
      }

      const endpoint = apiIndex.getEndpoint(method, path);
      const bodyHash = WRITE_METHODS.has(method) && body ? computeShapeHash(body) : undefined;
      const { schema, shapeHash } = getOrBuildSchema(rawData, method, path, endpoint?.requestBodySchema, bodyHash);
      const { data, truncated, total } = truncateIfArray(rawData, limit, offset);
      const queryResult = await executeQuery(schema, data, query);

      if (typeof queryResult === "object" && queryResult !== null) {
        (queryResult as Record<string, unknown>)._shapeHash = shapeHash;
        (queryResult as Record<string, unknown>)._responseHeaders = respHeaders;
        if (bodyHash) (queryResult as Record<string, unknown>)._bodyHash = bodyHash;
        if (truncated) {
          (queryResult as Record<string, unknown>)._meta = {
            total,
            offset: offset ?? 0,
            limit: limit ?? 50,
            hasMore: true,
          };
        }
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(queryResult, null, 2) },
        ],
      };
    } catch (error: unknown) {
      return formatToolError(error, method, path);
    }
  }
);

// --- Tool 4: explain_api ---
server.tool(
  "explain_api",
  `Get detailed documentation for a ${config.name} API endpoint from the spec. ` +
    "Returns all available spec information — summary, description, parameters, " +
    "request body schema, response codes, deprecation status — without making any HTTP request. " +
    "Use list_api first to discover endpoints, then explain_api to understand them before calling.",
  {
    method: z
      .enum(["GET", "POST", "PUT", "DELETE", "PATCH"])
      .describe("HTTP method"),
    path: z
      .string()
      .describe("API path template (e.g. '/api/card/{id}')"),
  },
  async ({ method, path }) => {
    try {
      const endpoint = apiIndex.getEndpoint(method, path);
      if (!endpoint) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Endpoint not found: ${method} ${path}`,
                hint: "Use list_api to discover available endpoints.",
              }),
            },
          ],
          isError: true,
        };
      }

      const result: Record<string, unknown> = {
        method: endpoint.method,
        path: endpoint.path,
        summary: endpoint.summary,
      };

      if (endpoint.description) {
        result.description = endpoint.description;
      }
      if (endpoint.operationId) {
        result.operationId = endpoint.operationId;
      }
      if (endpoint.deprecated) {
        result.deprecated = true;
      }
      result.tag = endpoint.tag;

      if (endpoint.parameters.length > 0) {
        result.parameters = endpoint.parameters.map((p) => ({
          name: p.name,
          in: p.in,
          required: p.required,
          ...(p.description ? { description: p.description } : {}),
        }));
      }

      if (endpoint.hasRequestBody) {
        const bodyInfo: Record<string, unknown> = {};
        if (endpoint.requestBodyDescription) {
          bodyInfo.description = endpoint.requestBodyDescription;
        }
        if (endpoint.requestBodySchema) {
          bodyInfo.contentType = endpoint.requestBodySchema.contentType;
          bodyInfo.properties = endpoint.requestBodySchema.properties;
        }
        result.requestBody = bodyInfo;
      }

      if (endpoint.responses && endpoint.responses.length > 0) {
        result.responses = endpoint.responses;
      }

      if (endpoint.externalDocs) {
        result.externalDocs = endpoint.externalDocs;
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: message }) },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool 5: batch_query ---
server.tool(
  "batch_query",
  `Fetch data from multiple ${config.name} API endpoints concurrently. ` +
    "Each request in the batch follows the query_api flow — makes a real HTTP request " +
    "and returns only the fields selected via GraphQL query. " +
    "All requests execute in parallel; one failure does not affect the others. " +
    "IMPORTANT: Run call_api first on each endpoint to discover schema field names.",
  {
    requests: z
      .array(
        z.object({
          method: z
            .enum(["GET", "POST", "PUT", "DELETE", "PATCH"])
            .describe("HTTP method"),
          path: z.string().describe("API path template"),
          params: z
            .record(z.unknown())
            .optional()
            .describe("Path and query parameters"),
          body: z
            .record(z.unknown())
            .optional()
            .describe("Request body for POST/PUT/PATCH"),
          query: z
            .string()
            .describe("GraphQL selection query (use field names from call_api schema)"),
          headers: z
            .record(z.string())
            .optional()
            .describe("Additional HTTP headers for this request"),
        })
      )
      .min(1)
      .max(10)
      .describe("Array of requests to execute concurrently (1-10)"),
  },
  async ({ requests }) => {
    try {
      const settled = await Promise.allSettled(
        requests.map(async (req) => {
          const { data: rawData, responseHeaders: respHeaders } = await callApi(
            config,
            req.method,
            req.path,
            req.params as Record<string, unknown> | undefined,
            req.body as Record<string, unknown> | undefined,
            req.headers,
            "none"
          );

          // Non-JSON response — skip GraphQL layer
          if (isNonJsonResult(rawData)) {
            return {
              method: req.method,
              path: req.path,
              data: rawData,
              responseHeaders: respHeaders,
              nonJson: true,
            };
          }

          const endpoint = apiIndex.getEndpoint(req.method, req.path);
          const bodyHash = WRITE_METHODS.has(req.method) && req.body
            ? computeShapeHash(req.body as Record<string, unknown>)
            : undefined;
          const { schema, shapeHash } = getOrBuildSchema(
            rawData,
            req.method,
            req.path,
            endpoint?.requestBodySchema,
            bodyHash
          );
          const queryResult = await executeQuery(schema, rawData, req.query);

          return {
            method: req.method,
            path: req.path,
            data: queryResult,
            responseHeaders: respHeaders,
            shapeHash,
            ...(bodyHash ? { bodyHash } : {}),
          };
        })
      );

      const results = settled.map((outcome, i) => {
        if (outcome.status === "fulfilled") {
          return outcome.value;
        }
        const reason = outcome.reason;
        if (reason instanceof ApiError || reason instanceof RetryableError) {
          const endpoint = apiIndex.getEndpoint(requests[i].method, requests[i].path);
          return buildErrorContext(reason, requests[i].method, requests[i].path, endpoint);
        }
        const message =
          reason instanceof Error ? reason.message : String(reason);
        return {
          method: requests[i].method,
          path: requests[i].path,
          error: message,
        };
      });

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(results, null, 2) },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: message }) },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool 6: auth (only when OAuth is configured) ---
if (config.oauth) {
  server.tool(
    "auth",
    `Manage OAuth 2.0 authentication for ${config.name}. ` +
      "Use action 'start' to begin the OAuth flow (returns an authorization URL for " +
      "authorization_code flow, or completes token exchange for client_credentials). " +
      "Use action 'exchange' to complete the flow — the callback is captured automatically " +
      "via a localhost server, or you can provide a 'code' manually. " +
      "Use action 'status' to check the current token status.",
    {
      action: z
        .enum(["start", "exchange", "status"])
        .describe(
          "'start' begins auth flow, 'exchange' completes code exchange, 'status' shows token info"
        ),
      code: z
        .string()
        .optional()
        .describe(
          "Authorization code from the OAuth provider (optional for 'exchange' — " +
            "if omitted, waits for the localhost callback automatically)"
        ),
    },
    async ({ action, code }) => {
      try {
        if (action === "start") {
          const result = await startAuth(config.oauth!);
          if ("url" in result) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      message:
                        "Open this URL to authorize. A local callback server is listening. " +
                        "After you approve, call auth with action 'exchange' to complete authentication.",
                      authorizationUrl: result.url,
                      flow: config.oauth!.flow,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          // client_credentials: tokens obtained directly
          storeTokens(result.tokens);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    message:
                      "Authentication successful (client_credentials flow).",
                    tokenType: result.tokens.tokenType,
                    expiresIn: Math.round(
                      (result.tokens.expiresAt - Date.now()) / 1000
                    ),
                    scope: result.tokens.scope ?? null,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        if (action === "exchange") {
          const tokens = code
            ? await exchangeCode(config.oauth!, code)
            : await awaitCallback(config.oauth!);
          storeTokens(tokens);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    message: "Authentication successful.",
                    tokenType: tokens.tokenType,
                    expiresIn: Math.round(
                      (tokens.expiresAt - Date.now()) / 1000
                    ),
                    hasRefreshToken: !!tokens.refreshToken,
                    scope: tokens.scope ?? null,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // action === "status"
        const tokens = getTokens();
        if (!tokens) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    authenticated: false,
                    message:
                      "No tokens stored. Use auth with action 'start' to authenticate.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const expired = isTokenExpired();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  authenticated: true,
                  tokenType: tokens.tokenType,
                  expired,
                  expiresIn: Math.round(
                    (tokens.expiresAt - Date.now()) / 1000
                  ),
                  hasRefreshToken: !!tokens.refreshToken,
                  scope: tokens.scope ?? null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: message }) },
          ],
          isError: true,
        };
      }
    }
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${config.name} MCP Server running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
