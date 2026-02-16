# Datadog

Connect to the [Datadog API](https://docs.datadoghq.com/api/) to query metrics, monitors, dashboards, logs, and more.

## Prerequisites

- A Datadog account
- An [API key](https://app.datadoghq.com/organization-settings/api-keys)
- An [Application key](https://app.datadoghq.com/organization-settings/application-keys)

## Configuration

```json
{
  "mcpServers": {
    "datadog": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "datadog",
        "--spec", "https://raw.githubusercontent.com/DataDog/documentation/master/data/api/v1/full_spec.yaml",
        "--spec", "https://raw.githubusercontent.com/DataDog/documentation/master/data/api/v2/full_spec.yaml",
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

## Notes

- Replace `api.datadoghq.com` with your region's domain if needed (e.g. `api.datadoghq.eu` for EU).
- Both v1 and v2 specs are included — they get merged automatically, giving you access to all Datadog API endpoints.
- API keys and Application keys are different — you need both.
