export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
};

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableError) return true;
  if (error instanceof TypeError) return true;
  return false;
}

function computeDelay(attempt: number, options: RetryOptions, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, options.maxDelayMs);
  }
  const exponential = options.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * options.baseDelayMs;
  return Math.min(exponential + jitter, options.maxDelayMs);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= opts.maxRetries || !isRetryable(error)) {
        throw error;
      }
      const retryAfterMs = error instanceof RetryableError ? error.retryAfterMs : undefined;
      const delay = computeDelay(attempt, opts, retryAfterMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
