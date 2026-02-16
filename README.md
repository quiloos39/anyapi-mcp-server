# anyapi-mcp-server

### If it has an API, you can MCP it.

<img src="public/datadog.gif" alt="anyapi-mcp-server demo — Datadog API" width="1200" />

Traditional MCP servers hand-pick a handful of endpoints and call it a day — locking you into whatever subset someone decided was "enough." Why settle for a fraction of an API when you can have **all of it**?

`anyapi-mcp-server` is a universal [MCP](https://modelcontextprotocol.io) server that connects **any REST API** to AI assistants like Claude, Cursor, and other LLM-powered tools — just point it at an OpenAPI spec or Postman collection. Every endpoint the API provides becomes available instantly, with **GraphQL-style field selection** and automatic schema inference. No custom server code, no artificial limits.

Works with services like **Datadog**, **PostHog**, **Metabase**, **Cloudflare**, **Stripe**, **GitHub**, **Slack**, **Twilio**, **Shopify**, **HubSpot**, and anything else with a REST API — if it has an API, it just works.

## Features

- **Works with any REST API** — provide an OpenAPI (JSON/YAML) or Postman Collection v2.x spec as a local file or HTTPS URL
- **Remote spec caching** — HTTPS spec URLs are fetched once and cached locally in ``~/.cache/anyapi-mcp/` (Linux/macOS) or `%LOCALAPPDATA%\anyapi-mcp\` (Windows)`
- **GraphQL-style queries** — select only the fields you need from API responses
- **Automatic schema inference** — calls an endpoint once, infers the response schema, then lets you query specific fields
- **Multi-sample merging** — samples up to 10 array elements to build richer schemas that capture fields missing from individual items
- **Mutation support** — POST/PUT/DELETE/PATCH endpoints with OpenAPI request body schemas get GraphQL mutation types with typed inputs
- **Smart query suggestions** — `call_api` returns ready-to-use GraphQL queries based on the inferred schema
- **Shape-aware schema caching** — schemas are cached by response structure (not just endpoint), so the same path returning different shapes gets distinct schemas; `shapeHash` is returned for cache-aware workflows
- **Response caching** — 30-second TTL cache prevents duplicate HTTP calls across consecutive `call_api` → `query_api` flows
- **Retry with backoff** — automatic retries with exponential backoff and jitter for 429/5xx errors, honoring `Retry-After` headers
- **Multi-format responses** — parses JSON, XML, CSV, and plain text responses automatically
- **Built-in pagination** — API-level pagination via `params`; client-side slicing with top-level `limit`/`offset`
- **Spec documentation lookup** — `explain_api` returns rich endpoint docs (parameters, response codes, deprecation, request body schema) without making HTTP requests
- **Concurrent batch queries** — `batch_query` fetches data from up to 10 endpoints in parallel, returning all results in one tool call
- **Per-request headers** — override default headers on individual `call_api`/`query_api`/`batch_query` calls
- **Environment variable interpolation** — use `${ENV_VAR}` in base URLs and headers
- **OAuth 2.0 authentication** — supports Authorization Code (with PKCE) and Client Credentials flows via `--oauth-*` CLI flags. A temporary localhost server captures the OAuth callback automatically. Tokens are persisted to `~/.cache/anyapi-mcp/tokens/` and auto-refreshed on expiry. OAuth endpoints can be auto-detected from OpenAPI `securitySchemes`
- **Rich error context** — API errors return structured messages (parses RFC 7807, `{ error: { message, code } }`, `{ errors: [...] }`, and more), status-specific suggestions (e.g. "Authentication required" for 401), and relevant spec info (required parameters, request body schema) for 400/422 errors so the LLM can self-correct
- **Request logging** — optional NDJSON request/response log with sensitive header masking

[![npm](https://img.shields.io/npm/v/anyapi-mcp-server)](https://www.npmjs.com/package/anyapi-mcp-server)

## Installation

```bash
npm install -g anyapi-mcp-server
```

### Required arguments

| Flag | Description |
|------|-------------|
| `--name` | Server name (e.g. `petstore`) |
| `--spec` | Path or HTTPS URL to OpenAPI spec (JSON or YAML) or Postman Collection. HTTPS URLs are cached locally in ``~/.cache/anyapi-mcp/` (Linux/macOS) or `%LOCALAPPDATA%\anyapi-mcp\` (Windows)`. Supports `${ENV_VAR}` interpolation. |
| `--base-url` | API base URL (e.g. `https://api.example.com`). Supports `${ENV_VAR}` interpolation. |

### Optional arguments

| Flag | Description |
|------|-------------|
| `--header` | HTTP header as `"Key: Value"` (repeatable). Supports `${ENV_VAR}` interpolation in values. |
| `--log` | Path to request/response log file (NDJSON format). Sensitive headers are masked automatically. |

### OAuth arguments

All OAuth flags support `${ENV_VAR}` interpolation. If any of `--oauth-client-id`, `--oauth-client-secret`, or `--oauth-token-url` is provided, all three are required.

| Flag | Required | Description |
|------|----------|-------------|
| `--oauth-client-id` | Yes* | OAuth client ID |
| `--oauth-client-secret` | Yes* | OAuth client secret |
| `--oauth-token-url` | Yes* | Token endpoint URL |
| `--oauth-auth-url` | No | Authorization endpoint (required for `authorization_code` flow unless discoverable from the OpenAPI spec's `securitySchemes`) |
| `--oauth-scopes` | No | Comma-separated scopes |
| `--oauth-flow` | No | `authorization_code` (default) or `client_credentials` |
| `--oauth-param` | No | Extra token request parameter as `key=value` (repeatable, e.g. `--oauth-param "access_type=offline"`) |

### Example: Cursor / Claude Desktop configuration

Add to your MCP configuration (e.g. `~/.cursor/mcp.json` or Claude Desktop config):

#### Cloudflare API

```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "cloudflare",
        "--spec", "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
        "--base-url", "https://api.cloudflare.com/client/v4",
        "--header", "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
      ],
      "env": {
        "CLOUDFLARE_API_TOKEN": "your-cloudflare-api-token"
      }
    }
  }
}
```

#### Datadog API

```json
{
  "mcpServers": {
    "datadog": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "datadog",
        "--spec", "https://raw.githubusercontent.com/DataDog/datadog-api-client-typescript/master/.generator/schemas/v1/openapi.yaml",
        "--base-url", "https://api.datadoghq.com",
        "--header", "DD-API-KEY: ${DD_API_KEY}",
        "--header", "DD-APPLICATION-KEY: ${DD_APP_KEY}"
      ],
      "env": {
        "DD_API_KEY": "your-datadog-api-key",
        "DD_APP_KEY": "your-datadog-app-key"
      }
    }
  }
}
```

#### Metabase API

```json
{
  "mcpServers": {
    "metabase": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "metabase",
        "--base-url", "https://your-metabase-instance.com/api",
        "--header", "x-api-key: ${METABASE_API_KEY}"
      ],
      "env": {
        "METABASE_API_KEY": "your-metabase-api-key"
      }
    }
  }
}
```

### Example: Google Workspace with OAuth

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "google-workspace",
        "--spec", "https://raw.githubusercontent.com/APIs-guru/openapi-directory/main/APIs/googleapis.com/admin/directory_v1/openapi.yaml",
        "--base-url", "https://admin.googleapis.com",
        "--oauth-client-id", "${GOOGLE_CLIENT_ID}",
        "--oauth-client-secret", "${GOOGLE_CLIENT_SECRET}",
        "--oauth-auth-url", "https://accounts.google.com/o/oauth2/v2/auth",
        "--oauth-token-url", "https://oauth2.googleapis.com/token",
        "--oauth-scopes", "https://www.googleapis.com/auth/admin.directory.user.readonly",
        "--oauth-param", "access_type=offline",
        "--oauth-param", "prompt=consent"
      ],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

After starting, use the `auth` tool to authenticate: call `auth` with `action: "start"` to get an authorization URL, visit it in a browser, then call `auth` with `action: "exchange"` — the callback is captured automatically via a localhost server. Tokens are persisted and refreshed automatically on subsequent runs.

## Tools

The server exposes five MCP tools (plus `auth` when OAuth is configured):

### `list_api`

Browse and search available API endpoints from the spec.

- Call with no arguments to see all categories/tags
- Provide `category` to list endpoints in a tag
- Provide `search` to search across paths and descriptions
- Results are paginated with `limit` (default 20) and `offset`
- GraphQL selection for categories:
  ```graphql
  {
    items {
      tag
      endpointCount
    }
    _count
  }
  ```
- GraphQL selection for endpoints:
  ```graphql
  {
    items {
      method
      path
      summary
    }
    _count
  }
  ```

### `call_api`

Inspect an API endpoint by making a real request and returning the inferred GraphQL schema (SDL). No response data is returned — use `query_api` to fetch actual data.

- Returns the full schema SDL showing all available fields and types
- Returns accepted parameters (name, location, required) from the API spec
- Returns `suggestedQueries` — ready-to-use GraphQL queries generated from the schema
- Returns `shapeHash` — a structural fingerprint of the response for cache-aware workflows
- Returns `bodyHash` for write operations when a request body is provided
- Accepts optional `headers` to override defaults for this request
- For write operations (POST/PUT/DELETE/PATCH) with request body schemas, the schema includes a Mutation type

### `query_api`

Fetch data from an API endpoint, returning only the fields you select via GraphQL.

- Object responses:
  ```graphql
  {
    id
    name
    collection {
      id
      name
    }
  }
  ```
- Array responses:
  ```graphql
  {
    items {
      id
      name
    }
    _count
  }
  ```
- Mutation syntax for writes:
  ```graphql
  mutation {
    post_endpoint(input: { ... }) {
      id
      name
    }
  }
  ```
- Supports `limit` and `offset` for client-side slicing of already-fetched data
- For API-level pagination, pass limit/offset inside `params` instead
- Accepts optional `headers` to override defaults for this request
- Response includes `_shapeHash` (and `_bodyHash` for writes) for tracking schema identity

### `explain_api`

Get detailed documentation for an endpoint directly from the spec — no HTTP request is made.

- Returns summary, description, operationId, deprecation status, tag
- Lists all parameters with name, location (`path`/`query`/`header`), required flag, and description
- Shows request body schema with property types, required fields, and descriptions
- Lists response status codes with descriptions (e.g. `200 OK`, `404 Not Found`)
- Includes external docs link when available

### `batch_query`

Fetch data from multiple endpoints concurrently in a single tool call.

- Accepts an array of 1–10 requests, each with `method`, `path`, `params`, `body`, `query`, and optional `headers`
- All requests execute in parallel via `Promise.allSettled` — one failure does not affect the others
- Each request follows the `query_api` flow: HTTP fetch → schema inference → GraphQL field selection
- Returns an array of results: `{ method, path, data, shapeHash }` on success or a structured error with status, suggestion, and spec context on failure
- Run `call_api` first on each endpoint to discover the schema field names

### `auth` (when OAuth is configured)

Manage OAuth 2.0 authentication. Only registered when `--oauth-*` flags are provided.

- `action: "start"` — begins the OAuth flow. For `authorization_code`: starts a localhost callback server and returns an authorization URL to visit. For `client_credentials`: exchanges credentials and returns tokens directly
- `action: "exchange"` — completes the authorization code flow. The callback is captured automatically by the localhost server; optionally accepts a `code` parameter for manual entry
- `action: "status"` — returns current token status (authenticated, expired, expiry time, scopes, whether a refresh token is available)

Tokens are persisted to `~/.cache/anyapi-mcp/tokens/<name>.json` (Linux/macOS) or `%LOCALAPPDATA%\anyapi-mcp\tokens\<name>.json` (Windows) and loaded automatically on server restart. Expired tokens are refreshed transparently — `authorization_code` tokens use the refresh token, `client_credentials` tokens are re-acquired. Explicit `Authorization` headers (via `--header` or per-request `headers`) always take priority over OAuth tokens.

## Workflow

1. **Discover** endpoints with `list_api`
2. **Understand** an endpoint with `explain_api` to see its parameters, request body, and response codes
3. **Inspect** a specific endpoint with `call_api` to see the inferred response schema and suggested queries
4. **Query** the endpoint with `query_api` to fetch exactly the fields you need
5. **Batch** multiple queries with `batch_query` when you need data from several endpoints at once

## How It Works

```
OpenAPI/Postman spec
        │
        ▼
   ┌─────────┐  ┌─────────────┐  ┌──────────┐  ┌───────────┐  ┌─────────────┐
   │list_api │  │ explain_api │  │ call_api │  │ query_api │  │ batch_query │
   │(browse) │  │   (docs)    │  │ (schema) │  │  (data)   │  │ (parallel)  │
   └─────────┘  └─────────────┘  └──────────┘  └───────────┘  └─────────────┘
        │          │ no HTTP          │               │             │
        ▼          ▼ request          ▼               ▼             ▼
   Spec index   Spec index     REST API call    REST API call  N concurrent
   (tags,       (params,       (with retry      (cached if     REST API calls
    paths)       responses,     + caching)       same as        + GraphQL
                 body schema)       │            call_api)      execution
                                    ▼               │
                               Infer GraphQL        ▼
                               schema from     Execute GraphQL
                               JSON response   query against
                                               response data
```

1. The spec is loaded at startup (from a local file or fetched from an HTTPS URL with filesystem caching) and parsed into an endpoint index with tags, paths, parameters, and request body schemas
2. `call_api` makes a real HTTP request, infers a GraphQL schema from the JSON response, and caches both the response (30s TTL) and the schema. Schemas are keyed by endpoint + response shape, so the same path returning different structures gets distinct schemas
3. `query_api` re-uses the cached response if called within 30s, executes your GraphQL field selection against the data, and returns only the fields you asked for. Includes `_shapeHash` in the response for tracking schema identity
4. Write operations (POST/PUT/DELETE/PATCH) with OpenAPI request body schemas get a Mutation type with typed `GraphQLInputObjectType` inputs
5. When an API call fails, the error response includes a parsed error message (extracted from common formats like RFC 7807 Problem Details, `{ error: { message } }`, GraphQL-style `{ errors: [...] }`), the HTTP status code, a status-specific suggestion for what to try next, and — for validation errors (400/422) — the full parameter list and request body schema from the spec

## Supported Spec Formats

- **OpenAPI 3.x** (JSON or YAML)
- **OpenAPI 2.0 / Swagger** (JSON or YAML)
- **Postman Collection v2.x** (JSON)

`$ref` resolution is supported for OpenAPI request body schemas. Postman `:param` path variables are converted to OpenAPI-style `{param}` automatically.

## License

Proprietary Non-Commercial. Free for personal and educational use. Commercial use requires written permission. See [LICENSE](LICENSE) for details.
