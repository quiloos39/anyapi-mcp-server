# Google Workspace (Admin Directory)

Connect to the [Google Admin SDK Directory API](https://developers.google.com/admin-sdk/directory) to manage users, groups, org units, devices, and more using OAuth 2.0.

## Prerequisites

- A Google Cloud project with the Admin SDK API enabled
- OAuth 2.0 credentials (Client ID + Client Secret) from the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- Google Workspace admin access
- `http://localhost` added as an authorized redirect URI in your OAuth client settings (the server uses a random port, so just allow `http://localhost`)

## Configuration

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
        "--oauth-scopes", "https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.group,https://www.googleapis.com/auth/admin.directory.orgunit",
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

## Authentication

After starting the server, authenticate using the `auth` tool:

1. Call `auth` with `action: "start"` — this opens a localhost callback server and returns a Google authorization URL
2. Visit the URL in your browser and sign in with your admin account
3. Call `auth` with `action: "exchange"` — the callback is captured automatically

Tokens are persisted to `~/.cache/anyapi-mcp/tokens/google-workspace.json` and refreshed automatically on subsequent runs.

## Available scopes

Add or remove scopes depending on what you need:

| Scope | Access |
|-------|--------|
| `admin.directory.user` | Manage users |
| `admin.directory.group` | Manage groups |
| `admin.directory.orgunit` | Manage org units |
| `admin.directory.device.mobile` | Manage mobile devices |
| `admin.directory.device.chromeos` | Manage Chrome OS devices |
| `admin.directory.domain` | Manage domains |
| `admin.directory.rolemanagement` | Manage admin roles |
| `admin.directory.customer` | Manage customer info |
| `admin.directory.resource.calendar` | Manage calendar resources |
| `admin.directory.userschema` | Manage custom user schemas |

All scopes are prefixed with `https://www.googleapis.com/auth/`.

## Notes

- `access_type=offline` is required to get a refresh token.
- `prompt=consent` forces the consent screen so you always get a refresh token (useful if re-authenticating).
