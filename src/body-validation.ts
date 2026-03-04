import type { RequestBodySchema } from "./types.js";

export interface PlaceholderWarning {
  field: string;
  value: string;
  reason: string;
}

const CONTENT_FIELD_NAMES = new Set([
  "html_content",
  "html",
  "content",
  "body",
  "template",
  "description",
  "text",
  "message",
  "markup",
  "source",
  "html_body",
  "plain_content",
  "rich_content",
]);

const EXACT_KEYWORDS = new Set(["placeholder", "todo", "tbd", "fixme", "xxx"]);

const PATTERN_REGEXES = [
  /^file:\/\//,
  /^<[^>]+>$/,
  /^\[[^\]]+\]$/,
  /^content of /i,
  /^see (above|below|file)/i,
];

function isContentField(name: string): boolean {
  return CONTENT_FIELD_NAMES.has(name) || name.includes("html");
}

function checkKeywordPatterns(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (EXACT_KEYWORDS.has(lower)) {
    return `Suspicious keyword: "${value.trim()}"`;
  }
  for (const re of PATTERN_REGEXES) {
    if (re.test(value.trim())) {
      return `Suspicious pattern: "${value.trim()}"`;
    }
  }
  return null;
}

function hasHtmlSchemaHint(
  fieldName: string,
  schema?: RequestBodySchema
): boolean {
  if (!schema?.properties) return false;
  const prop = schema.properties[fieldName];
  if (!prop?.description) return false;
  const desc = prop.description.toLowerCase();
  return /html|content|template|body|markup/.test(desc);
}

/**
 * Detect placeholder values in a request body that likely indicate
 * the LLM failed to emit real content.
 */
export function detectPlaceholders(
  body?: Record<string, unknown>,
  schema?: RequestBodySchema
): PlaceholderWarning[] {
  if (!body || typeof body !== "object") return [];

  const warnings: PlaceholderWarning[] = [];
  const keys = Object.keys(body);

  // Pass 1: keyword patterns on string fields (shallow + 1 level nested)
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") {
      const reason = checkKeywordPatterns(value);
      if (reason && (isContentField(key) || keys.length <= 2)) {
        warnings.push({ field: key, value, reason });
      }
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // One level nested
      for (const [nestedKey, nestedValue] of Object.entries(
        value as Record<string, unknown>
      )) {
        if (typeof nestedValue === "string") {
          const reason = checkKeywordPatterns(nestedValue);
          if (reason && (isContentField(nestedKey) || keys.length <= 2)) {
            warnings.push({
              field: `${key}.${nestedKey}`,
              value: nestedValue,
              reason,
            });
          }
        }
      }
    }
  }

  // Pass 2: short value for known content fields
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") continue;
    if (value.length >= 50) continue;

    const fieldIsContent = isContentField(key);
    const schemaHasHtml = hasHtmlSchemaHint(key, schema);

    if ((fieldIsContent || schemaHasHtml) && (schemaHasHtml || key.includes("html"))) {
      // Don't duplicate warnings already found in pass 1
      const alreadyWarned = warnings.some((w) => w.field === key);
      if (!alreadyWarned) {
        warnings.push({
          field: key,
          value,
          reason: `Suspiciously short value (${value.length} chars) for a content/HTML field`,
        });
      }
    }
  }

  return warnings;
}
