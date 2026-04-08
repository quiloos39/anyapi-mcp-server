/**
 * Token budget system for controlling response size.
 * Truncates array results to fit within a token budget,
 * leveraging GraphQL field selection for size control.
 */

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
 * Public re-export of estimateTokens for use in index.ts.
 */
export function estimateResultTokens(value: unknown): number {
  return estimateTokens(value);
}

/**
 * BFS walk of the result tree to find the deepest, largest array by token cost.
 * Skips `_`-prefixed keys. Returns null if no arrays found.
 */
export function findDeepestLargestArray(
  obj: unknown
): { path: string[]; array: unknown[]; tokenCost: number } | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

  let best: { path: string[]; array: unknown[]; tokenCost: number } | null = null;

  // BFS queue: each entry is [currentObject, pathSoFar]
  const queue: Array<[Record<string, unknown>, string[]]> = [
    [obj as Record<string, unknown>, []],
  ];

  while (queue.length > 0) {
    const [current, currentPath] = queue.shift()!;
    for (const [key, value] of Object.entries(current)) {
      if (key.startsWith("_")) continue;
      if (Array.isArray(value)) {
        const cost = estimateTokens(value);
        if (
          !best ||
          currentPath.length + 1 > best.path.length ||
          (currentPath.length + 1 === best.path.length && cost > best.tokenCost)
        ) {
          best = { path: [...currentPath, key], array: value, tokenCost: cost };
        }
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        queue.push([value as Record<string, unknown>, [...currentPath, key]]);
      }
    }
  }

  return best;
}

/**
 * Truncate the deepest largest array in an object to fit within a token budget.
 * Clones the spine of the path to avoid mutating the original.
 * Returns the truncated object and original/kept counts.
 */
export function truncateDeepArray(
  obj: unknown,
  budget: number
): { result: unknown; originalCount: number; keptCount: number } {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { result: obj, originalCount: 0, keptCount: 0 };
  }

  const target = findDeepestLargestArray(obj);
  if (!target || target.array.length === 0) {
    return { result: obj, originalCount: 0, keptCount: 0 };
  }

  const originalCount = target.array.length;

  // Check if everything fits as-is
  const totalTokens = estimateTokens(obj);
  if (totalTokens <= budget) {
    return { result: obj, originalCount, keptCount: originalCount };
  }

  // Compute overhead: tokens of everything except the target array
  // Build a copy with the target array emptied to measure overhead
  const emptyClone = cloneSpine(obj as Record<string, unknown>, target.path, []);
  const overheadTokens = estimateTokens(emptyClone);
  const arrayBudget = Math.max(1, budget - overheadTokens);

  // Check if full array fits within array budget
  if (target.tokenCost <= arrayBudget) {
    return { result: obj, originalCount, keptCount: originalCount };
  }

  // Binary search for max items that fit
  let lo = 1;
  let hi = originalCount;
  let bestCount = 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const sliceTokens = estimateTokens(target.array.slice(0, mid));
    if (sliceTokens <= arrayBudget) {
      bestCount = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const truncatedResult = cloneSpine(
    obj as Record<string, unknown>,
    target.path,
    target.array.slice(0, bestCount)
  );
  return { result: truncatedResult, originalCount, keptCount: bestCount };
}

/**
 * Clone the spine of an object along a path, replacing the leaf with a new value.
 */
function cloneSpine(
  obj: Record<string, unknown>,
  path: string[],
  leafValue: unknown
): Record<string, unknown> {
  if (path.length === 0) return obj;
  if (path.length === 1) {
    return { ...obj, [path[0]]: leafValue };
  }
  const [head, ...rest] = path;
  return {
    ...obj,
    [head]: cloneSpine(obj[head] as Record<string, unknown>, rest, leafValue),
  };
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
 * When maxTokens is provided, uses truncateDeepArray for deep truncation.
 * When maxTokens is omitted, returns COMPLETE with no truncation.
 */
export function buildStatusMessage(
  queryResult: unknown,
  maxTokens?: number
): { status: string; result: unknown } {
  if (typeof queryResult !== "object" || queryResult === null || Array.isArray(queryResult)) {
    return { status: "COMPLETE", result: queryResult };
  }

  const qr = queryResult as Record<string, unknown>;

  // No budget specified — return complete, no truncation
  if (maxTokens === undefined) {
    const arrayLen = findPrimaryArrayLength(qr);
    const status = arrayLen !== null ? `COMPLETE (${arrayLen} items)` : "COMPLETE";
    return { status, result: qr };
  }

  // Budget specified — check if truncation needed
  const totalTokens = estimateTokens(qr);
  if (totalTokens <= maxTokens) {
    const arrayLen = findPrimaryArrayLength(qr);
    const status = arrayLen !== null ? `COMPLETE (${arrayLen} items)` : "COMPLETE";
    return { status, result: qr };
  }

  // Need truncation — use deep array truncation
  const { result, originalCount, keptCount } = truncateDeepArray(qr, maxTokens);

  if (originalCount === 0) {
    // No array found but response is over budget
    return {
      status: `COMPLETE (response exceeds token budget ${maxTokens} — select fewer fields)`,
      result: qr,
    };
  }

  const status = `TRUNCATED — ${keptCount} of ${originalCount} items (token budget ${maxTokens}). Select fewer fields to fit more items. Other array fields may also be truncated by default limits — check *_count fields for actual totals.`;
  return { status, result };
}
