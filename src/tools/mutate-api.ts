import { z } from "zod";
import type { ToolContext } from "./shared.js";
import {
  formatToolError,
  attachRateLimit,
  shrinkageError,
  placeholderError,
} from "./shared.js";
import { callApi } from "../api-client.js";
import {
  getOrBuildSchema,
  schemaToSDL,
  executeQuery,
  computeShapeHash,
} from "../graphql-schema.js";
import { generateSuggestions } from "../query-suggestions.js";
import { isNonJsonResult } from "../response-parser.js";
import { storeResponse, loadResponse } from "../data-cache.js";
import { resolveBody } from "../body-file.js";
import { detectPlaceholders } from "../body-validation.js";
import { createBackup } from "../pre-write-backup.js";
import { extractPathParamNames } from "../pre-write-backup.js";
import { detectArrayShrinkage } from "../write-safety.js";
import { applyPatch, type PatchOperation } from "../json-patch.js";

export function registerMutateApi({ server, config, apiIndex }: ToolContext): void {
  server.tool(
    "mutate_api",
    `Write data to a ${config.name} API endpoint (POST/PUT/PATCH/DELETE). ` +
      "Two modes:\n" +
      "1. Direct: provide 'body' or 'bodyFile' with the full request payload.\n" +
      "2. Patch: provide 'patch' with JSON Patch operations (add/remove/replace). " +
      "The tool automatically fetches the current resource state, applies your patches, " +
      "and sends the complete result — you never need to hold the full data.\n" +
      "Use inspect_api first to understand the endpoint's parameters and body schema. " +
      "Optionally pass 'query' to select specific fields from the response via GraphQL.",
    {
      method: z
        .enum(["POST", "PUT", "DELETE", "PATCH"])
        .describe("HTTP method"),
      path: z
        .string()
        .describe("API path template (e.g. '/api/card/{id}')"),
      params: z
        .record(z.unknown())
        .optional()
        .describe(
          "Path and query parameters. Path params like {id} are interpolated; " +
            "remaining become query string."
        ),
      body: z
        .record(z.unknown())
        .optional()
        .describe(
          "Request body (direct mode). Mutually exclusive with 'patch' and 'bodyFile'."
        ),
      bodyFile: z
        .string()
        .optional()
        .describe(
          "Absolute path to a JSON file for the request body (direct mode). " +
            "Mutually exclusive with 'body' and 'patch'."
        ),
      patch: z
        .array(
          z.object({
            op: z.enum(["add", "remove", "replace"]),
            path: z.string().describe(
              "JSON Pointer path (e.g. '/title', '/panels/3/title', '/tags/-' for append)"
            ),
            value: z.unknown().optional().describe(
              "Value for add/replace operations"
            ),
          })
        )
        .optional()
        .describe(
          "JSON Patch operations (RFC 6902 subset). The tool GETs the current resource, " +
            "applies these patches, and sends the result. " +
            "Mutually exclusive with 'body' and 'bodyFile'."
        ),
      headers: z
        .record(z.string())
        .optional()
        .describe(
          "Additional HTTP headers. Overrides default --header values."
        ),
      query: z
        .string()
        .optional()
        .describe(
          "Optional GraphQL selection query on the response " +
            "(e.g. '{ id name status }' to select specific fields)."
        ),
      skipBackup: z
        .boolean()
        .optional()
        .describe(
          "Skip the automatic pre-write backup for PUT/PATCH (direct mode only). " +
            "Default: false."
        ),
    },
    async ({ method, path, params, body, bodyFile, patch, headers, query, skipBackup }) => {
      try {
        // Validate mutual exclusivity
        const modeCount = [body, bodyFile, patch].filter((x) => x !== undefined).length;
        if (modeCount > 1) {
          return formatToolError(
            new Error("Only one of 'body', 'bodyFile', or 'patch' can be provided."),
            apiIndex
          );
        }

        // --- Patch mode ---
        if (patch !== undefined) {
          return await handlePatchMode(
            { config, apiIndex },
            method, path, params as Record<string, unknown> | undefined,
            patch as PatchOperation[], headers, query
          );
        }

        // --- Direct mode ---
        let resolvedBody: Record<string, unknown> | undefined;
        try {
          resolvedBody = resolveBody(body as Record<string, unknown> | undefined, bodyFile);
        } catch (err) {
          return formatToolError(err, apiIndex);
        }

        // Placeholder detection (except DELETE)
        if (resolvedBody && method !== "DELETE") {
          const endpoint = apiIndex.getEndpoint(method, path);
          const warnings = detectPlaceholders(resolvedBody, endpoint?.requestBodySchema);
          if (warnings.length > 0) return placeholderError(warnings);
        }

        // Pre-write backup for PUT/PATCH
        let backupDataKey: string | undefined;
        if ((method === "PATCH" || method === "PUT") && !skipBackup) {
          backupDataKey = await createBackup(
            config, method, path,
            params as Record<string, unknown> | undefined,
            headers
          );
        }

        // Array shrinkage detection against backup
        if (backupDataKey && resolvedBody) {
          const backupEntry = loadResponse(backupDataKey);
          if (backupEntry) {
            const shrinkWarnings = detectArrayShrinkage(resolvedBody, backupEntry.data);
            if (shrinkWarnings.length > 0) return shrinkageError(shrinkWarnings, { backupDataKey });
          }
        }

        // Execute the request
        const { data: rawData, responseHeaders: respHeaders } = await callApi(
          config,
          method,
          path,
          params as Record<string, unknown> | undefined,
          resolvedBody,
          headers
        );

        return await buildMutateResponse(
          { apiIndex },
          method, path, rawData, respHeaders, resolvedBody,
          query, backupDataKey
        );
      } catch (error: unknown) {
        return formatToolError(error, apiIndex, method, path);
      }
    }
  );
}

/**
 * Patch mode: GET current state, apply patches, send the result.
 */
async function handlePatchMode(
  { config, apiIndex }: Pick<ToolContext, "config" | "apiIndex">,
  method: string,
  path: string,
  params: Record<string, unknown> | undefined,
  operations: PatchOperation[],
  headers: Record<string, string> | undefined,
  query: string | undefined,
) {
  if (operations.length === 0) {
    return formatToolError(new Error("Patch operations array is empty."), apiIndex);
  }

  if (method === "DELETE") {
    return formatToolError(
      new Error("Patch mode is not supported for DELETE — use direct mode (no body) instead."),
      apiIndex
    );
  }

  // Fetch current state (path params only, same as createBackup)
  const pathParamNames = extractPathParamNames(path);
  const pathOnlyParams = params
    ? Object.fromEntries(
        Object.entries(params).filter(([k]) => pathParamNames.has(k))
      )
    : undefined;

  let currentData: unknown;
  let currentHeaders: Record<string, string>;
  try {
    const result = await callApi(
      config,
      "GET",
      path,
      pathOnlyParams && Object.keys(pathOnlyParams).length > 0 ? pathOnlyParams : undefined,
      undefined,
      headers
    );
    currentData = result.data;
    currentHeaders = result.responseHeaders;
  } catch (err) {
    return formatToolError(
      new Error(
        `Patch mode: failed to GET current state of ${path}: ` +
          (err instanceof Error ? err.message : String(err))
      ),
      apiIndex
    );
  }

  // Validate current data is a plain object
  if (typeof currentData !== "object" || currentData === null || Array.isArray(currentData)) {
    return formatToolError(
      new Error(
        `Patch mode requires the GET response to be a JSON object, ` +
          `but got ${Array.isArray(currentData) ? "array" : typeof currentData}. ` +
          `Use direct mode (body/bodyFile) instead.`
      ),
      apiIndex
    );
  }

  // Store pre-patch state as backup
  const backupDataKey = storeResponse("GET", path, currentData, currentHeaders);

  // Apply patches
  let patchedBody: Record<string, unknown>;
  try {
    patchedBody = applyPatch(currentData as Record<string, unknown>, operations);
  } catch (err) {
    return formatToolError(
      new Error(`Patch failed: ${err instanceof Error ? err.message : String(err)}`),
      apiIndex
    );
  }

  // Placeholder detection on patched result
  const endpoint = apiIndex.getEndpoint(method, path);
  const warnings = detectPlaceholders(patchedBody, endpoint?.requestBodySchema);
  if (warnings.length > 0) return placeholderError(warnings);

  // Execute the write with the complete patched body
  const { data: rawData, responseHeaders: respHeaders } = await callApi(
    config,
    method,
    path,
    params,
    patchedBody,
    headers
  );

  return await buildMutateResponse(
    { apiIndex },
    method, path, rawData, respHeaders, patchedBody,
    query, backupDataKey, operations.length
  );
}

/**
 * Build the response for mutate_api (shared between direct and patch modes).
 */
async function buildMutateResponse(
  { apiIndex }: Pick<ToolContext, "apiIndex">,
  method: string,
  path: string,
  rawData: unknown,
  respHeaders: Record<string, string>,
  resolvedBody: Record<string, unknown> | undefined,
  query: string | undefined,
  backupDataKey: string | undefined,
  patchCount?: number,
) {
  const newDataKey = storeResponse(method, path, rawData, respHeaders);

  // Non-JSON response
  if (isNonJsonResult(rawData)) {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({
          rawResponse: rawData,
          responseHeaders: respHeaders,
          ...(newDataKey ? { _dataKey: newDataKey } : {}),
          hint: "This endpoint returned a non-JSON response. The raw content is shown above.",
        }, null, 2) },
      ],
    };
  }

  const endpoint = apiIndex.getEndpoint(method, path);
  const bodyHash = resolvedBody ? computeShapeHash(resolvedBody) : undefined;
  const { schema, fromCache } = getOrBuildSchema(rawData, method, path, endpoint?.requestBodySchema, bodyHash);

  // If query provided, apply GraphQL field selection
  let resultData: unknown = rawData;
  if (query) {
    resultData = await executeQuery(schema, rawData, query);
  }

  const output: Record<string, unknown> = { _status: "COMPLETE" };

  if (query && typeof resultData === "object" && resultData !== null && !Array.isArray(resultData)) {
    Object.assign(output, resultData);
  } else {
    output.data = resultData;
  }

  attachRateLimit(output, respHeaders);
  if (!fromCache) {
    output._schema = schemaToSDL(schema);
    const suggestions = generateSuggestions(schema);
    if (suggestions.length > 0) {
      output._suggestedQueries = suggestions;
    }
  }
  if (newDataKey) output._dataKey = newDataKey;
  if (backupDataKey) {
    output._backupDataKey = backupDataKey;
    output._backupHint = "Pre-write snapshot stored. Use query_api with this dataKey to retrieve original data if needed.";
  }
  if (patchCount !== undefined) {
    output._patchApplied = `${patchCount} operation(s) applied successfully`;
  }

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(output, null, 2) },
    ],
  };
}
