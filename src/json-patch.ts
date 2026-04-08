/**
 * RFC 6902 JSON Patch subset: add, remove, replace operations.
 * Used by mutate_api to apply targeted changes to large resources
 * without requiring the LLM to hold the full state in context.
 */

export interface PatchOperation {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

/**
 * Parse a JSON Pointer (RFC 6901) into path segments.
 * Unescapes ~1 → / and ~0 → ~ per spec.
 */
function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer: must start with '/' (got '${path}')`);
  }
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Walk to the parent of the target path segment.
 * Returns [parent, lastSegment] for the operation to act on.
 */
function walkToParent(
  root: unknown,
  segments: string[],
): [parent: Record<string, unknown> | unknown[], lastSegment: string] {
  let current: unknown = root;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (Array.isArray(current)) {
      const idx = parseInt(seg, 10);
      if (isNaN(idx) || idx < 0 || idx >= current.length) {
        throw new Error(`Array index out of bounds: '${seg}' at /${segments.slice(0, i + 1).join("/")}`);
      }
      current = current[idx];
    } else if (typeof current === "object" && current !== null) {
      const rec = current as Record<string, unknown>;
      if (!(seg in rec)) {
        throw new Error(`Path not found: '${seg}' at /${segments.slice(0, i + 1).join("/")}`);
      }
      current = rec[seg];
    } else {
      throw new Error(`Cannot traverse into ${typeof current} at /${segments.slice(0, i + 1).join("/")}`);
    }
  }

  if (!Array.isArray(current) && (typeof current !== "object" || current === null)) {
    throw new Error(`Cannot apply operation: parent at /${segments.slice(0, -1).join("/")} is ${typeof current}`);
  }

  return [current as Record<string, unknown> | unknown[], segments[segments.length - 1]];
}

function applyAdd(root: unknown, segments: string[], value: unknown): void {
  const [parent, key] = walkToParent(root, segments);
  if (Array.isArray(parent)) {
    if (key === "-") {
      parent.push(value);
    } else {
      const idx = parseInt(key, 10);
      if (isNaN(idx) || idx < 0 || idx > parent.length) {
        throw new Error(`Array index out of bounds for add: '${key}'`);
      }
      parent.splice(idx, 0, value);
    }
  } else {
    (parent as Record<string, unknown>)[key] = value;
  }
}

function applyRemove(root: unknown, segments: string[]): void {
  const [parent, key] = walkToParent(root, segments);
  if (Array.isArray(parent)) {
    const idx = parseInt(key, 10);
    if (isNaN(idx) || idx < 0 || idx >= parent.length) {
      throw new Error(`Array index out of bounds for remove: '${key}'`);
    }
    parent.splice(idx, 1);
  } else {
    const rec = parent as Record<string, unknown>;
    if (!(key in rec)) {
      throw new Error(`Cannot remove non-existent key: '${key}'`);
    }
    delete rec[key];
  }
}

function applyReplace(root: unknown, segments: string[], value: unknown): void {
  const [parent, key] = walkToParent(root, segments);
  if (Array.isArray(parent)) {
    const idx = parseInt(key, 10);
    if (isNaN(idx) || idx < 0 || idx >= parent.length) {
      throw new Error(`Array index out of bounds for replace: '${key}'`);
    }
    parent[idx] = value;
  } else {
    const rec = parent as Record<string, unknown>;
    if (!(key in rec)) {
      throw new Error(`Cannot replace non-existent key: '${key}'`);
    }
    rec[key] = value;
  }
}

/**
 * Apply a sequence of JSON Patch operations to a deep-cloned copy of the target.
 * Returns the patched object. Does not mutate the original.
 */
export function applyPatch(
  target: Record<string, unknown>,
  operations: PatchOperation[],
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const segments = parsePointer(op.path);

    if (segments.length === 0) {
      throw new Error(`Operation ${i} (${op.op}): cannot target root`);
    }

    switch (op.op) {
      case "add":
        if (op.value === undefined) {
          throw new Error(`Operation ${i} (add): 'value' is required`);
        }
        applyAdd(cloned, segments, op.value);
        break;
      case "remove":
        applyRemove(cloned, segments);
        break;
      case "replace":
        if (op.value === undefined) {
          throw new Error(`Operation ${i} (replace): 'value' is required`);
        }
        applyReplace(cloned, segments, op.value);
        break;
      default:
        throw new Error(`Operation ${i}: unsupported op '${(op as PatchOperation).op}'`);
    }
  }

  return cloned;
}
