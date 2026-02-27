/**
 * Token budget system for controlling response size.
 * Truncates array results to fit within a token budget,
 * leveraging GraphQL field selection for size control.
 */

const DEFAULT_BUDGET = 4000;

/**
 * Find the primary array in a query result.
 * Checks `items` first (raw array responses), then falls back to
 * the first non-`_`-prefixed array field.
 */
export function findPrimaryArray(obj: unknown): unknown[] | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;

  // Check `items` first (raw array responses wrapped by GraphQL schema)
  if (Array.isArray(rec.items)) return rec.items;

  // Fall back to first non-_-prefixed array field
  for (const [key, value] of Object.entries(rec)) {
    if (!key.startsWith("_") && Array.isArray(value)) {
      return value;
    }
  }

  return null;
}

/**
 * Returns the length of the primary array, or null if no array found.
 */
export function findPrimaryArrayLength(obj: unknown): number | null {
  const arr = findPrimaryArray(obj);
  return arr ? arr.length : null;
}

/**
 * Estimate token count from a JSON value.
 * Uses JSON.stringify length / 4 as approximation (1 token ~ 4 chars).
 */
function estimateTokens(value: unknown): number {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
  } catch {
    return 1;
  }
}

/**
 * Truncate the primary array in an object to fit within a token budget.
 * Uses binary search to find the max number of items that fit.
 * Returns the truncated object and the original/truncated counts.
 */
export function truncateToTokenBudget(
  obj: Record<string, unknown>,
  budget: number
): { result: Record<string, unknown>; originalCount: number; keptCount: number } {
  const arr = findPrimaryArray(obj);
  if (!arr || arr.length === 0) {
    return { result: obj, originalCount: 0, keptCount: 0 };
  }

  const originalCount = arr.length;

  // Compute overhead tokens (non-array fields)
  const overhead: Record<string, unknown> = {};
  const arrayKey = findPrimaryArrayKey(obj);
  if (!arrayKey) return { result: obj, originalCount, keptCount: originalCount };

  for (const [key, value] of Object.entries(obj)) {
    if (key !== arrayKey) {
      overhead[key] = value;
    }
  }
  const overheadTokens = estimateTokens(overhead);
  const arrayBudget = Math.max(1, budget - overheadTokens);

  // Check if full array fits
  const fullTokens = estimateTokens(arr);
  if (fullTokens <= arrayBudget) {
    return { result: obj, originalCount, keptCount: originalCount };
  }

  // Binary search for max items that fit
  let lo = 1;
  let hi = originalCount;
  let bestCount = 1; // Always keep at least 1

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const sliceTokens = estimateTokens(arr.slice(0, mid));
    if (sliceTokens <= arrayBudget) {
      bestCount = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const truncated = { ...obj, [arrayKey]: arr.slice(0, bestCount) };
  return { result: truncated, originalCount, keptCount: bestCount };
}

/**
 * Find the key name of the primary array in an object.
 */
function findPrimaryArrayKey(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;

  if (Array.isArray(rec.items)) return "items";

  for (const [key, value] of Object.entries(rec)) {
    if (!key.startsWith("_") && Array.isArray(value)) {
      return key;
    }
  }

  return null;
}

/**
 * Build a status message for the response.
 * If estimated tokens exceed the budget, truncates and returns TRUNCATED status.
 * Otherwise returns COMPLETE status.
 */
export function buildStatusMessage(
  queryResult: unknown,
  budget: number = DEFAULT_BUDGET
): { status: string; result: unknown } {
  if (typeof queryResult !== "object" || queryResult === null || Array.isArray(queryResult)) {
    return { status: "COMPLETE", result: queryResult };
  }

  const qr = queryResult as Record<string, unknown>;
  const totalTokens = estimateTokens(qr);

  if (totalTokens <= budget) {
    const arrayLen = findPrimaryArrayLength(qr);
    const status = arrayLen !== null ? `COMPLETE (${arrayLen} items)` : "COMPLETE";
    return { status, result: qr };
  }

  // Need truncation
  const { result, originalCount, keptCount } = truncateToTokenBudget(qr, budget);

  if (originalCount === 0) {
    // No array found but response is over budget
    return {
      status: `COMPLETE (response exceeds token budget ${budget} — select fewer fields)`,
      result: qr,
    };
  }

  const status = `TRUNCATED — ${keptCount} of ${originalCount} items (token budget ${budget}). Select fewer fields to fit more items.`;
  return { status, result };
}
