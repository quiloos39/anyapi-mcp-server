/**
 * Apply a dot-path filter to extract nested values from JSON data.
 *
 * Supports:
 * - Dot notation for nested access: "a.b.c"
 * - Array traversal with "[]": "data[].name" maps over each element
 * - Multiple "[]" segments for nested arrays
 * - Root "[]" on array input
 *
 * Returns null if the path doesn't match.
 */
export function applyJsonFilter(data: unknown, filter: string): unknown {
  if (!filter) return data;

  const segments = parseSegments(filter);
  return walk(data, segments, 0);
}

function parseSegments(filter: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < filter.length; i++) {
    if (filter[i] === "[" && filter[i + 1] === "]") {
      if (current) {
        segments.push(current);
        current = "";
      }
      segments.push("[]");
      i++; // skip ']'
    } else if (filter[i] === ".") {
      if (current) {
        segments.push(current);
        current = "";
      }
    } else {
      current += filter[i];
    }
  }
  if (current) segments.push(current);
  return segments;
}

function walk(data: unknown, segments: string[], index: number): unknown {
  if (index >= segments.length) return data;
  if (data === null || data === undefined) return null;

  const segment = segments[index];

  if (segment === "[]") {
    if (!Array.isArray(data)) return null;
    const results = data.map((item) => walk(item, segments, index + 1));
    return results;
  }

  if (typeof data !== "object" || Array.isArray(data)) return null;

  const obj = data as Record<string, unknown>;
  if (!(segment in obj)) return null;

  return walk(obj[segment], segments, index + 1);
}
