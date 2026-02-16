import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OAuthConfig, OAuthFlow } from "./types.js";

export interface AnyApiConfig {
  name: string;
  specs: string[];
  baseUrl: string;
  headers?: Record<string, string>;
  logPath?: string;
  oauth?: OAuthConfig;
}

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || !process.argv[idx + 1]) return undefined;
  return process.argv[idx + 1];
}

function getAllArgs(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) {
      values.push(process.argv[i + 1]);
    }
  }
  return values;
}

function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not set`);
    }
    return envValue;
  });
}

const CACHE_DIR = process.platform === "win32"
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "anyapi-mcp")
  : join(homedir(), ".cache", "anyapi-mcp");

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function loadSpec(specValue: string): Promise<string> {
  if (!isUrl(specValue)) {
    return readFileSync(resolve(specValue), "utf-8");
  }

  const hash = createHash("sha256").update(specValue).digest("hex");
  const ext = /\.ya?ml$/i.test(specValue) ? ".yaml" : ".json";
  const cachePath = join(CACHE_DIR, hash + ext);

  if (existsSync(cachePath)) {
    return readFileSync(cachePath, "utf-8");
  }

  const res = await fetch(specValue);
  if (!res.ok) {
    throw new Error(`Failed to fetch spec from ${specValue}: ${res.status} ${res.statusText}`);
  }
  const body = await res.text();

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, body, "utf-8");

  return body;
}

const USAGE = `Usage: anyapi-mcp --name <name> --spec <path-or-url> --base-url <url> [--header "Key: Value"]...

Required:
  --name       Server name (e.g. "petstore")
  --spec       Path or URL to OpenAPI spec (JSON or YAML) (repeatable for multiple specs)
  --base-url   API base URL (e.g. "https://api.example.com")

Optional:
  --header     HTTP header as "Key: Value" (repeatable)
               Supports \${ENV_VAR} interpolation in values
  --log        Path to request/response log file (NDJSON format)

OAuth 2.0 (all optional, but client-id/client-secret/token-url are required together):
  --oauth-client-id      OAuth client ID
  --oauth-client-secret  OAuth client secret
  --oauth-token-url      OAuth token endpoint URL
  --oauth-auth-url       OAuth authorization endpoint URL (authorization_code flow)
  --oauth-scopes         Comma-separated scopes (e.g. "read,write")
  --oauth-flow           "authorization_code" (default) or "client_credentials"
  --oauth-param          Extra auth URL param as "key=value" (repeatable)
               All OAuth values support \${ENV_VAR} interpolation`;

export async function loadConfig(): Promise<AnyApiConfig> {
  const name = getArg("--name");
  const specUrls = getAllArgs("--spec");
  const baseUrl = getArg("--base-url");

  if (!name || specUrls.length === 0 || !baseUrl) {
    console.error(USAGE);
    process.exit(1);
  }

  const specs = await Promise.all(
    specUrls.map((url) => loadSpec(interpolateEnv(url)))
  );

  const headers: Record<string, string> = {};
  for (const raw of getAllArgs("--header")) {
    const colonIdx = raw.indexOf(":");
    if (colonIdx === -1) {
      console.error(`ERROR: Invalid header format "${raw}". Expected "Key: Value"`);
      process.exit(1);
    }
    const key = raw.slice(0, colonIdx).trim();
    const value = raw.slice(colonIdx + 1).trim();
    headers[key] = interpolateEnv(value);
  }

  const logPath = getArg("--log");

  // --- OAuth CLI flags ---
  const oauthClientId = getArg("--oauth-client-id");
  const oauthClientSecret = getArg("--oauth-client-secret");
  const oauthTokenUrl = getArg("--oauth-token-url");
  const oauthAuthUrl = getArg("--oauth-auth-url");
  const oauthScopes = getArg("--oauth-scopes");
  const oauthFlow = getArg("--oauth-flow");
  const oauthParams = getAllArgs("--oauth-param");

  const hasAnyOAuth = oauthClientId || oauthClientSecret || oauthTokenUrl;
  if (hasAnyOAuth && !(oauthClientId && oauthClientSecret && oauthTokenUrl)) {
    console.error(
      "ERROR: --oauth-client-id, --oauth-client-secret, and --oauth-token-url must all be provided together."
    );
    process.exit(1);
  }

  let oauth: OAuthConfig | undefined;
  if (oauthClientId && oauthClientSecret && oauthTokenUrl) {
    const extraParams: Record<string, string> = {};
    for (const raw of oauthParams) {
      const eqIdx = raw.indexOf("=");
      if (eqIdx === -1) {
        console.error(
          `ERROR: Invalid --oauth-param format "${raw}". Expected "key=value"`
        );
        process.exit(1);
      }
      extraParams[raw.slice(0, eqIdx)] = interpolateEnv(raw.slice(eqIdx + 1));
    }

    const flow = (
      oauthFlow ? interpolateEnv(oauthFlow) : "authorization_code"
    ) as OAuthFlow;
    if (flow !== "authorization_code" && flow !== "client_credentials") {
      console.error(
        `ERROR: Invalid --oauth-flow "${flow}". Must be "authorization_code" or "client_credentials".`
      );
      process.exit(1);
    }

    oauth = {
      clientId: interpolateEnv(oauthClientId),
      clientSecret: interpolateEnv(oauthClientSecret),
      tokenUrl: interpolateEnv(oauthTokenUrl),
      authUrl: oauthAuthUrl ? interpolateEnv(oauthAuthUrl) : undefined,
      scopes: oauthScopes
        ? interpolateEnv(oauthScopes)
            .split(/[,\s]+/)
            .filter(Boolean)
        : [],
      flow,
      extraParams,
    };
  }

  return {
    name,
    specs,
    baseUrl: interpolateEnv(baseUrl).replace(/\/+$/, ""),
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    logPath: logPath ? resolve(logPath) : undefined,
    oauth,
  };
}
