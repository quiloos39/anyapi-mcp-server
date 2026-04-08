import type { AnyApiConfig } from "./config.js";
import { callApi } from "./api-client.js";
import { storeResponse } from "./data-cache.js";

/**
 * Extract parameter names from a path template (e.g., "/items/{id}" → Set(["id"])).
 */
export function extractPathParamNames(pathTemplate: string): Set<string> {
  const names = new Set<string>();
  pathTemplate.replace(/\{([^}]+)\}/g, (_, name: string) => {
    names.add(name);
    return "";
  });
  return names;
}

/**
 * Create a pre-write backup by fetching the current state of a resource via GET.
 * Only forwards path parameters — query params are stripped to avoid fetching
 * a filtered/paginated subset of the resource.
 * Returns a dataKey for the cached snapshot, or undefined on failure.
 * Failure is non-fatal — errors are logged to stderr.
 */
export async function createBackup(
  config: AnyApiConfig,
  method: string,
  path: string,
  params?: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<string | undefined> {
  if (method !== "PATCH" && method !== "PUT") return undefined;

  try {
    // Only forward path parameters to avoid fetching a filtered/paginated response
    const pathParamNames = extractPathParamNames(path);
    const pathOnlyParams = params
      ? Object.fromEntries(
          Object.entries(params).filter(([k]) => pathParamNames.has(k))
        )
      : undefined;

    const { data, responseHeaders } = await callApi(
      config,
      "GET",
      path,
      pathOnlyParams && Object.keys(pathOnlyParams).length > 0 ? pathOnlyParams : undefined,
      undefined,
      headers
    );
    return storeResponse("GET", path, data, responseHeaders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pre-write-backup: GET ${path} failed: ${msg}\n`);
    return undefined;
  }
}
