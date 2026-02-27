import type { RateLimitInfo } from "./types.js";

const MAX_WAIT_MS = 30_000;

let lastInfo: RateLimitInfo | null = null;

/**
 * Store the latest rate limit info from response headers.
 */
export function trackRateLimit(info: RateLimitInfo | null): void {
  if (info) lastInfo = info;
}

/**
 * Parse a reset time value into an epoch millisecond timestamp.
 * Supports ISO 8601 strings and "Ns" (seconds-from-now) format.
 */
function parseResetEpoch(resetAt: string): number | null {
  // "Ns" format (e.g. "30s")
  const secMatch = resetAt.match(/^(\d+)s$/);
  if (secMatch) {
    return Date.now() + parseInt(secMatch[1], 10) * 1000;
  }
  // ISO 8601 timestamp
  const ts = Date.parse(resetAt);
  if (!isNaN(ts)) return ts;
  return null;
}

/**
 * If rate limit is nearly exhausted (remaining <= 1), delay until the reset time.
 * Capped at MAX_WAIT_MS to avoid indefinite blocking.
 * Clears tracked state after waiting.
 */
export async function waitIfNeeded(): Promise<void> {
  if (!lastInfo) return;
  if (lastInfo.remaining === null || lastInfo.remaining > 1) return;
  if (!lastInfo.resetAt) {
    lastInfo = null;
    return;
  }

  const resetEpoch = parseResetEpoch(lastInfo.resetAt);
  if (!resetEpoch) {
    lastInfo = null;
    return;
  }

  const delayMs = resetEpoch - Date.now();
  if (delayMs <= 0) {
    lastInfo = null;
    return;
  }

  const waitMs = Math.min(delayMs, MAX_WAIT_MS);
  lastInfo = null;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

/**
 * Reset tracker state (for testing).
 */
export function resetTracker(): void {
  lastInfo = null;
}
