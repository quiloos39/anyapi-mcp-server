import { describe, it, expect } from "vitest";
import {
  ApiError,
  extractErrorMessage,
  buildErrorContext,
} from "../src/error-context.js";
import { RetryableError } from "../src/retry.js";
import type { ApiEndpoint } from "../src/types.js";

describe("extractErrorMessage", () => {
  it("returns undefined for empty body", () => {
    expect(extractErrorMessage("")).toBeUndefined();
    expect(extractErrorMessage("   ")).toBeUndefined();
  });

  it("returns undefined for non-JSON body", () => {
    expect(extractErrorMessage("<html>Not Found</html>")).toBeUndefined();
  });

  it("returns undefined for non-object JSON", () => {
    expect(extractErrorMessage('"just a string"')).toBeUndefined();
    expect(extractErrorMessage("42")).toBeUndefined();
  });

  it("parses RFC 7807 Problem Details with title and detail", () => {
    const body = JSON.stringify({
      type: "https://example.com/probs/out-of-credit",
      title: "Out of Credit",
      status: 403,
      detail: "Your account has insufficient funds.",
    });
    expect(extractErrorMessage(body)).toBe(
      "Out of Credit: Your account has insufficient funds."
    );
  });

  it("parses RFC 7807 with detail only (no title)", () => {
    const body = JSON.stringify({ detail: "Something went wrong." });
    expect(extractErrorMessage(body)).toBe("Something went wrong.");
  });

  it("parses { error: { message, code } } format", () => {
    const body = JSON.stringify({
      error: { message: "Invalid API key", code: "auth_invalid" },
    });
    expect(extractErrorMessage(body)).toBe("Invalid API key (auth_invalid)");
  });

  it("parses { error: { message } } without code", () => {
    const body = JSON.stringify({ error: { message: "Bad request" } });
    expect(extractErrorMessage(body)).toBe("Bad request");
  });

  it("parses { error: 'string' } format", () => {
    const body = JSON.stringify({ error: "rate_limit_exceeded" });
    expect(extractErrorMessage(body)).toBe("rate_limit_exceeded");
  });

  it("parses { message: 'string' } format", () => {
    const body = JSON.stringify({ message: "Not found" });
    expect(extractErrorMessage(body)).toBe("Not found");
  });

  it("parses { errors: [{ message }] } array format", () => {
    const body = JSON.stringify({
      errors: [
        { message: "Field 'email' is required" },
        { message: "Field 'name' must be a string" },
      ],
    });
    expect(extractErrorMessage(body)).toBe(
      "Field 'email' is required; Field 'name' must be a string"
    );
  });

  it("parses { fault: { faultstring } } SOAP format", () => {
    const body = JSON.stringify({
      fault: { faultstring: "Rate limit quota violation" },
    });
    expect(extractErrorMessage(body)).toBe("Rate limit quota violation");
  });

  it("returns undefined for unrecognized JSON structure", () => {
    const body = JSON.stringify({ code: 500, data: null });
    expect(extractErrorMessage(body)).toBeUndefined();
  });
});

describe("ApiError", () => {
  it("carries status, statusText, bodyText, and responseHeaders", () => {
    const err = new ApiError("test", 404, "Not Found", '{"error":"nope"}', {
      "x-request-id": "abc",
    });
    expect(err.name).toBe("ApiError");
    expect(err.status).toBe(404);
    expect(err.statusText).toBe("Not Found");
    expect(err.bodyText).toBe('{"error":"nope"}');
    expect(err.responseHeaders).toEqual({ "x-request-id": "abc" });
    expect(err.message).toBe("test");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("buildErrorContext", () => {
  const makeEndpoint = (overrides: Partial<ApiEndpoint> = {}): ApiEndpoint => ({
    method: "POST",
    path: "/users",
    summary: "Create user",
    description: "",
    tag: "users",
    parameters: [],
    hasRequestBody: false,
    ...overrides,
  });

  it("extracts structured error message from body", () => {
    const err = new ApiError("API error 400", 400, "Bad Request", '{"message":"Invalid email"}');
    const ctx = buildErrorContext(err, "POST", "/users");
    expect(ctx.error).toBe("Invalid email");
    expect(ctx.status).toBe(400);
    expect(ctx.statusText).toBe("Bad Request");
    expect(ctx.endpoint).toBe("POST /users");
    expect(ctx.suggestion).toContain("Bad request");
    expect(ctx.rawBody).toBeUndefined(); // extracted, so no raw
  });

  it("falls back to raw body when extraction fails", () => {
    const err = new ApiError("API error 400", 400, "Bad Request", "<html>Error</html>");
    const ctx = buildErrorContext(err, "GET", "/items");
    expect(ctx.error).toBe("API error 400");
    expect(ctx.rawBody).toBe("<html>Error</html>");
  });

  it("truncates long raw bodies", () => {
    const longBody = "x".repeat(1000);
    const err = new ApiError("API error 400", 400, "Bad Request", longBody);
    const ctx = buildErrorContext(err, "GET", "/items");
    expect((ctx.rawBody as string).length).toBe(503); // 500 + "..."
    expect((ctx.rawBody as string).endsWith("...")).toBe(true);
  });

  it("includes spec parameters for 400 errors", () => {
    const endpoint = makeEndpoint({
      parameters: [
        { name: "email", in: "query", required: true, description: "User email" },
        { name: "name", in: "query", required: false },
      ],
    });
    const err = new ApiError("API error 400", 400, "Bad Request", "{}");
    const ctx = buildErrorContext(err, "POST", "/users", endpoint);
    expect(ctx.specParameters).toBeDefined();
    expect((ctx.specParameters as unknown[]).length).toBe(2);
    expect(ctx.suggestion).toContain("email (query)");
  });

  it("includes request body schema for 422 errors", () => {
    const endpoint = makeEndpoint({
      hasRequestBody: true,
      requestBodySchema: {
        contentType: "application/json",
        properties: {
          email: { type: "string", required: true },
          age: { type: "integer", required: false },
        },
      },
    });
    const err = new ApiError("API error 422", 422, "Unprocessable Entity", '{"message":"bad"}');
    const ctx = buildErrorContext(err, "POST", "/users", endpoint);
    expect(ctx.specRequestBody).toBeDefined();
    expect(ctx.suggestion).toContain("email: string (required)");
  });

  it("generates auth suggestion for 401", () => {
    const err = new ApiError("API error 401", 401, "Unauthorized", '{"error":"invalid_token"}');
    const ctx = buildErrorContext(err, "GET", "/me");
    expect(ctx.error).toBe("invalid_token");
    expect(ctx.suggestion).toContain("Authentication required");
    expect(ctx.suggestion).toContain("Authorization");
  });

  it("generates forbidden suggestion for 403", () => {
    const err = new ApiError("API error 403", 403, "Forbidden", "{}");
    const ctx = buildErrorContext(err, "DELETE", "/admin/users/1");
    expect(ctx.suggestion).toContain("Forbidden");
    expect(ctx.suggestion).toContain("permission");
  });

  it("generates not-found suggestion with path params", () => {
    const endpoint = makeEndpoint({
      method: "GET",
      path: "/users/{id}",
      parameters: [{ name: "id", in: "path", required: true }],
    });
    const err = new ApiError("API error 404", 404, "Not Found", "");
    const ctx = buildErrorContext(err, "GET", "/users/{id}", endpoint);
    expect(ctx.suggestion).toContain("path parameters: id");
    expect(ctx.suggestion).toContain("list_api");
  });

  it("generates method suggestion for 405", () => {
    const err = new ApiError("API error 405", 405, "Method Not Allowed", "");
    const ctx = buildErrorContext(err, "DELETE", "/readonly");
    expect(ctx.suggestion).toContain("Method not allowed");
  });

  it("generates rate-limit suggestion for 429", () => {
    const err = new RetryableError("API error 429", 429);
    const ctx = buildErrorContext(err, "GET", "/items");
    expect(ctx.suggestion).toContain("Rate limit exceeded");
  });

  it("generates server error suggestion for 5xx", () => {
    const err = new RetryableError("API error 502", 502);
    const ctx = buildErrorContext(err, "GET", "/items");
    expect(ctx.suggestion).toContain("Server error");
    expect(ctx.suggestion).toContain("temporary");
  });

  it("handles RetryableError (no bodyText)", () => {
    const err = new RetryableError("API error 500 Internal Server Error: {}", 500);
    const ctx = buildErrorContext(err, "GET", "/items");
    expect(ctx.status).toBe(500);
    expect(ctx.error).toBe("API error 500 Internal Server Error: {}");
    expect(ctx.endpoint).toBe("GET /items");
  });

  it("generates generic suggestion for unknown status", () => {
    const err = new ApiError("API error 418", 418, "I'm a Teapot", "");
    const ctx = buildErrorContext(err, "GET", "/brew");
    expect(ctx.suggestion).toContain("explain_api");
  });
});
