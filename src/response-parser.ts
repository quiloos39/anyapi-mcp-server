import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

export function parseResponse(
  contentType: string | null,
  body: string
): unknown {
  const ct = (contentType ?? "").toLowerCase();

  if (ct.includes("application/json") || ct.includes("+json")) {
    try {
      return JSON.parse(body);
    } catch {
      // Content-Type claims JSON but body isn't — fall through to detection
    }
  }

  if (ct.includes("xml") || ct.includes("+xml")) {
    return xmlParser.parse(body);
  }

  if (ct.includes("text/csv") || ct.includes("application/csv")) {
    return parseCsv(body);
  }

  if (ct.includes("application/x-www-form-urlencoded")) {
    return parseFormUrlEncoded(body);
  }

  // Try JSON parse for responses without content-type
  if (!ct || ct.includes("text/plain")) {
    try {
      return JSON.parse(body);
    } catch {
      // Not JSON, continue
    }
  }

  // Try form-urlencoded detection (e.g. key=value&key2=value2)
  if (looksLikeFormUrlEncoded(body)) {
    return parseFormUrlEncoded(body);
  }

  return { _type: "text", content: body };
}

/**
 * Returns true if parsed response data is non-JSON (text, form-encoded, etc.)
 * and should skip the GraphQL schema inference layer.
 */
export function isNonJsonResult(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (typeof data !== "object") return true;
  if (
    typeof data === "object" &&
    data !== null &&
    "_type" in data &&
    (data as Record<string, unknown>)._type === "text"
  ) {
    return true;
  }
  return false;
}

function parseFormUrlEncoded(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

function looksLikeFormUrlEncoded(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("<")) {
    return false;
  }
  // Must have at least one key=value pair
  return /^[^=&]+=[^&]*(&[^=&]+=[^&]*)*$/.test(trimmed.split("\n")[0]);
}

function parseCsv(csv: string): unknown[] {
  const lines = csv.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}
