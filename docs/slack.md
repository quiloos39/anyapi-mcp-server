# Slack

Connect to the [Slack Web API](https://api.slack.com/web) to manage channels, messages, users, reactions, and more.

## Prerequisites

- A Slack workspace
- A [Bot token](https://api.slack.com/tutorials/tracks/getting-a-token) (`xoxb-...`) or User token (`xoxp-...`)

## Configuration

```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "slack",
        "--spec", "https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json",
        "--base-url", "https://slack.com/api",
        "--header", "Authorization: Bearer ${SLACK_TOKEN}"
      ],
      "env": {
        "SLACK_TOKEN": "xoxb-your-bot-token"
      }
    }
  }
}
```

## Notes

- Bot tokens (`xoxb-`) are recommended. User tokens (`xoxp-`) give broader access but are tied to a specific user.
- The token's scopes determine which API methods are accessible. Common scopes: `channels:read`, `chat:write`, `users:read`.
- The spec is sourced from Slack's [official API specs repository](https://github.com/slackapi/slack-api-specs).
