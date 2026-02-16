# Cloudflare

Connect to the [Cloudflare API](https://developers.cloudflare.com/api/) to manage zones, DNS records, workers, and more.

## Prerequisites

- A Cloudflare account
- An [API token](https://dash.cloudflare.com/profile/api-tokens) or Global API Key + email

## Configuration

### Using an API Token (recommended)

```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "cloudflare",
        "--spec", "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml",
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

### Using Global API Key + email

```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "cloudflare",
        "--spec", "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml",
        "--base-url", "https://api.cloudflare.com/client/v4",
        "--header", "X-Auth-Key: ${CF_API_KEY}",
        "--header", "X-Auth-Email: ${CF_EMAIL}"
      ],
      "env": {
        "CF_API_KEY": "your-global-api-key",
        "CF_EMAIL": "your-cloudflare-email"
      }
    }
  }
}
```

## Notes

- The OpenAPI spec is large (~10MB YAML). It will be fetched once and cached locally.
- API tokens are scoped — create one with only the permissions you need.
