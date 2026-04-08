# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git

Never add `Co-Authored-By` lines to commit messages.

## Build & Test

```bash
npm run build          # tsc → ./build/ (strict mode)
npm test               # vitest run (all tests)
npx vitest run tests/graphql-schema.test.ts   # single test file
npx vitest run -t "finds items array"         # single test by name
```

After changes, always verify with `npm run build && npm test`.

Run the server locally:
```bash
node build/index.js \
  --name <name> \
  --spec <path-or-url> \
  --base-url <url> \
  [--header "Key: Value"] \
  [--log <path>] \
  [--oauth-client-id <id>] \
  [--oauth-client-secret <secret>] \
  [--oauth-token-url <url>] \
  [--oauth-auth-url <url>] \
  [--oauth-scopes <scope1,scope2>] \
  [--oauth-flow authorization_code|client_credentials] \
  [--oauth-param "key=value"]
```

## Architecture

MCP server that dynamically exposes any REST API as MCP tools by reading an OpenAPI or Postman Collection spec. Uses stdio transport via `@modelcontextprotocol/sdk`.

**Startup flow:** CLI args → `config.ts` (parse args, load spec from file/URL) → `logger.ts` init → `api-index.ts` (parse spec into endpoint index) → `oauth.ts` init → `index.ts` (create server, register tools, connect stdio).

### Tool modules (`src/tools/`)

Each MCP tool lives in its own file under `src/tools/`, exporting a `register*` function that takes a `ToolContext` (`{ server, config, apiIndex }`):

- **`list-api.ts`** — Discover endpoints. Filters by category/search, returns paginated results via GraphQL query.
- **`inspect-api.ts`** — Understand an endpoint before using it. For GET: makes HTTP request, infers GraphQL schema, returns SDL + suggestions + field costs + `dataKey`. For non-GET (POST/PUT/PATCH/DELETE): returns spec documentation only (parameters, body schema, responses) — no HTTP request, always safe.
- **`query-api.ts`** — Read data (GET only) with GraphQL field selection. Supports `dataKey` reuse (zero HTTP calls), three-mode token budget (none/maxTokens/unlimited). No write safety needed.
- **`mutate-api.ts`** — Write data (POST/PUT/PATCH/DELETE). Two modes: direct (body/bodyFile) with full write-safety pipeline, or patch mode (JSON Patch operations) that auto-fetches current state, applies patches, and sends the complete result — the LLM never needs to hold large resources in context.
- **`auth.ts`** — OAuth 2.0 flow management (start/exchange/status). Only registered when `--oauth-*` flags are provided.
- **`shared.ts`** — `ToolContext` type, `WRITE_METHODS`, shared error formatters (`formatToolError`, `shrinkageError`, `placeholderError`, `attachRateLimit`).

### Core pipeline

The request path through the codebase:

1. **Spec parsing** (`api-index.ts`): OpenAPI 2.x/3.x or Postman → unified `ApiEndpoint[]`. Auto-detects JSON vs YAML.
2. **HTTP execution** (`api-client.ts`): rate-limit pre-check → retry with backoff → OAuth token injection → response parsing. Throws `ApiError` for failures.
3. **Schema inference** (`graphql-schema.ts`): JSON response → GraphQL schema via multi-sample merging (10 elements, 60% majority-type resolution). Cached by `METHOD:/path:shapeHash`. Write endpoints get Mutation types from OpenAPI request body schemas.
4. **Token budget** (`token-budget.ts`): Binary search on the deepest/largest array to fit within a token limit. Three modes: reject >10k, truncate to budget, or unlimited.
5. **Response caching** (`data-cache.ts`): Filesystem cache with 5-min TTL. `storeResponse` returns 8-char `dataKey`; `query_api` and `inspect_api` accept `dataKey` to skip HTTP entirely.
6. **JSON Patch** (`json-patch.ts`): RFC 6902 subset (add/remove/replace) used by `mutate_api` patch mode to apply targeted changes to large resources without full-state transfer.

### Key conventions

- **ESM throughout.** `"type": "module"` with Node16 resolution. All local imports must use `.js` extensions.
- **Field name sanitization.** JSON keys with dashes/dots/spaces become underscores in GraphQL. Leading digits get `_` prefix. Resolvers map sanitized names back to original keys.
- **Write safety.** PUT/PATCH requests in direct mode get automatic pre-write backups (`pre-write-backup.ts`), placeholder detection (`body-validation.ts`), and array shrinkage detection (`write-safety.ts`). Patch mode bypasses shrinkage detection since the body is always complete.
- **Read/write tool separation.** `query_api` is GET-only (always safe). `mutate_api` handles all writes. `inspect_api` never executes write methods. This prevents accidental mutations.
- **Schema caching key.** `METHOD:/path:shapeHash` where `shapeHash` is a 12-char hex SHA-256 of the response's recursive key+type structure (not values). Same endpoint with different response shapes gets distinct cached schemas.
- **`_`-prefixed fields** in query results are metadata (`_status`, `_dataKey`, `_count`, `_rateLimit`, etc.) and are skipped during array truncation/detection.
