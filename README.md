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

The server exposes five tools (plus `auth` when OAuth is configured):

### `list_api` — Browse endpoints

Discover what the API offers. Call with no arguments to see all categories, provide `category` to list endpoints in a tag, or `search` to find endpoints by keyword.

### `call_api` — Inspect an endpoint

Makes a real HTTP request and returns the **inferred GraphQL schema** (SDL) — not the data itself. Use this to discover the response shape and get `suggestedQueries` you can copy into `query_api`.

### `query_api` — Fetch data

Fetches data and returns **only the fields you select** via a GraphQL query. Supports both reads and writes (mutations for POST/PUT/DELETE/PATCH).

```graphql
# Read
{ items { id name status } _count }

# Write
mutation { post_endpoint(input: { name: "example" }) { id } }
```

### `explain_api` — Read the docs

Returns spec documentation for an endpoint (parameters, request body schema, response codes) **without making an HTTP request**.

### `batch_query` — Parallel requests

Fetches data from up to 10 endpoints concurrently in a single tool call. Each request follows the `query_api` flow.

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
call_api          → inspect the response schema
     ↓
query_api         → fetch exactly the fields you need
     ↓
batch_query       → fetch from multiple endpoints at once
```

## How it works

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

## Features

- **Any REST API** — provide an OpenAPI (JSON/YAML) or Postman Collection v2.x spec as a file or URL
- **Remote spec caching** — HTTPS specs are fetched once and cached to `~/.cache/anyapi-mcp/`
- **GraphQL field selection** — query only the fields you need from any response
- **Schema inference** — automatically builds GraphQL schemas from live API responses
- **Multi-sample merging** — samples up to 10 array elements for richer schemas
- **Mutation support** — write operations get typed GraphQL mutations from OpenAPI body schemas
- **Smart suggestions** — `call_api` returns ready-to-use queries based on the inferred schema
- **Response caching** — 30s TTL prevents duplicate calls across `call_api` → `query_api`
- **Retry with backoff** — automatic retries for 429/5xx with exponential backoff and `Retry-After` support
- **Multi-format** — parses JSON, XML, CSV, and plain text responses
- **Pagination** — API-level via `params`, client-side slicing via `limit`/`offset`
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
