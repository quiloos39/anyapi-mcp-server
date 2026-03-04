import type { AnyApiConfig } from "./config.js";
import { callApi } from "./api-client.js";
import { storeResponse } from "./data-cache.js";

/**
 * Create a pre-write backup by fetching the current state of a resource via GET.
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
    const { data, responseHeaders } = await callApi(
      config,
      "GET",
      path,
      params,
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
