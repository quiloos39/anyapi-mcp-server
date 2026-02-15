# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git

Never add `Co-Authored-By` lines to commit messages.

## Build & Run

```bash
npm run build          # tsc → ./build/
npm start              # node build/index.js (requires CLI args)
```

```bash
npm test               # vitest run
```

After changes, verify with `npm run build` (strict TypeScript) and `npm test`.

Run the server locally:
```bash
node build/index.js \
  --name <name> \
  --spec <path-or-url> \
  --base-url <url> \
  [--header "Key: Value"] \
  [--log <path>]
```

## Architecture

This is an MCP (Model Context Protocol) server that dynamically exposes any REST API as MCP tools by reading an OpenAPI or Postman Collection spec. It uses stdio transport via `@modelcontextprotocol/sdk`.

**Entry flow:** CLI args → `config.ts` (parses `--name`, `--spec`, `--base-url`, `--header`, `--log`; loads spec from file or HTTPS URL with caching) → `logger.ts` init → `api-index.ts` (parses spec content into endpoint index) → `index.ts` (registers 5 MCP tools on the server).

### Source modules (`src/`)

- **`index.ts`** — MCP server setup. Registers five tools: `list_api`, `call_api` (returns SDL schema + smart query suggestions), `query_api` (fetch data with GraphQL field selection), `explain_api` (returns rich spec documentation without HTTP requests), `batch_query` (concurrent multi-endpoint fetching). `call_api`, `query_api`, and `batch_query` accept optional per-request `headers`.
- **`config.ts`** — CLI argument parsing and `${ENV_VAR}` interpolation for headers/base URL/spec. `--spec` accepts a local file path or HTTPS URL. HTTPS specs are fetched and cached to `~/.cache/anyapi-mcp/` on Linux/macOS or `%LOCALAPPDATA%\anyapi-mcp\` on Windows (keyed by SHA-256 of URL). `loadConfig()` is async. Produces `AnyApiConfig`.
- **`api-index.ts`** — `ApiIndex` class that parses OpenAPI 2.x/3.x (JSON/YAML) and Postman Collection v2.x into a unified endpoint index. Constructor takes spec content string; auto-detects JSON vs YAML (tries JSON.parse first, falls back to YAML). Extracts request body schemas from OpenAPI specs for mutation support. Provides category listing, filtering by tag, and keyword search. Supports `$ref` resolution for request body schemas.
- **`api-client.ts`** — `callApi()` function: the central request pipeline integrating response caching (30s TTL), retry with exponential backoff (3 retries for 429/5xx), 30s request timeout, request/response logging, non-JSON response parsing, and per-request header overrides. Throws `ApiError` (from `error-context.ts`) for non-retryable HTTP failures, carrying status, body text, and response headers.
- **`error-context.ts`** — Rich API error handling. `ApiError` class extends `Error` with `status`, `statusText`, `bodyText`, `responseHeaders`. `extractErrorMessage()` parses 6 common error body formats: RFC 7807 Problem Details, `{ error: { message, code } }`, `{ error: "string" }`, `{ message: "..." }`, `{ errors: [{ message }] }` (GraphQL-style), `{ fault: { faultstring } }` (SOAP/Apigee). `buildErrorContext()` produces structured error responses with extracted message, status-specific suggestion (auth hints for 401, required params for 400/422, etc.), and spec parameter/body schema for validation errors.
- **`graphql-schema.ts`** — Core layer that infers GraphQL schemas from JSON responses using multi-sample merging (up to 10 array elements). Generates mutation types for write operations (POST/PUT/DELETE/PATCH) with input types from OpenAPI request body schemas. Caches schemas per `METHOD:/path:shapeHash` — a structural fingerprint (truncated SHA-256 of recursive key+type structure) ensures the same endpoint returning different shapes gets distinct cached schemas. Exports `computeShapeHash()` for external use. Handles field name sanitization (dashes/dots/spaces → underscores) and circular structure detection.
- **`query-suggestions.ts`** — Generates ready-to-use GraphQL queries by introspecting the inferred schema. Produces suggestions for scalar fields, list fields, items+count patterns, depth-2 full queries, and mutations. Included in `call_api` responses as `suggestedQueries`.
- **`types.ts`** — Shared interfaces (`ApiEndpoint`, `ApiParameter`, `ApiResponse`, `RequestBodySchema`, `CategorySummary`, etc.).
- **`logger.ts`** — NDJSON request/response logger. Masks sensitive headers (`authorization`, `x-api-key`, `cookie`, etc.), truncates large bodies (>10KB). Enabled via `--log <path>`.
- **`retry.ts`** — Generic `withRetry()` wrapper with exponential backoff + jitter. `RetryableError` class for transient HTTP errors (429, 500, 502, 503, 504). Honors `Retry-After` header. 3 retries, 1s base delay, 10s max delay.
- **`response-cache.ts`** — TTL-based response cache keyed by method + path + params + body + headers. 30s default TTL. Prevents duplicate HTTP calls for consecutive `call_api` → `query_api` flows.
- **`response-parser.ts`** — Unified response parser: JSON, XML (via `fast-xml-parser`), CSV (hand-rolled), and plain text fallback. Auto-detects format from `Content-Type` header.

### Key design patterns

- **Request pipeline layering:** `callApi` layers features as: cache check → retry(fetch → log → parse) → cache store. Each concern is in its own module.
- **Schema inference + multi-sample merging:** Arrays sample up to 10 elements and merge their object shapes to capture fields that don't appear in every item. Schemas are cached by `METHOD:/path:shapeHash`, where `shapeHash` is a 12-char hex structural fingerprint of the response data (keys + types, not values). `getOrBuildSchema` returns `{ schema, shapeHash }` and accepts an optional `cacheHash` override for write operations.
- **GraphQL mutations for writes:** POST/PUT/DELETE/PATCH endpoints with OpenAPI request body schemas get a Mutation type with `GraphQLInputObjectType` for the input args, alongside the regular Query type.
- **Two-level pagination:** API-level pagination passes through via `params`; client-side slicing of already-fetched data uses top-level `limit`/`offset`.
- **Spec format detection:** JSON vs YAML is auto-detected (try JSON first, fallback to YAML). Postman collections are detected by `info.schema` containing `schema.getpostman.com`; everything else is treated as OpenAPI. OpenAPI `$ref` resolution is supported for request body schemas.
- **Remote spec caching:** HTTPS spec URLs are fetched once and cached to `~/.cache/anyapi-mcp/` (Linux/macOS) or `%LOCALAPPDATA%\anyapi-mcp\` (Windows), keyed by `<sha256>.{json,yaml}`. Local file paths are read directly.
- **Field name sanitization:** JSON keys with dashes, dots, or spaces become underscores in GraphQL field names. Leading digits get `_` prefix. Resolvers map sanitized names back to original JSON keys.
- **Rich error context:** Non-retryable HTTP errors throw `ApiError` (status, body, headers). `buildErrorContext()` in `error-context.ts` extracts human-readable messages from common error formats, generates status-specific suggestions, and attaches spec info (params, body schema) for 400/422 errors. Used by `call_api`, `query_api`, and `batch_query` tool handlers via `formatToolError()` in `index.ts`.
- **ESM throughout:** The project uses `"type": "module"` with Node16 module resolution. All local imports use `.js` extensions.
