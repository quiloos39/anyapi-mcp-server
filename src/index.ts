#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { ApiIndex } from "./api-index.js";
import { callApi, parseRateLimits } from "./api-client.js";
import { initLogger } from "./logger.js";
import { generateSuggestions } from "./query-suggestions.js";
import {
  getOrBuildSchema,
  executeQuery,
  schemaToSDL,
  truncateIfArray,
  computeShapeHash,
  collectJsonFields,
  computeFieldCosts,
} from "./graphql-schema.js";
import { buildStatusMessage } from "./token-budget.js";
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
import { detectPagination, PAGINATION_PARAM_NAMES } from "./pagination.js";
import { applyJsonFilter } from "./json-filter.js";
import { storeResponse, loadResponse } from "./data-cache.js";

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

function attachRateLimit(
  result: Record<string, unknown>,
  respHeaders: Record<string, string>
): void {
  const rl = parseRateLimits(respHeaders);
  if (!rl) return;
  result._rateLimit = rl;
  if (
    rl.remaining !== null &&
    (rl.remaining <= 5 || (rl.limit !== null && rl.remaining / rl.limit <= 0.1))
  ) {
    result._rateLimitWarning =
      `Rate limit nearly exhausted (${rl.remaining}${rl.limit !== null ? `/${rl.limit}` : ""} remaining` +
      `${rl.resetAt ? `, resets ${rl.resetAt}` : ""}). Consider reducing request frequency.`;
  }
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
    "Returns a dataKey — pass it to query_api to reuse the cached response (zero HTTP calls). " +
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
        headers
      );

      const dataKey = storeResponse(method, path, data, respHeaders);

      // Non-JSON response — skip GraphQL layer, return raw parsed data
      if (isNonJsonResult(data)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({
              rawResponse: data,
              responseHeaders: respHeaders,
              dataKey,
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

      const result: Record<string, unknown> = { graphqlSchema: sdl, shapeHash, dataKey, responseHeaders: respHeaders };
      if (bodyHash) result.bodyHash = bodyHash;
      attachRateLimit(result, respHeaders);

      if (endpoint && endpoint.parameters.length > 0) {
        result.parameters = endpoint.parameters.map((p) => ({
          name: p.name,
          in: p.in,
          required: p.required,
          ...(p.description ? { description: p.description } : {}),
          ...(p.in === "query" && PAGINATION_PARAM_NAMES.has(p.name) ? { pagination: true } : {}),
        }));
        const paginationParams = endpoint.parameters
          .filter((p) => p.in === "query" && PAGINATION_PARAM_NAMES.has(p.name))
          .map((p) => p.name);
        if (paginationParams.length > 0) {
          result.paginationParams = paginationParams;
        }
      }

      // Smart query suggestions
      const suggestions = generateSuggestions(schema);
      if (suggestions.length > 0) {
        result.suggestedQueries = suggestions;
      }

      // Per-field token costs
      const fieldCosts = computeFieldCosts(data);
      result.fieldTokenCosts = fieldCosts;

      // Budget examples
      const defaultBudget = 4000;
      const allFieldsCost = fieldCosts._total;
      if (Array.isArray(data) && data.length > 0 && fieldCosts._perItem) {
        const perItem = fieldCosts._perItem;
        const itemsFit = Math.floor(defaultBudget / perItem);
        result.budgetExamples = [
          `All fields: ~${perItem} tokens/item, ~${itemsFit} items fit in default budget (${defaultBudget})`,
        ];
      } else if (typeof data === "object" && data !== null) {
        result.budgetExamples = [
          `All fields: ~${allFieldsCost} tokens total`,
        ];
      }

      // Flag JSON scalar fields so the AI knows which fields are opaque
      const jsonFields = collectJsonFields(schema);
      if (jsonFields.length > 0) {
        result.jsonFields = jsonFields;
        result.jsonFieldsHint =
          "These fields contain heterogeneous or deeply nested data that cannot be queried " +
          "with GraphQL field selection. Query them as-is and parse the returned JSON directly.";
      }

      // Pagination detection from response data
      const pagination = detectPagination(data, endpoint?.parameters);
      if (pagination) {
        result._pagination = pagination;
      }

      const paginationParamsList = (result.paginationParams as string[] | undefined) ?? [];
      const paginationSuffix = paginationParamsList.length > 0
        ? ` This API supports pagination via: ${paginationParamsList.join(", ")}. Pass these inside params.`
        : "";

      if (Array.isArray(data)) {
        result.totalItems = data.length;
        result.hint =
          "Use query_api with field names from the schema above. " +
          "For raw arrays: '{ items { ... } _count }'. " +
          "For paginated APIs, pass limit/offset inside params (as query string parameters to the API), " +
          "NOT as top-level tool parameters. " +
          "Use fieldTokenCosts to understand per-field token costs and select fields wisely. " +
          "query_api's maxTokens parameter controls response size — select fewer fields to fit more items." +
          paginationSuffix;
      } else {
        result.hint =
          "Use query_api with the exact root field names from the schema above (e.g. if schema shows " +
          "'products: [Product]', query as '{ products { id name } }' — do NOT use '{ items { ... } }'). " +
          "For paginated APIs, pass limit/offset inside params (as query string parameters to the API), " +
          "NOT as top-level tool parameters. " +
          "Use fieldTokenCosts to understand per-field token costs and select fields wisely. " +
          "query_api's maxTokens parameter controls response size — select fewer fields to fit more items." +
          paginationSuffix;
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
    "TIP: Pass the dataKey from call_api to reuse the cached response — zero HTTP calls. " +
    "If you know the field names, call query_api directly — on first hit the schema SDL " +
    "will be included in the response. If unsure, use call_api first for schema discovery.\n" +
    "Use the exact root field names from the schema — do NOT assume generic names.\n" +
    "- Raw array response ([...]): '{ items { id name } _count }'\n" +
    "- Object response ({products: [...]}): '{ products { id name } }' (use actual field names from schema)\n" +
    "- Write operations with mutation schema: 'mutation { post_endpoint(input: { ... }) { id name } }'\n" +
    "Field names with dashes are converted to underscores (e.g. created-at → created_at). " +
    "PAGINATION: To paginate the API itself, pass limit/offset inside 'params' (they become query string parameters). " +
    "TOKEN BUDGET: Use maxTokens to control response size. If the response exceeds the budget, " +
    "array results are truncated to fit. Select fewer fields to fit more items. " +
    "Check _status in the response: 'COMPLETE' means all data returned, 'TRUNCATED' means array was cut to fit budget. " +
    "Every response includes a _dataKey for subsequent re-queries with different field selections.",
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
    dataKey: z
      .string()
      .optional()
      .describe(
        "dataKey from a previous call_api or query_api response. " +
          "If valid, reuses cached data — zero HTTP calls. Falls back to HTTP on miss/expiry."
      ),
    headers: z
      .record(z.string())
      .optional()
      .describe(
        "Additional HTTP headers for this request (e.g. { \"Authorization\": \"Bearer <token>\" }). " +
          "Overrides default --header values."
      ),
    jsonFilter: z
      .string()
      .optional()
      .describe(
        "Dot-path to extract from the result after GraphQL query executes. " +
          "Use \".\" for nested access, \"[]\" to traverse arrays. " +
          "Example: \"data[].attributes.message\" extracts the message field from each element of the data array."
      ),
    maxTokens: z
      .number()
      .min(100)
      .optional()
      .describe(
        "Token budget for the response (default: 4000). If exceeded, array results are truncated to fit. " +
          "Select fewer fields to fit more items."
      ),
  },
  async ({ method, path, params, body, query, dataKey, headers, jsonFilter, maxTokens }) => {
    try {
      const budget = maxTokens ?? 4000;

      let rawData: unknown;
      let respHeaders: Record<string, string>;

      // Try dataKey cache first
      const cached = dataKey ? loadResponse(dataKey) : null;
      if (cached) {
        rawData = cached.data;
        respHeaders = cached.responseHeaders;
      } else {
        const result = await callApi(
          config,
          method,
          path,
          params as Record<string, unknown> | undefined,
          body as Record<string, unknown> | undefined,
          headers
        );
        rawData = result.data;
        respHeaders = result.responseHeaders;
      }

      // Store response for future re-queries
      const newDataKey = storeResponse(method, path, rawData, respHeaders);

      // Non-JSON response — skip GraphQL layer, return raw parsed data
      if (isNonJsonResult(rawData)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({
              rawResponse: rawData,
              responseHeaders: respHeaders,
              _dataKey: newDataKey,
              hint: "This endpoint returned a non-JSON response. GraphQL querying is not available. " +
                "The raw parsed content is shown above.",
            }, null, 2) },
          ],
        };
      }

      const endpoint = apiIndex.getEndpoint(method, path);
      const bodyHash = WRITE_METHODS.has(method) && body ? computeShapeHash(body) : undefined;
      const { schema, shapeHash, fromCache } = getOrBuildSchema(rawData, method, path, endpoint?.requestBodySchema, bodyHash);
      let queryResult = await executeQuery(schema, rawData, query);

      if (jsonFilter) {
        queryResult = applyJsonFilter(queryResult, jsonFilter);
      }

      // Apply token budget
      const { status, result: budgetResult } = buildStatusMessage(queryResult, budget);

      if (typeof budgetResult === "object" && budgetResult !== null && !Array.isArray(budgetResult)) {
        const qr = budgetResult as Record<string, unknown>;
        attachRateLimit(qr, respHeaders);
        // Include schema + suggestions on first hit so LLM learns the field names
        if (!fromCache) {
          qr._schema = schemaToSDL(schema);
          const suggestions = generateSuggestions(schema);
          if (suggestions.length > 0) {
            qr._suggestedQueries = suggestions;
          }
        }
        // Pagination hint from raw response data
        const pagination = detectPagination(rawData, endpoint?.parameters);
        if (pagination) {
          qr._pagination = pagination;
        }
        // _status as first key
        const output = { _status: status, _dataKey: newDataKey, ...qr };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(output, null, 2) },
          ],
        };
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ _status: status, _dataKey: newDataKey, data: budgetResult }, null, 2) },
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

// --- Tool 5: auth (only when OAuth is configured) ---
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
