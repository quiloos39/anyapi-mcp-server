# PostHog

Connect to the [PostHog API](https://posthog.com/docs/api) to query events, feature flags, persons, insights, and more.

## Prerequisites

- A PostHog account
- A [Personal API key](https://posthog.com/docs/api#personal-api-keys)

## Configuration

PostHog serves its own OpenAPI spec at `/api/schema/`:

```json
{
  "mcpServers": {
    "posthog": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "posthog",
        "--spec", "https://us.posthog.com/api/schema/",
        "--base-url", "https://us.i.posthog.com",
        "--header", "Authorization: Bearer ${POSTHOG_API_KEY}"
      ],
      "env": {
        "POSTHOG_API_KEY": "your-posthog-personal-api-key"
      }
    }
  }
}
```

## Notes

- If you're on the EU region, replace `us.posthog.com` and `us.i.posthog.com` with `eu.posthog.com` and `eu.i.posthog.com`.
- For self-hosted PostHog, use your instance URL for both `--spec` and `--base-url`.
- The spec URL (`/api/schema/`) and the base URL (`us.i.posthog.com`) are different hosts — this is expected.
