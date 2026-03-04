import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { platform } from "node:process";

/**
 * Resolve request body from either an inline `body` object or a `bodyFile` path.
 * Throws if both are provided, if the path is relative, or if the file is unreadable/invalid JSON.
 */
export function resolveBody(
  body?: Record<string, unknown>,
  bodyFile?: string
): Record<string, unknown> | undefined {
  if (body && bodyFile) {
    throw new Error(
      "Cannot specify both 'body' and 'bodyFile'. Use one or the other."
    );
  }

  if (!bodyFile) return body;

  // Validate absolute path
  const isAbsolutePath =
    isAbsolute(bodyFile) ||
    (platform === "win32" && /^[A-Za-z]:[\\/]/.test(bodyFile));

  if (!isAbsolutePath) {
    throw new Error(
      `bodyFile must be an absolute path, got: ${bodyFile}`
    );
  }

  const fullPath = resolve(bodyFile);
  let content: string;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read bodyFile '${fullPath}': ${msg}`);
  }

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("bodyFile must contain a JSON object (not an array or primitive)");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`bodyFile '${fullPath}' contains invalid JSON: ${err.message}`);
    }
    throw err;
  }
}
