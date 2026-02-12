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
    return JSON.parse(body);
  }

  if (ct.includes("xml") || ct.includes("+xml")) {
    return xmlParser.parse(body);
  }

  if (ct.includes("text/csv") || ct.includes("application/csv")) {
    return parseCsv(body);
  }

  // Try JSON parse for responses without content-type
  if (!ct || ct.includes("text/plain")) {
    try {
      return JSON.parse(body);
    } catch {
      // Not JSON, wrap as text
    }
  }

  return { _type: "text", content: body };
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
