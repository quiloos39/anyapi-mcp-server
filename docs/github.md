# GitHub

Connect to the [GitHub REST API](https://docs.github.com/en/rest) to manage repositories, issues, pull requests, actions, and more.

## Prerequisites

- A GitHub account
- A [Personal Access Token](https://github.com/settings/tokens) (classic or fine-grained)

## Configuration

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "-y",
        "anyapi-mcp-server",
        "--name", "github",
        "--spec", "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
        "--base-url", "https://api.github.com",
        "--header", "Authorization: Bearer ${GITHUB_TOKEN}"
      ],
      "env": {
        "GITHUB_TOKEN": "your-personal-access-token"
      }
    }
  }
}
```

## Notes

- The GitHub OpenAPI spec is very large. It will be fetched once and cached locally.
- Fine-grained tokens let you scope access to specific repositories and permissions.
- For GitHub Enterprise, replace `api.github.com` with your instance's API URL.
