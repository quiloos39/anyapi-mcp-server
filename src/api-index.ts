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
  OAuthSecurityScheme,
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
const MAX_BODY_SCHEMA_DEPTH = 6;

function extractProperties(
  schema: Record<string, unknown>,
  spec: Record<string, unknown>,
  depth: number,
  visited: Set<string>
): Record<string, RequestBodyProperty> | undefined {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return undefined;

  const requiredFields = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : []
  );

  const result: Record<string, RequestBodyProperty> = {};
  for (const [propName, propDef] of Object.entries(properties)) {
    let def = propDef;
    let refPath: string | undefined;
    // Resolve property-level $ref
    if (def["$ref"] && typeof def["$ref"] === "string") {
      refPath = def["$ref"] as string;
      if (visited.has(refPath)) {
        result[propName] = { type: "object", required: requiredFields.has(propName) };
        continue;
      }
      const resolved = resolveRef(refPath, spec);
      if (resolved) def = resolved as Record<string, unknown>;
    }

    const prop: RequestBodyProperty = {
      type: (def.type as string) ?? "string",
      required: requiredFields.has(propName),
    };
    if (def.description) prop.description = def.description as string;

    // Recurse into nested objects
    if (prop.type === "object" && def.properties && depth < MAX_BODY_SCHEMA_DEPTH) {
      const branch = new Set(visited);
      if (refPath) branch.add(refPath);
      const nested = extractProperties(def as Record<string, unknown>, spec, depth + 1, branch);
      if (nested) {
        prop.properties = nested;
        if (Array.isArray(def.required) && def.required.length > 0) {
          prop.required_fields = def.required as string[];
        }
      }
    }

    if (def.items && typeof def.items === "object") {
      let itemsDef = def.items as Record<string, unknown>;
      let itemsRefPath: string | undefined;
      if (itemsDef["$ref"] && typeof itemsDef["$ref"] === "string") {
        itemsRefPath = itemsDef["$ref"] as string;
        if (!visited.has(itemsRefPath)) {
          const resolved = resolveRef(itemsRefPath, spec);
          if (resolved) itemsDef = resolved as Record<string, unknown>;
        }
      }
      const itemType = (itemsDef.type as string) ?? "string";
      if (itemType === "object" && itemsDef.properties && depth < MAX_BODY_SCHEMA_DEPTH) {
        const branch = new Set(visited);
        if (itemsRefPath) branch.add(itemsRefPath);
        const nestedItems = extractProperties(itemsDef, spec, depth + 1, branch);
        if (nestedItems) {
          prop.items = {
            type: itemType,
            properties: nestedItems,
            required: Array.isArray(itemsDef.required) ? (itemsDef.required as string[]) : undefined,
          };
        } else {
          prop.items = { type: itemType };
        }
      } else {
        prop.items = { type: itemType };
      }
    }
    result[propName] = prop;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

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

  const result = extractProperties(schema, spec, 0, new Set());
  if (!result) return undefined;

  return { contentType: "application/json", properties: result };
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
  private oauthSchemes: OAuthSecurityScheme[] = [];

  constructor(specContents: string[]) {
    for (const specContent of specContents) {
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

    this.extractSecuritySchemes(rawSpec);
  }

  private extractSecuritySchemes(spec: Record<string, unknown>): void {
    // OpenAPI 3.x: components.securitySchemes
    const components = spec.components as Record<string, unknown> | undefined;
    const securitySchemes = components?.securitySchemes as
      | Record<string, Record<string, unknown>>
      | undefined;

    // OpenAPI 2.x (Swagger): securityDefinitions
    const securityDefs = spec.securityDefinitions as
      | Record<string, Record<string, unknown>>
      | undefined;

    const schemes = securitySchemes ?? securityDefs ?? {};

    for (const schemeDef of Object.values(schemes)) {
      if (schemeDef.type !== "oauth2") continue;

      // OpenAPI 3.x: flows.authorizationCode, flows.clientCredentials, etc.
      const flows = schemeDef.flows as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (flows) {
        for (const flow of Object.values(flows)) {
          const scopes = flow.scopes
            ? Object.keys(flow.scopes as Record<string, unknown>)
            : [];
          this.oauthSchemes.push({
            authorizationUrl: flow.authorizationUrl as string | undefined,
            tokenUrl: flow.tokenUrl as string | undefined,
            scopes,
          });
        }
        continue;
      }

      // OpenAPI 2.x (Swagger): direct fields on the scheme
      const scopes = schemeDef.scopes
        ? Object.keys(schemeDef.scopes as Record<string, unknown>)
        : [];
      this.oauthSchemes.push({
        authorizationUrl: schemeDef.authorizationUrl as string | undefined,
        tokenUrl: schemeDef.tokenUrl as string | undefined,
        scopes,
      });
    }
  }

  getOAuthSchemes(): OAuthSecurityScheme[] {
    return this.oauthSchemes;
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

  listAll(): ApiEndpointSummary[] {
    return this.allEndpoints.map((ep) => ({
      method: ep.method,
      path: ep.path,
      summary: ep.summary,
      tag: ep.tag,
      parameters: ep.parameters,
    }));
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
    const lower = category.toLowerCase();
    const key = [...this.byTag.keys()].find((k) => k.toLowerCase() === lower);
    const endpoints = key ? this.byTag.get(key)! : [];
    return endpoints.map((ep) => ({
      method: ep.method,
      path: ep.path,
      summary: ep.summary,
      tag: ep.tag,
      parameters: ep.parameters,
    }));
  }

  searchAll(keyword: string): ApiEndpointSummary[] {
    let matcher: (text: string) => boolean;
    try {
      const re = new RegExp(keyword, "i");
      matcher = (text) => re.test(text);
    } catch {
      const lower = keyword.toLowerCase();
      matcher = (text) => text.toLowerCase().includes(lower);
    }

    return this.allEndpoints
      .filter(
        (ep) =>
          matcher(ep.path) ||
          matcher(ep.summary)
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
