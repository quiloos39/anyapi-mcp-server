import { appendFile } from "node:fs/promises";

export interface LogEntry {
  timestamp: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  durationMs: number;
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

const MAX_BODY_LOG_LENGTH = 10_000;

let logFilePath: string | null = null;

export function initLogger(path: string | null): void {
  logFilePath = path;
}

export function isLoggingEnabled(): boolean {
  return logFilePath !== null;
}

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      masked[key] = value.length > 4 ? value.slice(0, 4) + "****" : "****";
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

function truncateBody(body: unknown): unknown {
  const str = typeof body === "string" ? body : JSON.stringify(body);
  if (str && str.length > MAX_BODY_LOG_LENGTH) {
    return str.slice(0, MAX_BODY_LOG_LENGTH) + `... [truncated, ${str.length} total chars]`;
  }
  return body;
}

export async function logEntry(entry: LogEntry): Promise<void> {
  if (!logFilePath) return;
  try {
    const sanitized = {
      ...entry,
      requestHeaders: maskHeaders(entry.requestHeaders),
      responseBody: truncateBody(entry.responseBody),
    };
    const line = JSON.stringify(sanitized) + "\n";
    await appendFile(logFilePath, line, "utf-8");
  } catch {
    // Logging failure should never crash the server
  }
}
