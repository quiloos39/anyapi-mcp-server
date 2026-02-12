import { resolve } from "node:path";

export interface AnyApiConfig {
  name: string;
  spec: string;
  baseUrl: string;
  headers?: Record<string, string>;
  logPath?: string;
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

const USAGE = `Usage: anyapi-mcp --name <name> --spec <path> --base-url <url> [--header "Key: Value"]...

Required:
  --name       Server name (e.g. "petstore")
  --spec       Path to OpenAPI spec file (JSON or YAML)
  --base-url   API base URL (e.g. "https://api.example.com")

Optional:
  --header     HTTP header as "Key: Value" (repeatable)
               Supports \${ENV_VAR} interpolation in values
  --log        Path to request/response log file (NDJSON format)`;

export function loadConfig(): AnyApiConfig {
  const name = getArg("--name");
  const spec = getArg("--spec");
  const baseUrl = getArg("--base-url");

  if (!name || !spec || !baseUrl) {
    console.error(USAGE);
    process.exit(1);
  }

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

  return {
    name,
    spec: resolve(spec),
    baseUrl: interpolateEnv(baseUrl).replace(/\/+$/, ""),
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    logPath: logPath ? resolve(logPath) : undefined,
  };
}
