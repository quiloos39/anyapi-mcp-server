import { z } from "zod";
import type { ToolContext } from "./shared.js";
import { formatToolError, attachRateLimit } from "./shared.js";
import { callApi } from "../api-client.js";
import {
  getOrBuildSchema,
  schemaToSDL,
  collectJsonFields,
  computeFieldCosts,
  collectArrayLengths,
} from "../graphql-schema.js";
import { generateSuggestions } from "../query-suggestions.js";
import { isNonJsonResult } from "../response-parser.js";
import { detectPagination, PAGINATION_PARAM_NAMES } from "../pagination.js";
import { storeResponse } from "../data-cache.js";

export function registerInspectApi({ server, config, apiIndex }: ToolContext): void {
  server.tool(
    "inspect_api",
    `Understand a ${config.name} API endpoint before using it. ` +
      "For GET endpoints: makes a real request and returns the inferred GraphQL schema (SDL), " +
      "suggested queries, per-field token costs, and a dataKey for cached re-queries. " +
      "For write endpoints (POST/PUT/PATCH/DELETE): returns spec documentation only — " +
      "parameters, request body schema, response codes — WITHOUT making any HTTP request. " +
      "Always safe to call. Use list_api first to discover endpoints.",
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
          "Path and query parameters (GET only). " +
            "Path params like {id} are interpolated; remaining become query string."
        ),
      headers: z
        .record(z.string())
        .optional()
        .describe(
          "Additional HTTP headers (GET only). " +
            "Overrides default --header values."
        ),
    },
    async ({ method, path, params, headers }) => {
      try {
        // Non-GET: return spec documentation only (no HTTP request)
        if (method !== "GET") {
          return handleSpecDocs(apiIndex, method, path);
        }

        // GET: make request and infer schema
        const { data, responseHeaders: respHeaders } = await callApi(
          config,
          method,
          path,
          params as Record<string, unknown> | undefined,
          undefined,
          headers
        );

        const dataKey = storeResponse(method, path, data, respHeaders);

        // Non-JSON response — skip GraphQL layer
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
        const { schema, shapeHash } = getOrBuildSchema(data, method, path, endpoint?.requestBodySchema);
        const sdl = schemaToSDL(schema);

        const result: Record<string, unknown> = { graphqlSchema: sdl, shapeHash, responseHeaders: respHeaders };
        if (dataKey) result.dataKey = dataKey;
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

        const suggestions = generateSuggestions(schema);
        if (suggestions.length > 0) {
          result.suggestedQueries = suggestions;
        }

        const fieldCosts = computeFieldCosts(data);
        result.fieldTokenCosts = fieldCosts;

        const arrayLengths = collectArrayLengths(data);
        if (Object.keys(arrayLengths).length > 0) {
          result.fieldArrayLengths = arrayLengths;
        }

        const allFieldsCost = fieldCosts._total;
        if (Array.isArray(data) && data.length > 0 && fieldCosts._perItem) {
          const perItem = fieldCosts._perItem;
          result.budgetExamples = [
            `All fields: ~${perItem} tokens/item, ~${allFieldsCost} tokens total`,
          ];
        } else if (typeof data === "object" && data !== null) {
          result.budgetExamples = [
            `All fields: ~${allFieldsCost} tokens total`,
          ];
        }

        const jsonFields = collectJsonFields(schema);
        if (jsonFields.length > 0) {
          result.jsonFields = jsonFields;
          result.jsonFieldsHint =
            "These fields contain heterogeneous or deeply nested data that cannot be queried " +
            "with GraphQL field selection. Query them as-is and parse the returned JSON directly.";
        }

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
            "Responses over ~10k tokens require maxTokens (to truncate) or unlimited: true (for full data)." +
            paginationSuffix;
        } else {
          result.hint =
            "Use query_api with the exact root field names from the schema above (e.g. if schema shows " +
            "'products: [Product]', query as '{ products { id name } }' — do NOT use '{ items { ... } }'). " +
            "For paginated APIs, pass limit/offset inside params (as query string parameters to the API), " +
            "NOT as top-level tool parameters. " +
            "Use fieldTokenCosts to understand per-field token costs and select fields wisely. " +
            "Responses over ~10k tokens require maxTokens (to truncate) or unlimited: true (for full data)." +
            paginationSuffix;
        }

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (error: unknown) {
        return formatToolError(error, apiIndex, method, path);
      }
    }
  );
}

/**
 * Return spec documentation for non-GET endpoints (no HTTP request).
 */
function handleSpecDocs(
  apiIndex: ToolContext["apiIndex"],
  method: string,
  path: string,
) {
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
      isError: true as const,
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

  result.hint = "Use mutate_api to execute this endpoint. " +
    "Provide the request body via 'body' (inline), 'bodyFile' (file path), " +
    "or 'patch' (JSON Patch operations for targeted changes to existing resources).";

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}
