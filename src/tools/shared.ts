import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnyApiConfig } from "../config.js";
import type { ApiIndex } from "../api-index.js";
import { ApiError, buildErrorContext } from "../error-context.js";
import { RetryableError } from "../retry.js";
import { parseRateLimits } from "../api-client.js";
import type { RateLimitInfo } from "../types.js";

export const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export interface ToolContext {
  server: McpServer;
  config: AnyApiConfig;
  apiIndex: ApiIndex;
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

export function formatToolError(
  error: unknown,
  apiIndex: ApiIndex,
  method?: string,
  path?: string,
): ToolResult {
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

export function attachRateLimit(
  result: Record<string, unknown>,
  respHeaders: Record<string, string>,
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

export function shrinkageError(
  warnings: unknown[],
  keyInfo: { dataKey?: string; backupDataKey?: string },
): ToolResult {
  const keyLabel = keyInfo.backupDataKey ? "backupDataKey" : "dataKey";
  const keyValue = keyInfo.backupDataKey ?? keyInfo.dataKey;
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "Array shrinkage detected: request body has significantly fewer array items than current state",
        warnings,
        ...(keyValue ? { [keyLabel]: keyValue } : {}),
        hint: "This often happens when truncated query results are sent back as the full payload. " +
          "Consider using mutate_api with 'patch' mode to apply targeted changes without needing the full data. " +
          "Or use query_api with unlimited: true and the " + keyLabel + " to retrieve the full current data. " +
          "If this is intentional, use skipBackup: true to bypass this check.",
      }, null, 2),
    }],
    isError: true,
  };
}

export function placeholderError(warnings: unknown[]): ToolResult {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "Potential placeholder values detected in request body",
        warnings,
        hint: "The request was blocked to prevent sending placeholder data. " +
          "If the body is too large to send inline, use the 'bodyFile' parameter " +
          "with an absolute path to a JSON file containing the real content.",
      }, null, 2),
    }],
    isError: true,
  };
}
