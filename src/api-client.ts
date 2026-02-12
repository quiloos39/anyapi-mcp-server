import type { AnyApiConfig } from "./config.js";
import { withRetry, RetryableError, isRetryableStatus } from "./retry.js";
import { buildCacheKey, consumeCached, setCache } from "./response-cache.js";
import { logEntry, isLoggingEnabled } from "./logger.js";
import { parseResponse } from "./response-parser.js";

const TIMEOUT_MS = 30_000;

function interpolatePath(
  pathTemplate: string,
  params: Record<string, unknown>
): { url: string; remainingParams: Record<string, unknown> } {
  const remaining = { ...params };
  const url = pathTemplate.replace(/\{([^}]+)\}/g, (_, paramName: string) => {
    const value = remaining[paramName];
    if (value === undefined) {
      throw new Error(`Missing required path parameter: ${paramName}`);
    }
    delete remaining[paramName];
    return encodeURIComponent(String(value));
  });
  return { url, remainingParams: remaining };
}

/**
 * @param cacheMode
 *   - "populate" — skip cache read, always fetch, store result (used by call_api)
 *   - "consume"  — read-and-evict cache, fetch on miss, do NOT re-store (used by query_api)
 *   - "none"     — no caching at all (default)
 */
export async function callApi(
  config: AnyApiConfig,
  method: string,
  pathTemplate: string,
  params?: Record<string, unknown>,
  body?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  cacheMode: "populate" | "consume" | "none" = "none"
): Promise<unknown> {
  // --- Cache check (consume mode only) ---
  const cacheKey = cacheMode !== "none"
    ? buildCacheKey(method, pathTemplate, params, body, extraHeaders)
    : "";
  if (cacheMode === "consume") {
    const cached = consumeCached(cacheKey);
    if (cached !== undefined) return cached;
  }

  // --- URL construction ---
  const { url: interpolatedPath, remainingParams } = interpolatePath(
    pathTemplate,
    params ?? {}
  );

  let fullUrl = `${config.baseUrl}${interpolatedPath}`;

  if (method === "GET" && Object.keys(remainingParams).length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(remainingParams)) {
      if (v !== undefined && v !== null) {
        qs.append(k, String(v));
      }
    }
    fullUrl += `?${qs.toString()}`;
  }

  const mergedHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...config.headers,
    ...extraHeaders,
  };

  // --- Retry-wrapped fetch ---
  const result = await withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startTime = Date.now();

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: mergedHeaders,
        signal: controller.signal,
      };

      if (body && method !== "GET") {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(fullUrl, fetchOptions);
      const durationMs = Date.now() - startTime;
      const bodyText = await response.text();

      // Log request/response
      if (isLoggingEnabled()) {
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });
        await logEntry({
          timestamp: new Date().toISOString(),
          method,
          url: fullUrl,
          requestHeaders: mergedHeaders,
          requestBody: body,
          responseStatus: response.status,
          responseHeaders,
          responseBody: bodyText,
          durationMs,
        });
      }

      if (!response.ok) {
        const msg = `API error ${response.status} ${response.statusText}: ${bodyText}`;
        if (isRetryableStatus(response.status)) {
          let retryAfterMs: number | undefined;
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (!isNaN(seconds)) retryAfterMs = seconds * 1000;
          }
          throw new RetryableError(msg, response.status, retryAfterMs);
        }
        throw new Error(msg);
      }

      return parseResponse(response.headers.get("content-type"), bodyText);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(
          `Request to ${method} ${pathTemplate} timed out after ${TIMEOUT_MS / 1000}s`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  });

  // --- Cache store (populate mode only) ---
  if (cacheMode === "populate") {
    setCache(cacheKey, result);
  }
  return result;
}
