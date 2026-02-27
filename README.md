# anyapi-mcp-server

### If it has an API, you can MCP it.

<img src="public/datadog.gif" alt="anyapi-mcp-server demo — Datadog API" width="1200" />

Traditional MCP servers hand-pick a handful of endpoints and call it a day — locking you into whatever subset someone decided was "enough." Why settle for a fraction of an API when you can have **all of it**?

`anyapi-mcp-server` is a universal [MCP](https://modelcontextprotocol.io) server that connects **any REST API** to AI assistants like Claude, Cursor, and other LLM-powered tools — just point it at an OpenAPI spec or Postman collection. Every endpoint the API provides becomes available instantly, with **GraphQL-style field selection** and automatic schema inference. No custom server code, no artificial limits.

[![npm](https://img.shields.io/npm/v/anyapi-mcp-server)](https://www.npmjs.com/package/anyapi-mcp-server)

## Quick start

**1. Install**

```bash
npm install -g anyapi-mcp-server
```

**2. Add to your MCP client** (Cursor, Claude Desktop, etc.)

```json
{
  "mcpServers": {
    "your-api": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "your-api",
        "--spec", "path/to/openapi.json",
        "--base-url", "https://api.example.com",
        "--header", "Authorization: Bearer ${API_KEY}"
      ],
      "env": {
        "API_KEY": "your-api-key"
      }
    }
  }
}
```

**3. Use the tools** — discover endpoints with `list_api`, inspect schemas with `call_api`, fetch data with `query_api`.

## Provider examples

Ready-to-use configurations for popular APIs:

| Provider | Auth |
|----------|------|
| [Cloudflare](docs/cloudflare.md) | API Token or Key + Email |
| [Datadog](docs/datadog.md) | API Key + App Key |
| [GitHub](docs/github.md) | Personal Access Token |
| [Google Workspace](docs/google-workspace.md) | OAuth 2.0 |
| [Metabase](docs/metabase.md) | API Key |
| [PostHog](docs/posthog.md) | Personal API Key |
| [Slack](docs/slack.md) | Bot/User Token |

These work with any API that has an OpenAPI or Postman spec — the above are just examples. Stripe, Twilio, Shopify, HubSpot, and anything else with a REST API will work the same way.

## CLI reference

### Required flags

| Flag | Description |
|------|-------------|
| `--name` | Server name (e.g. `cloudflare`) |
| `--spec` | Path or HTTPS URL to an OpenAPI spec (JSON/YAML) or Postman Collection. Remote URLs are cached locally. Supports `${ENV_VAR}`. |
| `--base-url` | API base URL (e.g. `https://api.example.com`). Supports `${ENV_VAR}`. |

### Optional flags

| Flag | Description |
|------|-------------|
| `--header` | HTTP header as `"Key: Value"` (repeatable). Supports `${ENV_VAR}` in values. |
| `--log` | Path to NDJSON request/response log. Sensitive headers are masked automatically. |

### OAuth flags

For APIs that use OAuth 2.0 instead of static tokens. If any of the three required flags is provided, all three are required. All flags support `${ENV_VAR}`.

| Flag | Required | Description |
|------|----------|-------------|
| `--oauth-client-id` | Yes* | OAuth client ID |
| `--oauth-client-secret` | Yes* | OAuth client secret |
| `--oauth-token-url` | Yes* | Token endpoint URL |
| `--oauth-auth-url` | No | Authorization endpoint (auto-detected from spec if available) |
| `--oauth-scopes` | No | Comma-separated scopes |
| `--oauth-flow` | No | `authorization_code` (default) or `client_credentials` |
| `--oauth-param` | No | Extra token parameter as `key=value` (repeatable) |

See the [Google Workspace guide](docs/google-workspace.md) for a complete OAuth example.

## Tools

The server exposes four tools (plus `auth` when OAuth is configured):

### `list_api` — Browse endpoints

Discover what the API offers. Call with no arguments to see all categories, provide `category` to list endpoints in a tag, or `search` to find endpoints by keyword.

### `call_api` — Inspect an endpoint

Makes a real HTTP request and returns the **inferred GraphQL schema** (SDL) — not the data itself. Use this to discover the response shape and get `suggestedQueries` you can copy into `query_api`. Also returns per-field token costs (`fieldTokenCosts`) and a `dataKey` for cache reuse.

### `query_api` — Fetch data

Fetches data and returns **only the fields you select** via a GraphQL query. Supports both reads and writes (mutations for POST/PUT/DELETE/PATCH). Pass a `dataKey` from `call_api` to reuse cached data with zero HTTP calls.

```graphql
# Read
{ items { id name status } _count }

# Write
mutation { post_endpoint(input: { name: "example" }) { id } }
```

Key parameters:
- **`maxTokens`** — token budget for the response (default 4000). Arrays are truncated to fit.
- **`dataKey`** — reuse cached data from a previous `call_api` or `query_api` response.
- **`jsonFilter`** — dot-path to extract nested values after the GraphQL query (e.g. `"data[].attributes.name"`).

### `explain_api` — Read the docs

Returns spec documentation for an endpoint (parameters, request body schema, response codes) **without making an HTTP request**.

### `auth` — OAuth authentication

Only available when `--oauth-*` flags are configured. Manages the OAuth flow:
- `action: "start"` — returns an authorization URL (or exchanges credentials for `client_credentials`)
- `action: "exchange"` — completes the authorization code flow (callback is captured automatically)
- `action: "status"` — shows current token status

Tokens are persisted and refreshed automatically.

## Typical workflow

```
list_api          → discover what's available
     ↓
explain_api       → read the docs for an endpoint
     ↓
call_api          → inspect the response schema (returns dataKey)
     ↓
query_api         → fetch exactly the fields you need (pass dataKey for zero HTTP calls)
     ↓
query_api         → re-query with different fields using the same dataKey
```

## How it works

```
OpenAPI/Postman spec
        │
        ▼
   ┌─────────┐  ┌─────────────┐  ┌──────────┐  ┌───────────┐
   │list_api │  │ explain_api │  │ call_api │  │ query_api │
   │(browse) │  │   (docs)    │  │ (schema) │  │  (data)   │
   └─────────┘  └─────────────┘  └──────────┘  └───────────┘
        │          │ no HTTP          │               │
        ▼          ▼ request          ▼               ▼
   Spec index   Spec index     REST API call    dataKey cache
   (tags,       (params,       (with retry)     hit → no HTTP
    paths)       responses,         │            miss → fetch
                 body schema)       ▼               │
                               Infer schema +       ▼
                               return dataKey   Execute GraphQL
                                                + token budget
                                                  truncation
```

## Features

- **Any REST API** — provide an OpenAPI (JSON/YAML) or Postman Collection v2.x spec as a file or URL
- **Remote spec caching** — HTTPS specs are fetched once and cached to `~/.cache/anyapi-mcp/`
- **GraphQL field selection** — query only the fields you need from any response
- **Schema inference** — automatically builds GraphQL schemas from live API responses
- **Multi-sample merging** — samples up to 10 array elements for richer schemas
- **Mutation support** — write operations get typed GraphQL mutations from OpenAPI body schemas
- **Smart suggestions** — `call_api` returns ready-to-use queries based on the inferred schema
- **Response caching** — filesystem-based cache with 5-min TTL; `dataKey` tokens let `query_api` reuse data with zero HTTP calls
- **Token budget** — `query_api` accepts `maxTokens` (default 4000) and truncates array results to fit via binary search
- **Per-field token costs** — `call_api` returns a `fieldTokenCosts` tree so the LLM can make informed field selections
- **Rate limit tracking** — parses `X-RateLimit-*` headers and warns when limits are nearly exhausted
- **Pagination detection** — auto-detects cursor, next-page-token, and link-based pagination patterns in responses
- **JSON filter** — `query_api` accepts a `jsonFilter` dot-path for post-query extraction (e.g. `"data[].name"`)
- **Retry with backoff** — automatic retries for 429/5xx with exponential backoff and `Retry-After` support
- **Multi-format** — parses JSON, XML, CSV, and plain text responses
- **Rich errors** — structured error messages with status-specific suggestions and spec context for self-correction
- **OAuth 2.0** — Authorization Code (with PKCE) and Client Credentials flows with automatic token refresh
- **Env var interpolation** — `${ENV_VAR}` in base URLs, headers, and spec paths
- **Request logging** — optional NDJSON log with sensitive header masking

## Supported spec formats

- **OpenAPI 3.x** (JSON or YAML)
- **OpenAPI 2.0 / Swagger** (JSON or YAML)
- **Postman Collection v2.x** (JSON)

## License

Proprietary Non-Commercial. Free for personal and educational use. Commercial use requires written permission. See [LICENSE](LICENSE) for details.
