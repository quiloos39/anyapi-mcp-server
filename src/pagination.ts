import type { ApiParameter } from "./types.js";

export interface PaginationHint {
  cursor?: string;
  nextUrl?: string;
  hasMore?: boolean;
  nextPageToken?: string;
  nextParams?: Record<string, string>;
  _hint: string;
}

/**
 * Dot-path patterns to search for pagination info in response data.
 * Each entry: [dotPath, target field in PaginationHint, label for hint text, candidate query param names].
 */
const CURSOR_PATTERNS: [string[], keyof Omit<PaginationHint, "_hint" | "nextParams">, string, string[]][] = [
  [["meta", "page", "after"], "cursor", "meta.page.after", ["page[cursor]", "page[after]", "cursor", "after"]],
  [["meta", "page", "cursor"], "cursor", "meta.page.cursor", ["page[cursor]", "cursor"]],
  [["paging", "cursors", "after"], "cursor", "paging.cursors.after", ["after", "cursor"]],
  [["pagination", "next_cursor"], "cursor", "pagination.next_cursor", ["cursor", "next_cursor"]],
  [["next_cursor"], "cursor", "next_cursor", ["cursor", "next_cursor"]],
  [["cursor"], "cursor", "cursor", ["cursor"]],
  [["nextPageToken"], "nextPageToken", "nextPageToken", ["pageToken", "page_token"]],
  [["next_page_token"], "nextPageToken", "next_page_token", ["page_token", "pageToken"]],
  [["links", "next"], "nextUrl", "links.next", []],
  [["_links", "next", "href"], "nextUrl", "_links.next.href", []],
  [["has_more"], "hasMore", "has_more", []],
  [["hasMore"], "hasMore", "hasMore", []],
];

function walkPath(data: unknown, path: string[]): unknown {
  let current = data;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Known pagination-related query parameter names (used to flag params in call_api).
 */
export const PAGINATION_PARAM_NAMES = new Set([
  "page", "cursor", "after", "before", "limit", "offset", "per_page",
  "page_size", "pageSize", "page_token", "pageToken", "next_page_token",
  "page[cursor]", "page[after]", "page[before]", "page[size]", "page[number]",
  "page[offset]", "page[limit]", "starting_after", "ending_before",
  "start_cursor", "next_cursor",
]);

/**
 * Pick the best query parameter name from candidates by cross-referencing
 * against the endpoint's actual spec parameters. Falls back to the first candidate.
 */
export function resolveParamName(candidates: string[], specParams?: ApiParameter[]): string | null {
  if (candidates.length === 0) return null;
  if (specParams && specParams.length > 0) {
    const queryParams = new Set(
      specParams.filter((p) => p.in === "query").map((p) => p.name)
    );
    for (const c of candidates) {
      if (queryParams.has(c)) return c;
    }
  }
  return candidates[0];
}

/**
 * Parse query parameters from a next-page URL.
 */
function parseNextUrlParams(nextUrl: string): Record<string, string> {
  try {
    const url = new URL(nextUrl);
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return params;
  } catch {
    return {};
  }
}

/**
 * Scan raw response data for common pagination patterns.
 * Returns a PaginationHint with matched values and usage guidance, or null if not paginated.
 * When specParams are provided, resolves cursor param names against the endpoint's actual parameters.
 */
export function detectPagination(data: unknown, specParams?: ApiParameter[]): PaginationHint | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;

  const found: PaginationHint = { _hint: "" };
  const hints: string[] = [];
  const nextParams: Record<string, string> = {};

  for (const [path, field, label, candidates] of CURSOR_PATTERNS) {
    if (found[field] !== undefined) continue; // first match wins per field
    const value = walkPath(data, path);
    if (value === undefined || value === null) continue;

    if (field === "hasMore") {
      if (typeof value === "boolean") {
        found.hasMore = value;
        hints.push(`'${label}' = ${value}`);
      }
    } else if (typeof value === "string" && value.length > 0) {
      (found as unknown as Record<string, unknown>)[field] = value;
      if (field === "cursor" || field === "nextPageToken") {
        const paramName = resolveParamName(candidates, specParams);
        if (paramName) {
          nextParams[paramName] = value;
        }
        hints.push(`Use '${label}' value as cursor parameter for the next page`);
      } else if (field === "nextUrl") {
        const urlParams = parseNextUrlParams(value);
        Object.assign(nextParams, urlParams);
        hints.push(`'${label}' contains the full URL for the next page`);
      }
    }
  }

  if (hints.length === 0) return null;

  if (Object.keys(nextParams).length > 0) {
    found.nextParams = nextParams;
    found._hint =
      `Pagination detected. To fetch the next page, call query_api with the same method, path, and query, ` +
      `but set params to include: ${JSON.stringify(nextParams)}`;
  } else {
    found._hint = `Pagination detected: ${hints.join("; ")}.`;
  }
  return found;
}
