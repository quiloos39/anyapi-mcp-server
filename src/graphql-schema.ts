import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
  GraphQLOutputType,
  GraphQLInputType,
  graphql as executeGraphQL,
  printSchema,
} from "graphql";
import type { GraphQLFieldConfigMap, GraphQLInputFieldConfigMap } from "graphql";
import type { RequestBodySchema } from "./types.js";

const DEFAULT_ARRAY_LIMIT = 50;
const MAX_SAMPLE_SIZE = 30;
const MAX_INFER_DEPTH = 4;

/**
 * Custom scalar that passes arbitrary JSON values through as-is.
 * Used for mixed-type arrays, type-conflicting fields, and deeply nested structures.
 */
const GraphQLJSON = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value (mixed types, deep nesting, or heterogeneous structures)",
  serialize: (value) => value,
  parseValue: (value) => value,
});

// Schema cache keyed by "METHOD:/path/template"
const schemaCache = new Map<string, GraphQLSchema>();

/**
 * If data is an array, slice it to [offset, offset+limit) and return metadata.
 * Returns the original data unchanged if it's not an array.
 */
export function truncateIfArray(
  data: unknown,
  limit?: number,
  offset?: number
): { data: unknown; truncated: boolean; total: number | null } {
  if (!Array.isArray(data)) {
    return { data, truncated: false, total: null };
  }
  const total = data.length;
  const off = offset ?? 0;
  const lim = limit ?? DEFAULT_ARRAY_LIMIT;
  const sliced = data.slice(off, off + lim);
  return { data: sliced, truncated: sliced.length < total, total };
}

function cacheKey(method: string, pathTemplate: string): string {
  return `${method}:${pathTemplate}`;
}

/**
 * Sanitize a JSON key into a valid GraphQL field name.
 * Dashes, dots, spaces become underscores. Leading digits get prefixed.
 * Leading double underscores are stripped (GraphQL reserves __ for introspection).
 */
function sanitizeFieldName(name: string): string {
  let s = name.replace(/[-. ]/g, "_");
  if (/^[0-9]/.test(s)) {
    s = "_" + s;
  }
  s = s.replace(/[^_a-zA-Z0-9]/g, "_");
  s = s.replace(/^_+/, (match) => (match.length === 1 ? "_" : "f_"));
  if (!s) s = "f_empty";
  return s;
}

/**
 * Derive a valid GraphQL type name from method + path template.
 * e.g. "GET:/api/card/{id}" → "GET_api_card_id"
 */
function deriveTypeName(method: string, pathTemplate: string): string {
  let name = `${method}_${pathTemplate}`
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (name.startsWith("__")) name = name.slice(1);
  return name || "Unknown";
}

/**
 * Return the base type category of a value for mixed-type detection.
 */
function baseTypeOf(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "string" | "number" | "boolean" | "object"
}

/**
 * Check if an array has mixed base types (e.g. string + number, or scalar + object).
 * Returns true if the array should be treated as JSON scalar.
 */
function hasMixedTypes(arr: unknown[]): boolean {
  const types = new Set<string>();
  const sampleSize = Math.min(arr.length, MAX_SAMPLE_SIZE);
  for (let i = 0; i < sampleSize; i++) {
    const t = baseTypeOf(arr[i]);
    if (t !== "null") types.add(t);
  }
  return types.size > 1;
}

function inferScalarType(value: unknown): GraphQLOutputType {
  switch (typeof value) {
    case "string":
      return GraphQLString;
    case "number":
      return Number.isInteger(value) ? GraphQLInt : GraphQLFloat;
    case "boolean":
      return GraphQLBoolean;
    default:
      return GraphQLString;
  }
}

/** Result of merging samples: the merged object + any fields with type conflicts. */
interface MergeResult {
  merged: Record<string, unknown>;
  conflicts: Set<string>;
}

/**
 * Merge multiple sample objects into a single "super-object" that contains
 * every key seen across all samples. First non-null value wins for each key.
 * Nested objects are merged recursively.
 * Tracks fields where different samples have conflicting base types.
 */
function mergeSamples(items: Record<string, unknown>[]): MergeResult {
  const merged: Record<string, unknown> = {};
  const conflicts = new Set<string>();
  const seenTypes = new Map<string, string>(); // key → first base type

  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (value === null || value === undefined) continue;

      const valueType = baseTypeOf(value);

      if (!(key in merged) || merged[key] === null || merged[key] === undefined) {
        merged[key] = value;
        if (!seenTypes.has(key)) seenTypes.set(key, valueType);
      } else {
        const prevType = seenTypes.get(key);
        if (prevType && prevType !== valueType) {
          conflicts.add(key);
        }

        if (
          !conflicts.has(key) &&
          typeof value === "object" && value !== null && !Array.isArray(value) &&
          typeof merged[key] === "object" && merged[key] !== null && !Array.isArray(merged[key])
        ) {
          const sub = mergeSamples([
            merged[key] as Record<string, unknown>,
            value as Record<string, unknown>,
          ]);
          merged[key] = sub.merged;
          for (const c of sub.conflicts) conflicts.add(`${key}.${c}`);
        } else if (Array.isArray(value) && Array.isArray(merged[key])) {
          if ((merged[key] as unknown[]).length === 0 && value.length > 0) {
            merged[key] = value;
          }
        }
      }
    }
  }

  return { merged, conflicts };
}

/**
 * Sample and merge multiple array elements for richer type inference.
 * Returns the merged object + conflict set, or null if no objects found.
 */
function mergeArraySamples(arr: unknown[]): MergeResult | null {
  const sampleSize = Math.min(arr.length, MAX_SAMPLE_SIZE);
  const objectSamples = arr
    .slice(0, sampleSize)
    .filter(
      (s): s is Record<string, unknown> =>
        typeof s === "object" && s !== null && !Array.isArray(s)
    );
  if (objectSamples.length === 0) return null;
  return mergeSamples(objectSamples);
}

/**
 * Recursively infer a GraphQL type from a JSON value.
 * For objects, creates a named GraphQLObjectType with explicit resolvers
 * that map sanitized field names back to original JSON keys.
 *
 * Falls back to GraphQLJSON for:
 * - Arrays with mixed element types (string + number + object)
 * - Fields with conflicting types across samples
 * - Values nested deeper than MAX_INFER_DEPTH
 */
function inferType(
  value: unknown,
  typeName: string,
  typeRegistry: Map<string, GraphQLObjectType>,
  conflicts?: Set<string>,
  depth: number = 0
): GraphQLOutputType {
  if (value === null || value === undefined) {
    return GraphQLString;
  }

  // Beyond max depth, treat as opaque JSON
  if (depth >= MAX_INFER_DEPTH) {
    return GraphQLJSON;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return new GraphQLList(GraphQLString);
    }
    // Mixed-type arrays → JSON scalar (e.g. ["field", 4296, { "temporal-unit": "day" }])
    if (hasMixedTypes(value)) {
      return GraphQLJSON;
    }
    // Sample multiple elements for richer type inference
    const mergeResult = mergeArraySamples(value);
    if (mergeResult) {
      const elementType = inferType(
        mergeResult.merged, `${typeName}_Item`, typeRegistry,
        mergeResult.conflicts, depth + 1
      );
      return new GraphQLList(elementType);
    }
    const elementType = inferType(value[0], `${typeName}_Item`, typeRegistry, conflicts, depth + 1);
    return new GraphQLList(elementType);
  }

  if (typeof value === "object") {
    const existing = typeRegistry.get(typeName);
    if (existing) return existing;

    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);

    if (entries.length === 0) {
      const emptyType = new GraphQLObjectType({
        name: typeName,
        fields: { _empty: { type: GraphQLString, resolve: () => null } },
      });
      typeRegistry.set(typeName, emptyType);
      return emptyType;
    }

    // Reserve the name before recursing to handle circular structures
    const placeholder = new GraphQLObjectType({
      name: typeName,
      fields: {},
    });
    typeRegistry.set(typeName, placeholder);

    const usedNames = new Set<string>();
    const fieldConfigs: GraphQLFieldConfigMap<
      Record<string, unknown>,
      unknown
    > = {};

    for (const [originalKey, fieldValue] of entries) {
      let sanitized = sanitizeFieldName(originalKey);

      if (usedNames.has(sanitized)) {
        let counter = 2;
        while (usedNames.has(`${sanitized}_${counter}`)) counter++;
        sanitized = `${sanitized}_${counter}`;
      }
      usedNames.add(sanitized);

      const key = originalKey;

      // Use JSON scalar for fields with type conflicts across samples
      if (conflicts?.has(originalKey)) {
        fieldConfigs[sanitized] = {
          type: GraphQLJSON,
          resolve: (source: Record<string, unknown>) => source[key],
        };
        continue;
      }

      const childTypeName = `${typeName}_${sanitized}`;
      const fieldType = inferType(fieldValue, childTypeName, typeRegistry, conflicts, depth + 1);

      fieldConfigs[sanitized] = {
        type: fieldType,
        resolve: (source: Record<string, unknown>) => source[key],
      };
    }

    const realType = new GraphQLObjectType({
      name: typeName,
      fields: () => fieldConfigs,
    });
    typeRegistry.set(typeName, realType);
    return realType;
  }

  return inferScalarType(value);
}

/**
 * Map OpenAPI type strings to GraphQL input types.
 */
function mapOpenApiTypeToGraphQLInput(type: string): GraphQLInputType {
  switch (type) {
    case "string":
      return GraphQLString;
    case "integer":
      return GraphQLInt;
    case "number":
      return GraphQLFloat;
    case "boolean":
      return GraphQLBoolean;
    default:
      return GraphQLString;
  }
}

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Build a GraphQL schema from an arbitrary JSON response.
 *
 * - Object responses: fields promoted to root Query (query as `{ id name ... }`)
 * - Array responses: wrapped as `{ items [...], _count }` (query as `{ items { id name } _count }`)
 * - Scalar responses: wrapped as `{ value }`
 * - Write operations with requestBodySchema: adds a Mutation type
 */
export function buildSchemaFromData(
  data: unknown,
  method: string,
  pathTemplate: string,
  requestBodySchema?: RequestBodySchema
): GraphQLSchema {
  const baseName = deriveTypeName(method, pathTemplate);
  const typeRegistry = new Map<string, GraphQLObjectType>();

  let queryType: GraphQLObjectType;

  // Array response
  if (Array.isArray(data)) {
    let itemType: GraphQLOutputType = GraphQLString;
    if (data.length > 0) {
      // Mixed-type top-level array → items are JSON scalars
      if (hasMixedTypes(data)) {
        itemType = GraphQLJSON;
      } else {
        const mergeResult = mergeArraySamples(data);
        if (mergeResult) {
          itemType = inferType(
            mergeResult.merged, `${baseName}_Item`, typeRegistry,
            mergeResult.conflicts, 0
          );
        } else {
          itemType = inferScalarType(data[0]);
        }
      }
    }

    queryType = new GraphQLObjectType({
      name: "Query",
      fields: {
        items: {
          type: new GraphQLList(itemType),
          resolve: (source: unknown) => source as unknown[],
        },
        _count: {
          type: GraphQLInt,
          resolve: (source: unknown) => (source as unknown[]).length,
        },
      },
    });
  } else if (typeof data === "object" && data !== null) {
    // Object response
    const responseType = inferType(
      data,
      baseName,
      typeRegistry
    ) as GraphQLObjectType;

    queryType = new GraphQLObjectType({
      name: "Query",
      fields: () => {
        const originalFields = responseType.getFields();
        const queryFields: GraphQLFieldConfigMap<unknown, unknown> = {};

        for (const [fieldName, fieldDef] of Object.entries(originalFields)) {
          queryFields[fieldName] = {
            type: fieldDef.type,
            resolve: fieldDef.resolve,
          };
        }

        return queryFields;
      },
    });
  } else {
    // Scalar response
    queryType = new GraphQLObjectType({
      name: "Query",
      fields: {
        value: {
          type: GraphQLString,
          resolve: (source: unknown) => String(source),
        },
      },
    });
  }

  // Build mutation type for write operations with a request body schema
  if (WRITE_METHODS.has(method) && requestBodySchema) {
    const mutationName = `${method.toLowerCase()}_${baseName}`;

    const inputFields: GraphQLInputFieldConfigMap = {};
    for (const [propName, propDef] of Object.entries(requestBodySchema.properties)) {
      const sanitized = sanitizeFieldName(propName);
      let type: GraphQLInputType = mapOpenApiTypeToGraphQLInput(propDef.type);
      if (propDef.required) {
        type = new GraphQLNonNull(type);
      }
      inputFields[sanitized] = {
        type,
        ...(propDef.description ? { description: propDef.description } : {}),
      };
    }

    const hasInputFields = Object.keys(inputFields).length > 0;
    const inputType = hasInputFields
      ? new GraphQLInputObjectType({
          name: `${baseName}_Input`,
          fields: inputFields,
        })
      : null;

    const mutationType = new GraphQLObjectType({
      name: "Mutation",
      fields: {
        [mutationName]: {
          type: queryType,
          args: inputType ? { input: { type: inputType } } : {},
          resolve: (source: unknown) => source,
        },
      },
    });

    return new GraphQLSchema({ query: queryType, mutation: mutationType });
  }

  return new GraphQLSchema({ query: queryType });
}

/**
 * Get a cached schema or build + cache a new one from the response data.
 */
export function getOrBuildSchema(
  data: unknown,
  method: string,
  pathTemplate: string,
  requestBodySchema?: RequestBodySchema
): GraphQLSchema {
  const key = cacheKey(method, pathTemplate);
  const cached = schemaCache.get(key);
  if (cached) return cached;

  const schema = buildSchemaFromData(data, method, pathTemplate, requestBodySchema);
  schemaCache.set(key, schema);
  return schema;
}

/**
 * Convert a GraphQL schema to SDL string for display.
 */
export function schemaToSDL(schema: GraphQLSchema): string {
  return printSchema(schema);
}

/**
 * Execute a GraphQL selection query against JSON data using a schema.
 * The query should be a selection set like `{ id name collection { id } }`.
 * Also supports mutation syntax: `mutation { ... }`.
 */
export async function executeQuery(
  schema: GraphQLSchema,
  data: unknown,
  query: string
): Promise<unknown> {
  const trimmed = query.trim();
  const fullQuery =
    trimmed.startsWith("query") || trimmed.startsWith("mutation") || trimmed.startsWith("{")
      ? trimmed
      : `{ ${trimmed} }`;

  const result = await executeGraphQL({
    schema,
    source: fullQuery,
    rootValue: data,
  });

  if (result.errors && result.errors.length > 0) {
    const messages = result.errors.map((e) => e.message).join("; ");
    throw new Error(`GraphQL query error: ${messages}`);
  }

  return result.data;
}
