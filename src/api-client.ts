import type { AnyApiConfig } from "./config.js";
import { withRetry, RetryableError, isRetryableStatus } from "./retry.js";
import { buildCacheKey, consumeCached, setCache } from "./response-cache.js";
import { logEntry, isLoggingEnabled } from "./logger.js";
import { parseResponse } from "./response-parser.js";
import { ApiError } from "./error-context.js";
import { getValidAccessToken, refreshTokens } from "./oauth.js";

export interface ApiResult {
  data: unknown;
  responseHeaders: Record<string, string>;
}

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
): Promise<ApiResult> {
  // --- Cache check (consume mode only) ---
  const cacheKey = cacheMode !== "none"
    ? buildCacheKey(method, pathTemplate, params, body, extraHeaders)
    : "";
  if (cacheMode === "consume") {
    const cached = consumeCached(cacheKey) as ApiResult | undefined;
    if (cached !== undefined) return cached;
  }

  // --- URL construction ---
  const { url: interpolatedPath, remainingParams } = interpolatePath(
    pathTemplate,
    params ?? {}
  );

  let fullUrl = `${config.baseUrl}${interpolatedPath}`;

  if (Object.keys(remainingParams).length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(remainingParams)) {
      if (v !== undefined && v !== null) {
        qs.append(k, String(v));
      }
    }
    fullUrl += `?${qs.toString()}`;
  }

  // Check if an explicit Authorization header was provided by the caller
  const hasExplicitAuth = Object.keys({
    ...config.headers,
    ...extraHeaders,
  }).some((k) => k.toLowerCase() === "authorization");

  const doRequest = async (): Promise<ApiResult> => {
    const mergedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
      ...extraHeaders,
    };

    // Inject OAuth bearer token if no explicit Authorization header
    if (!hasExplicitAuth) {
      const accessToken = await getValidAccessToken(config.oauth);
      if (accessToken) {
        mergedHeaders["Authorization"] = `Bearer ${accessToken}`;
      }
    }

    return withRetry(async () => {
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

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });

        // Log request/response
        if (isLoggingEnabled()) {
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
          if (isRetryableStatus(response.status)) {
            const msg = `API error ${response.status} ${response.statusText}: ${bodyText}`;
            let retryAfterMs: number | undefined;
            const retryAfter = response.headers.get("retry-after");
            if (retryAfter) {
              const seconds = parseInt(retryAfter, 10);
              if (!isNaN(seconds)) retryAfterMs = seconds * 1000;
            }
            throw new RetryableError(msg, response.status, retryAfterMs);
          }
          throw new ApiError(
            `API error ${response.status} ${response.statusText}`,
            response.status,
            response.statusText,
            bodyText,
            responseHeaders
          );
        }

        const parsedData = parseResponse(response.headers.get("content-type"), bodyText);
        return { data: parsedData, responseHeaders } as ApiResult;
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
  };

  // --- Execute with 401 refresh-and-retry ---
  let result: ApiResult;
  try {
    result = await doRequest();
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      config.oauth &&
      !hasExplicitAuth
    ) {
      // Refresh token and retry once
      try {
        await refreshTokens(config.oauth);
        result = await doRequest();
      } catch {
        throw error; // Throw the original 401
      }
    } else {
      throw error;
    }
  }

  // --- Cache store (populate mode only) ---
  if (cacheMode === "populate") {
    setCache(cacheKey, result);
  }
  return result;
}
