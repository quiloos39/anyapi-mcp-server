# Metabase

Connect to the [Metabase API](https://www.metabase.com/docs/latest/api-documentation) to query dashboards, questions, databases, and more.

## Prerequisites

- A Metabase instance with API access enabled
- An [API key](https://www.metabase.com/docs/latest/people-and-groups/api-keys)

## Configuration

Metabase serves its own OpenAPI spec at `/api/docs/openapi.json`, so you can point the `--spec` directly at your instance:

```json
{
  "mcpServers": {
    "metabase": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "metabase",
        "--spec", "${BASE_URL}/api/docs/openapi.json",
        "--base-url", "${BASE_URL}",
        "--header", "X-API-KEY: ${API_TOKEN}"
      ],
      "env": {
        "API_TOKEN": "your-metabase-api-key",
        "BASE_URL": "https://your-metabase-instance.com"
      }
    }
  }
}
```

## Notes

- The `${BASE_URL}` variable is reused in both `--spec` and `--base-url` so you only need to set your instance URL once.
- Metabase's built-in OpenAPI spec covers all available endpoints — no external spec file needed.
- Replace `https://your-metabase-instance.com` with your actual Metabase URL (no trailing `/api`).
