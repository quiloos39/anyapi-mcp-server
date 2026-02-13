import yaml from "js-yaml";
import type {
  ApiEndpoint,
  ApiParameter,
  ApiResponse,
  CategorySummary,
  ApiEndpointSummary,
  ListApiResult,
  RequestBodySchema,
  RequestBodyProperty,
} from "./types.js";

const PAGE_SIZE = 20;

interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  deprecated?: boolean;
  externalDocs?: { url?: string; description?: string };
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
  }>;
  requestBody?: unknown;
  responses?: Record<string, { description?: string }>;
}

interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation>>;
  [key: string]: unknown;
}

// --- Postman Collection v2.x types ---
interface PostmanUrl {
  raw?: string;
  host?: string[];
  path?: string[];
  query?: Array<{ key: string; value?: string; description?: string; disabled?: boolean }>;
  variable?: Array<{ key: string; value?: string; description?: string }>;
}

interface PostmanRequest {
  method?: string;
  url?: string | PostmanUrl;
  description?: string;
  header?: Array<{ key: string; value: string }>;
  body?: unknown;
}

interface PostmanItem {
  name?: string;
  item?: PostmanItem[];          // folder
  request?: PostmanRequest;      // endpoint
}

interface PostmanCollection {
  info?: { name?: string; schema?: string };
  item?: PostmanItem[];
}

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch"]);

function extractRequestBodySchema(
  requestBody: unknown,
  spec: Record<string, unknown>
): RequestBodySchema | undefined {
  if (!requestBody || typeof requestBody !== "object") return undefined;

  const rb = requestBody as Record<string, unknown>;

  // Handle $ref at the requestBody level
  if (rb["$ref"] && typeof rb["$ref"] === "string") {
    const resolved = resolveRef(rb["$ref"] as string, spec);
    if (!resolved) return undefined;
    return extractRequestBodySchema(resolved, spec);
  }

  const content = rb.content as Record<string, unknown> | undefined;
  if (!content) return undefined;

  const jsonContent = content["application/json"] as Record<string, unknown> | undefined;
  if (!jsonContent?.schema) return undefined;

  let schema = jsonContent.schema as Record<string, unknown>;

  // Resolve top-level $ref
  if (schema["$ref"] && typeof schema["$ref"] === "string") {
    const resolved = resolveRef(schema["$ref"] as string, spec);
    if (!resolved) return undefined;
    schema = resolved as Record<string, unknown>;
  }

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return undefined;

  const requiredFields = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : []
  );

  const result: Record<string, RequestBodyProperty> = {};
  for (const [propName, propDef] of Object.entries(properties)) {
    let def = propDef;
    // Resolve property-level $ref
    if (def["$ref"] && typeof def["$ref"] === "string") {
      const resolved = resolveRef(def["$ref"] as string, spec);
      if (resolved) def = resolved as Record<string, unknown>;
    }

    const prop: RequestBodyProperty = {
      type: (def.type as string) ?? "string",
      required: requiredFields.has(propName),
    };
    if (def.description) prop.description = def.description as string;
    if (def.items && typeof def.items === "object") {
      const items = def.items as Record<string, unknown>;
      prop.items = { type: (items.type as string) ?? "string" };
    }
    result[propName] = prop;
  }

  return Object.keys(result).length > 0
    ? { contentType: "application/json", properties: result }
    : undefined;
}

function resolveRef(ref: string, spec: Record<string, unknown>): unknown | undefined {
  // Handle "#/components/schemas/Foo" style refs
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/");
  let current: unknown = spec;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isPostmanCollection(parsed: unknown): parsed is PostmanCollection {
  const obj = parsed as Record<string, unknown>;
  return !!(
    obj.info &&
    typeof obj.info === "object" &&
    (obj.info as Record<string, unknown>).schema &&
    typeof (obj.info as Record<string, unknown>).schema === "string" &&
    ((obj.info as Record<string, unknown>).schema as string).includes("schema.getpostman.com")
  );
}

/**
 * Extract path template from Postman URL.
 * Converts Postman's :param to OpenAPI-style {param}.
 */
function postmanUrlToPath(url: string | PostmanUrl): string {
  let raw: string;
  if (typeof url === "string") {
    raw = url;
  } else if (url.raw) {
    raw = url.raw;
  } else if (url.path) {
    raw = "/" + url.path.join("/");
  } else {
    return "/";
  }

  // Strip protocol + host, keep path only
  try {
    const parsed = new URL(raw);
    raw = parsed.pathname + parsed.search;
  } catch {
    // Not a full URL — might be just a path or use {{baseUrl}}
    raw = raw.replace(/^\{\{[^}]+\}\}/, "");
    if (!raw.startsWith("/")) {
      const slashIdx = raw.indexOf("/");
      raw = slashIdx >= 0 ? raw.slice(slashIdx) : "/" + raw;
    }
  }

  // Strip query string
  const qIdx = raw.indexOf("?");
  if (qIdx >= 0) raw = raw.slice(0, qIdx);

  // Convert :param to {param}
  raw = raw.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");

  return raw || "/";
}

export class ApiIndex {
  private byTag: Map<string, ApiEndpoint[]> = new Map();
  private allEndpoints: ApiEndpoint[] = [];

  constructor(specContent: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(specContent);
    } catch {
      parsed = yaml.load(specContent);
    }

    if (isPostmanCollection(parsed)) {
      this.parsePostman(parsed);
    } else {
      this.parseOpenApi(parsed as OpenApiSpec, parsed as Record<string, unknown>);
    }
  }

  private parseOpenApi(spec: OpenApiSpec, rawSpec: Record<string, unknown>): void {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!HTTP_METHODS.has(method)) continue;

        const op = operation as OpenApiOperation;
        const tag = op.tags?.[0] ?? "untagged";

        const parameters: ApiParameter[] = (op.parameters ?? []).map((p) => ({
          name: p.name,
          in: p.in as ApiParameter["in"],
          required: p.required ?? false,
          description: p.description,
        }));

        const requestBodySchema = extractRequestBodySchema(op.requestBody, rawSpec);

        // Extract response descriptions
        let responses: ApiResponse[] | undefined;
        if (op.responses) {
          responses = Object.entries(op.responses).map(([code, resp]) => ({
            statusCode: code,
            description: resp.description ?? "",
          }));
        }

        // Extract request body description
        let requestBodyDescription: string | undefined;
        if (op.requestBody && typeof op.requestBody === "object") {
          const rb = op.requestBody as Record<string, unknown>;
          if (typeof rb.description === "string") {
            requestBodyDescription = rb.description;
          }
        }

        const endpoint: ApiEndpoint = {
          method: method.toUpperCase(),
          path,
          summary: op.summary ?? `${method.toUpperCase()} ${path}`,
          description: op.description ?? "",
          tag,
          parameters,
          hasRequestBody: !!op.requestBody,
          requestBodySchema,
          operationId: op.operationId,
          deprecated: op.deprecated ?? undefined,
          responses,
          requestBodyDescription,
          externalDocs: op.externalDocs?.url
            ? { url: op.externalDocs.url, description: op.externalDocs.description }
            : undefined,
        };

        this.addEndpoint(endpoint);
      }
    }
  }

  private parsePostman(collection: PostmanCollection): void {
    this.walkPostmanItems(collection.item ?? [], []);
  }

  private walkPostmanItems(items: PostmanItem[], folderPath: string[]): void {
    for (const item of items) {
      if (item.item) {
        // Folder — recurse with folder name as tag context
        this.walkPostmanItems(item.item, [...folderPath, item.name ?? "unnamed"]);
      } else if (item.request) {
        this.parsePostmanRequest(item, folderPath);
      }
    }
  }

  private parsePostmanRequest(item: PostmanItem, folderPath: string[]): void {
    const req = item.request!;
    const method = (req.method ?? "GET").toUpperCase();
    if (!HTTP_METHODS.has(method.toLowerCase())) return;

    const path = req.url ? postmanUrlToPath(req.url) : "/";
    const tag = folderPath.length > 0 ? folderPath.join("/") : "untagged";

    const description =
      typeof req.description === "string" ? req.description : "";

    // Extract query params
    const parameters: ApiParameter[] = [];
    if (typeof req.url === "object" && req.url.query) {
      for (const q of req.url.query) {
        if (q.disabled) continue;
        parameters.push({
          name: q.key,
          in: "query",
          required: false,
          description: q.description,
        });
      }
    }
    // Extract path variables
    if (typeof req.url === "object" && req.url.variable) {
      for (const v of req.url.variable) {
        parameters.push({
          name: v.key,
          in: "path",
          required: true,
          description: v.description,
        });
      }
    }

    const endpoint: ApiEndpoint = {
      method,
      path,
      summary: item.name ?? `${method} ${path}`,
      description,
      tag,
      parameters,
      hasRequestBody: !!req.body,
    };

    this.addEndpoint(endpoint);
  }

  private addEndpoint(endpoint: ApiEndpoint): void {
    this.allEndpoints.push(endpoint);
    let tagList = this.byTag.get(endpoint.tag);
    if (!tagList) {
      tagList = [];
      this.byTag.set(endpoint.tag, tagList);
    }
    tagList.push(endpoint);
  }

  listAllCategories(): CategorySummary[] {
    const categories: CategorySummary[] = [];
    for (const [tag, endpoints] of this.byTag) {
      categories.push({ tag, endpointCount: endpoints.length });
    }
    categories.sort((a, b) => a.tag.localeCompare(b.tag));
    return categories;
  }

  listAllByCategory(category: string): ApiEndpointSummary[] {
    const endpoints = this.byTag.get(category) ?? [];
    return endpoints.map((ep) => ({
      method: ep.method,
      path: ep.path,
      summary: ep.summary,
      tag: ep.tag,
      parameters: ep.parameters,
    }));
  }

  searchAll(keyword: string): ApiEndpointSummary[] {
    const lower = keyword.toLowerCase();
    return this.allEndpoints
      .filter(
        (ep) =>
          ep.path.toLowerCase().includes(lower) ||
          ep.summary.toLowerCase().includes(lower) ||
          ep.description.toLowerCase().includes(lower)
      )
      .map((ep) => ({
        method: ep.method,
        path: ep.path,
        summary: ep.summary,
        tag: ep.tag,
        parameters: ep.parameters,
      }));
  }

  getEndpoint(method: string, path: string): ApiEndpoint | undefined {
    return this.allEndpoints.find(
      (ep) => ep.method === method.toUpperCase() && ep.path === path
    );
  }
}
