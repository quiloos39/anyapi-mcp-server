import type { ApiEndpoint } from "./types.js";
import { RetryableError } from "./retry.js";

/**
 * Rich API error carrying status, raw body, and response headers
 * for structured error reporting.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly bodyText: string,
    public readonly responseHeaders: Record<string, string> = {}
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Extract a human-readable error message from common API error response formats:
 * - RFC 7807 Problem Details: { type, title, status, detail }
 * - Stripe/generic: { error: { message, code } }
 * - Simple: { error: "message" } or { message: "..." }
 * - GraphQL-style: { errors: [{ message }] }
 * - SOAP/Apigee: { fault: { faultstring } }
 */
export function extractErrorMessage(bodyText: string): string | undefined {
  if (!bodyText.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;

  // RFC 7807 Problem Details
  if (typeof obj.detail === "string") {
    const title = typeof obj.title === "string" ? obj.title : undefined;
    return title ? `${title}: ${obj.detail}` : obj.detail;
  }

  // { error: { message, code? } }
  if (obj.error && typeof obj.error === "object") {
    const errObj = obj.error as Record<string, unknown>;
    if (typeof errObj.message === "string") {
      const code = typeof errObj.code === "string" ? ` (${errObj.code})` : "";
      return `${errObj.message}${code}`;
    }
  }

  // { error: "message" }
  if (typeof obj.error === "string") {
    return obj.error;
  }

  // { message: "..." }
  if (typeof obj.message === "string") {
    return obj.message;
  }

  // { errors: [{ message }] }
  if (Array.isArray(obj.errors)) {
    const messages = obj.errors
      .filter(
        (e): e is Record<string, unknown> =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as Record<string, unknown>).message === "string"
      )
      .map((e) => e.message as string);
    if (messages.length > 0) return messages.join("; ");
  }

  // { fault: { faultstring } }
  if (obj.fault && typeof obj.fault === "object") {
    const fault = obj.fault as Record<string, unknown>;
    if (typeof fault.faultstring === "string") return fault.faultstring;
  }

  return undefined;
}

function getSuggestion(status: number, endpoint?: ApiEndpoint): string {
  switch (status) {
    case 400: {
      let msg = "Bad request. Check that all required parameters are provided and the request body matches the expected schema.";
      if (endpoint) {
        const required = endpoint.parameters.filter((p) => p.required);
        if (required.length > 0) {
          msg += ` Required parameters: ${required.map((p) => `${p.name} (${p.in})`).join(", ")}.`;
        }
        if (endpoint.hasRequestBody && endpoint.requestBodySchema) {
          const requiredFields = Object.entries(endpoint.requestBodySchema.properties)
            .filter(([, p]) => p.required)
            .map(([name]) => name);
          if (requiredFields.length > 0) {
            msg += ` Required body fields: ${requiredFields.join(", ")}.`;
          }
        }
      }
      return msg;
    }
    case 401:
      return "Authentication required. Use the auth tool to authenticate via OAuth, or provide credentials via --header (e.g. --header \"Authorization: Bearer <token>\") or per-request headers parameter.";
    case 403:
      return "Forbidden. Your credentials don't have permission for this operation. Verify your API key or token has the required scopes.";
    case 404: {
      let msg = "Resource not found. Verify the path and parameter values are correct.";
      if (endpoint) {
        const pathParams = endpoint.parameters.filter((p) => p.in === "path");
        if (pathParams.length > 0) {
          msg += ` Check path parameters: ${pathParams.map((p) => p.name).join(", ")}.`;
        }
      }
      msg += " Use list_api to confirm available endpoints.";
      return msg;
    }
    case 405:
      return "Method not allowed for this endpoint. Use list_api to check which HTTP methods are supported.";
    case 409:
      return "Conflict. The resource may already exist or be in a state that prevents this operation.";
    case 415:
      return "Unsupported media type. The API may expect a different Content-Type header.";
    case 422: {
      let msg = "Validation failed. Check that request body fields match the expected types and formats.";
      if (endpoint?.requestBodySchema) {
        const props = Object.entries(endpoint.requestBodySchema.properties)
          .map(([name, p]) => `${name}: ${p.type}${p.required ? " (required)" : ""}`)
          .join(", ");
        if (props) msg += ` Expected fields: ${props}.`;
      }
      return msg;
    }
    case 429:
      return "Rate limit exceeded (retries exhausted). Wait before trying again or reduce request frequency.";
    default:
      if (status >= 500) {
        return "Server error. This is likely a temporary issue with the API. Try again later.";
      }
      return "Check the API documentation for this endpoint using explain_api.";
  }
}

const MAX_RAW_BODY = 500;

/**
 * Build a rich error response object from an API error or exhausted retry error.
 */
export function buildErrorContext(
  error: ApiError | RetryableError,
  method: string,
  path: string,
  endpoint?: ApiEndpoint
): Record<string, unknown> {
  const isApiError = error instanceof ApiError;
  const status = isApiError ? error.status : (error as RetryableError).status;
  const statusText = isApiError ? error.statusText : "";
  const bodyText = isApiError ? error.bodyText : "";

  const extracted = bodyText ? extractErrorMessage(bodyText) : undefined;

  const result: Record<string, unknown> = {
    error: extracted ?? error.message,
    status,
    ...(statusText ? { statusText } : {}),
    endpoint: `${method} ${path}`,
    suggestion: getSuggestion(status, endpoint),
  };

  // Include raw body snippet when structured extraction failed
  if (!extracted && bodyText.length > 0) {
    result.rawBody =
      bodyText.length > MAX_RAW_BODY
        ? bodyText.slice(0, MAX_RAW_BODY) + "..."
        : bodyText;
  }

  // Include spec info for validation-related errors
  if ((status === 400 || status === 422) && endpoint) {
    if (endpoint.parameters.length > 0) {
      result.specParameters = endpoint.parameters.map((p) => ({
        name: p.name,
        in: p.in,
        required: p.required,
        ...(p.description ? { description: p.description } : {}),
      }));
    }
    if (endpoint.hasRequestBody && endpoint.requestBodySchema) {
      result.specRequestBody = endpoint.requestBodySchema;
    }
  }

  return result;
}
