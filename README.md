# anyapi-mcp-server

### If it has an API, you can MCP it.

<img src="public/datadog.gif" alt="anyapi-mcp-server demo — Datadog API" width="1200" />

A universal [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that connects **any REST API** to AI assistants like Claude, Cursor, and other LLM-powered tools — just point it at an OpenAPI spec or Postman collection.

Instead of building a custom MCP server for every API, `anyapi-mcp-server` reads your spec file and dynamically creates tools with **GraphQL-style field selection** and automatic schema inference.

## Features

- **Works with any REST API** — provide an OpenAPI (JSON/YAML) or Postman Collection v2.x spec
- **GraphQL-style queries** — select only the fields you need from API responses
- **Automatic schema inference** — calls an endpoint once, infers the response schema, then lets you query specific fields
- **Multi-sample merging** — samples up to 10 array elements to build richer schemas that capture fields missing from individual items
- **Mutation support** — POST/PUT/DELETE/PATCH endpoints with OpenAPI request body schemas get GraphQL mutation types with typed inputs
- **Smart query suggestions** — `call_api` returns ready-to-use GraphQL queries based on the inferred schema
- **Response caching** — 30-second TTL cache prevents duplicate HTTP calls across consecutive `call_api` → `query_api` flows
- **Retry with backoff** — automatic retries with exponential backoff and jitter for 429/5xx errors, honoring `Retry-After` headers
- **Multi-format responses** — parses JSON, XML, CSV, and plain text responses automatically
- **Built-in pagination** — API-level pagination via `params`; client-side slicing with top-level `limit`/`offset`
- **Spec documentation lookup** — `explain_api` returns rich endpoint docs (parameters, response codes, deprecation, request body schema) without making HTTP requests
- **Concurrent batch queries** — `batch_query` fetches data from up to 10 endpoints in parallel, returning all results in one tool call
- **Per-request headers** — override default headers on individual `call_api`/`query_api`/`batch_query` calls
- **Environment variable interpolation** — use `${ENV_VAR}` in base URLs and headers
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

### Either one of

| Flag | Description |
|------|-------------|
| `--spec` | Path to OpenAPI spec file (JSON or YAML) or Postman Collection |
| `--base-url` | API base URL (e.g. `https://api.example.com`). Supports `${ENV_VAR}` interpolation. |

You can provide both `--spec` and `--base-url` together. If only `--spec` is given, the base URL is read from the spec. If only `--base-url` is given, endpoints are discovered dynamically.

### Optional arguments

| Flag | Description |
|------|-------------|
| `--header` | HTTP header as `"Key: Value"` (repeatable). Supports `${ENV_VAR}` interpolation in values. |
| `--log` | Path to request/response log file (NDJSON format). Sensitive headers are masked automatically. |

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
        "--spec", "/path/to/cloudflare-openapi.json",
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
        "--spec", "/path/to/datadog-openapi.json",
        "--base-url", "https://api.datadoghq.com/api/v1",
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

## Tools

The server exposes five MCP tools:

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
- Returns an array of results: `{ method, path, data }` on success or `{ method, path, error }` on failure
- Run `call_api` first on each endpoint to discover the schema field names

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

1. The spec file is parsed at startup into an endpoint index with tags, paths, parameters, and request body schemas
2. `call_api` makes a real HTTP request, infers a GraphQL schema from the JSON response, and caches both the response (30s TTL) and the schema
3. `query_api` re-uses the cached response if called within 30s, executes your GraphQL field selection against the data, and returns only the fields you asked for
4. Write operations (POST/PUT/DELETE/PATCH) with OpenAPI request body schemas get a Mutation type with typed `GraphQLInputObjectType` inputs

## Supported Spec Formats

- **OpenAPI 3.x** (JSON or YAML)
- **OpenAPI 2.0 / Swagger** (JSON or YAML)
- **Postman Collection v2.x** (JSON)

`$ref` resolution is supported for OpenAPI request body schemas. Postman `:param` path variables are converted to OpenAPI-style `{param}` automatically.

## License

Proprietary Non-Commercial. Free for personal and educational use. Commercial use requires written permission. See [LICENSE](LICENSE) for details.
