import { z } from "zod";
import type { ToolContext } from "./shared.js";
import { formatToolError, attachRateLimit } from "./shared.js";
import { callApi } from "../api-client.js";
import {
  getOrBuildSchema,
  schemaToSDL,
  executeQuery,
} from "../graphql-schema.js";
import { generateSuggestions } from "../query-suggestions.js";
import { buildStatusMessage, estimateResultTokens, findPrimaryArrayLength } from "../token-budget.js";
import { isNonJsonResult } from "../response-parser.js";
import { detectPagination } from "../pagination.js";
import { storeResponse, loadResponse } from "../data-cache.js";
import { applyJsonFilter } from "../json-filter.js";

export function registerQueryApi({ server, config, apiIndex }: ToolContext): void {
  server.tool(
    "query_api",
    `Fetch data from a ${config.name} API endpoint (GET only), returning only the fields you select via GraphQL. ` +
      "TIP: Pass the dataKey from inspect_api to reuse the cached response — zero HTTP calls. " +
      "If you know the field names, call query_api directly — on first hit the schema SDL " +
      "will be included in the response. If unsure, use inspect_api first for schema discovery.\n" +
      "Use the exact root field names from the schema — do NOT assume generic names.\n" +
      "- Raw array response ([...]): '{ items { id name } _count }'\n" +
      "- Object response ({products: [...]}): '{ products { id name } }' (use actual field names from schema)\n" +
      "Field names with dashes are converted to underscores (e.g. created-at → created_at). " +
      "PAGINATION: To paginate the API itself, pass limit/offset inside 'params' (they become query string parameters). " +
      "TOKEN BUDGET (three modes):\n" +
      "1. No maxTokens/unlimited: responses over ~10k tokens return an error — use maxTokens or unlimited to proceed.\n" +
      "2. maxTokens: truncates the deepest largest array to fit the budget.\n" +
      "3. unlimited: true: returns the full response with no truncation.\n" +
      "Check _status in the response: 'COMPLETE' means all data returned, 'TRUNCATED' means array was cut to fit budget. " +
      "Every response includes a _dataKey for subsequent re-queries with different field selections. " +
      "For write operations (POST/PUT/PATCH/DELETE), use mutate_api instead.",
    {
      path: z
        .string()
        .describe("API path template (e.g. '/api/card/{id}')"),
      params: z
        .record(z.unknown())
        .optional()
        .describe(
          "Path and query parameters. Path params like {id} are interpolated; " +
            "remaining become query string. " +
            "For API pagination, pass limit/offset here (e.g. { limit: 20, offset: 40 })."
        ),
      query: z
        .string()
        .describe(
          "GraphQL selection query using field names from inspect_api schema " +
            "(e.g. '{ products { id name } }' — NOT '{ items { ... } }' unless the API returns a raw array)"
        ),
      dataKey: z
        .string()
        .optional()
        .describe(
          "dataKey from a previous inspect_api or query_api response. " +
            "If valid, reuses cached data — zero HTTP calls. Falls back to HTTP on miss/expiry."
        ),
      headers: z
        .record(z.string())
        .optional()
        .describe(
          "Additional HTTP headers for this request. Overrides default --header values."
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
          "Token budget for the response. If exceeded, the deepest largest array is truncated to fit. " +
            "Select fewer fields to fit more items. Without this or unlimited, responses over ~10k tokens are rejected."
        ),
      unlimited: z
        .boolean()
        .optional()
        .describe(
          "Set to true to return the full response with no token budget enforcement. " +
            "Use when you know exactly what fields you need and want all data."
        ),
    },
    async ({ path, params, query, dataKey, headers, jsonFilter, maxTokens, unlimited }) => {
      try {
        let rawData: unknown;
        let respHeaders: Record<string, string>;

        // Try dataKey cache first
        const cached = dataKey ? loadResponse(dataKey) : null;
        let cachedDataAge: number | undefined;
        if (cached) {
          rawData = cached.data;
          respHeaders = cached.responseHeaders;
          cachedDataAge = Math.round((Date.now() - cached.storedAt) / 1000);
        } else {
          const result = await callApi(
            config,
            "GET",
            path,
            params as Record<string, unknown> | undefined,
            undefined,
            headers
          );
          rawData = result.data;
          respHeaders = result.responseHeaders;
        }

        // Store response for future re-queries
        const newDataKey = storeResponse("GET", path, rawData, respHeaders);

        // Non-JSON response — skip GraphQL layer
        if (isNonJsonResult(rawData)) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({
                rawResponse: rawData,
                responseHeaders: respHeaders,
                ...(newDataKey ? { _dataKey: newDataKey } : {}),
                hint: "This endpoint returned a non-JSON response. GraphQL querying is not available. " +
                  "The raw parsed content is shown above.",
              }, null, 2) },
            ],
          };
        }

        const endpoint = apiIndex.getEndpoint("GET", path);
        const { schema, fromCache } = getOrBuildSchema(rawData, "GET", path, endpoint?.requestBodySchema);
        let queryResult = await executeQuery(schema, rawData, query, unlimited ? { unlimited: true } : undefined);

        if (jsonFilter) {
          queryResult = applyJsonFilter(queryResult, jsonFilter);
        }

        // Token budget: three-mode dispatch
        let status: string;
        let budgetResult: unknown;

        if (unlimited) {
          const arrayLen = typeof queryResult === "object" && queryResult !== null && !Array.isArray(queryResult)
            ? findPrimaryArrayLength(queryResult)
            : null;
          status = arrayLen !== null ? `COMPLETE (${arrayLen} items)` : "COMPLETE";
          budgetResult = queryResult;
        } else if (maxTokens !== undefined) {
          ({ status, result: budgetResult } = buildStatusMessage(queryResult, maxTokens));
        } else {
          // No budget, no unlimited → enforce 10k safety limit
          const estimatedTokens = estimateResultTokens(queryResult);
          if (estimatedTokens > 10000) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: `Response too large (~${estimatedTokens} tokens). To proceed, either:\n` +
                    `1. Use inspect_api to inspect the schema and select fewer fields\n` +
                    `2. Set maxTokens (e.g. maxTokens: 4000) to truncate automatically\n` +
                    `3. Set unlimited: true if you need the full response`,
                  estimatedTokens,
                }, null, 2),
              }],
              isError: true,
            };
          }
          const arrayLen = typeof queryResult === "object" && queryResult !== null && !Array.isArray(queryResult)
            ? findPrimaryArrayLength(queryResult)
            : null;
          status = arrayLen !== null ? `COMPLETE (${arrayLen} items)` : "COMPLETE";
          budgetResult = queryResult;
        }

        if (typeof budgetResult === "object" && budgetResult !== null && !Array.isArray(budgetResult)) {
          const qr = budgetResult as Record<string, unknown>;
          attachRateLimit(qr, respHeaders);
          if (!fromCache) {
            qr._schema = schemaToSDL(schema);
            const suggestions = generateSuggestions(schema);
            if (suggestions.length > 0) {
              qr._suggestedQueries = suggestions;
            }
          }
          const pagination = detectPagination(rawData, endpoint?.parameters);
          if (pagination) {
            qr._pagination = pagination;
          }
          const output: Record<string, unknown> = { _status: status, ...qr };
          if (newDataKey) output._dataKey = newDataKey;
          if (cachedDataAge !== undefined) output._dataAge = `${cachedDataAge}s ago (from cache)`;
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(output, null, 2) },
            ],
          };
        }

        const output: Record<string, unknown> = { _status: status, data: budgetResult };
        if (newDataKey) output._dataKey = newDataKey;
        if (cachedDataAge !== undefined) output._dataAge = `${cachedDataAge}s ago (from cache)`;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(output, null, 2) },
          ],
        };
      } catch (error: unknown) {
        return formatToolError(error, apiIndex, "GET", path);
      }
    }
  );
}
