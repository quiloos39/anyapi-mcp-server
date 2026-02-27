import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { platform, env } from "node:process";

const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedResponse {
  method: string;
  path: string;
  data: unknown;
  responseHeaders: Record<string, string>;
  expiresAt: number;
}

function defaultResponseDir(): string {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? "", "AppData", "Local");
    return join(base, "anyapi-mcp", "responses");
  }
  return join(env.HOME ?? "/tmp", ".cache", "anyapi-mcp", "responses");
}

let responseDir = defaultResponseDir();

export function _setResponseDirForTests(dir: string): void {
  responseDir = dir;
}

export function _clearAllForTests(): void {
  try {
    for (const file of readdirSync(responseDir)) {
      if (file.endsWith(".json")) {
        try { unlinkSync(join(responseDir, file)); } catch { /* ignore */ }
      }
    }
  } catch { /* dir may not exist */ }
}

function ensureDir(): void {
  mkdirSync(responseDir, { recursive: true });
}

export function cleanupExpired(): void {
  try {
    const now = Date.now();
    for (const file of readdirSync(responseDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = readFileSync(join(responseDir, file), "utf-8");
        const entry = JSON.parse(content) as CachedResponse;
        if (entry.expiresAt < now) {
          unlinkSync(join(responseDir, file));
        }
      } catch {
        /* ignore individual file errors */
      }
    }
  } catch {
    /* dir may not exist yet */
  }
}

export function storeResponse(
  method: string,
  path: string,
  data: unknown,
  responseHeaders: Record<string, string>
): string {
  const dataKey = randomBytes(4).toString("hex");
  const entry: CachedResponse = {
    method,
    path,
    data,
    responseHeaders,
    expiresAt: Date.now() + TTL_MS,
  };
  try {
    ensureDir();
    writeFileSync(join(responseDir, `${dataKey}.json`), JSON.stringify(entry));
    cleanupExpired();
  } catch (err) {
    process.stderr.write(`data-cache: failed to store ${dataKey}: ${err}\n`);
  }
  return dataKey;
}

export function loadResponse(
  dataKey: string
): { method: string; path: string; data: unknown; responseHeaders: Record<string, string> } | null {
  try {
    const filePath = join(responseDir, `${dataKey}.json`);
    const content = readFileSync(filePath, "utf-8");
    const entry = JSON.parse(content) as CachedResponse;
    if (entry.expiresAt < Date.now()) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }
    return {
      method: entry.method,
      path: entry.path,
      data: entry.data,
      responseHeaders: entry.responseHeaders,
    };
  } catch {
    return null;
  }
}
