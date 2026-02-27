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
  isObjectType,
  isListType,
  isScalarType,
  graphql as executeGraphQL,
  printSchema,
} from "graphql";
import type { GraphQLFieldConfigMap, GraphQLInputFieldConfigMap } from "graphql";
import { createHash } from "node:crypto";
import type { RequestBodySchema, RequestBodyProperty } from "./types.js";

const MAX_ARRAY_LIMIT = 50;
const MAX_SAMPLE_SIZE = 50;
const MAJORITY_THRESHOLD = 0.6;

/**
 * Estimate token cost of a JSON value by walking its structure.
 * For scalars, estimates based on string length (long strings cost more tokens).
 * For objects, sums child costs. For arrays, averages across multiple samples (up to 10).
 * Bounded by MAX_INFER_DEPTH to match inference behavior.
 */
function estimateTokenCost(value: unknown, depth: number = 0): number {
  if (depth >= MAX_INFER_DEPTH) return 1;
  if (value === null || value === undefined) return 1;
  if (Array.isArray(value)) {
    if (value.length === 0) return 1;
    // Average across multiple samples for better accuracy
    const sampleCount = Math.min(value.length, 10);
    let totalCost = 0;
    for (let i = 0; i < sampleCount; i++) {
      totalCost += estimateTokenCost(value[i], depth + 1);
    }
    return Math.max(1, Math.round(totalCost / sampleCount));
  }
  if (typeof value === "object") {
    let count = 0;
    for (const v of Object.values(value as Record<string, unknown>)) {
      count += estimateTokenCost(v, depth + 1);
    }
    return Math.max(1, count);
  }
  // Scalars: estimate token cost from serialized JSON size.
  // Each string in a JSON response adds ~10 chars of overhead (quotes, comma,
  // indentation, newline), so we use the full serialized length / 4 to approximate
  // LLM tokens (1 token ≈ 4 chars).
  if (typeof value === "string") {
    const jsonLen = value.length + 10; // value + overhead
    return Math.max(1, Math.ceil(jsonLen / 4));
  }
  return 1;
}

/**
 * Per-field token cost tree. Used by call_api to help LLMs understand
 * how much budget each field consumes.
 */
export interface FieldCostNode {
  _total: number;
  _perItem?: number;
  _avgLength?: number;
  [field: string]: number | FieldCostNode | undefined;
}

/**
 * Compute a per-field token cost tree from response data.
 * Uses sanitized field names to match GraphQL schema.
 */
export function computeFieldCosts(data: unknown, depth: number = 0): FieldCostNode {
  if (depth >= MAX_INFER_DEPTH || data === null || data === undefined) {
    return { _total: 1 };
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { _total: 1, _perItem: 0, _avgLength: 0 };
    }

    const sampleCount = Math.min(data.length, 10);

    // Check if array of objects
    const firstObj = data.find(
      (el): el is Record<string, unknown> =>
        typeof el === "object" && el !== null && !Array.isArray(el)
    );

    if (firstObj) {
      // Merge samples for representative fields
      const mergeResult = mergeArraySamples(data);
      const representative = mergeResult ? mergeResult.merged : firstObj;
      const itemCosts = computeFieldCosts(representative, depth + 1);
      const perItem = itemCosts._total;
      return {
        _total: perItem * data.length,
        _perItem: perItem,
        _avgLength: data.length,
        ...Object.fromEntries(
          Object.entries(itemCosts).filter(([k]) => !k.startsWith("_"))
        ),
      };
    }

    // Scalar array
    let totalCost = 0;
    for (let i = 0; i < sampleCount; i++) {
      totalCost += estimateTokenCost(data[i]);
    }
    const perItem = Math.max(1, Math.round(totalCost / sampleCount));
    return {
      _total: perItem * data.length,
      _perItem: perItem,
      _avgLength: data.length,
    };
  }

  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const entries = Object.entries(obj);
    let total = 0;
    const result: FieldCostNode = { _total: 0 };

    for (const [key, value] of entries) {
      const sanitized = sanitizeFieldName(key);
      if (
        value !== null &&
        value !== undefined &&
        typeof value === "object"
      ) {
        const childCost = computeFieldCosts(value, depth + 1);
        result[sanitized] = childCost;
        total += childCost._total;
      } else {
        const cost = estimateTokenCost(value);
        result[sanitized] = cost;
        total += cost;
      }
    }

    result._total = Math.max(1, total);
    return result;
  }

  return { _total: estimateTokenCost(data) };
}

/**
 * Compute a default array limit that scales inversely with item token cost.
 * Simple items ([1, 2, 3], [{id, name}]) → high limit (up to 50).
 * Complex items (deeply nested objects with many fields) → low limit (min 3).
 * Long strings (like k8s tags, URLs) → lower limit to avoid token bloat.
 * Aims to keep total token cost for this array around TOKEN_BUDGET.
 *
 * For scalar arrays, samples multiple elements to get a better average cost
 * (first element might not be representative).
 */
function dynamicArrayLimit(arr: unknown[]): number {
  if (arr.length === 0) return MAX_ARRAY_LIMIT;
  const mergeResult = mergeArraySamples(arr);

  let costPerItem: number;
  if (mergeResult) {
    costPerItem = estimateTokenCost(mergeResult.merged);
  } else {
    // Scalar array: sample up to 10 elements for average cost
    const sampleCount = Math.min(arr.length, 10);
    let totalCost = 0;
    for (let i = 0; i < sampleCount; i++) {
      totalCost += estimateTokenCost(arr[i]);
    }
    costPerItem = totalCost / sampleCount;
  }

  const TOKEN_BUDGET = 200;
  const MIN_ITEMS = 3;
  return Math.max(MIN_ITEMS, Math.min(MAX_ARRAY_LIMIT, Math.floor(TOKEN_BUDGET / costPerItem)));
}
const MAX_INFER_DEPTH = 8;

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
  const lim = limit ?? MAX_ARRAY_LIMIT;
  const sliced = data.slice(off, off + lim);
  return { data: sliced, truncated: sliced.length < total, total };
}

function cacheKey(method: string, pathTemplate: string, hash: string): string {
  return `${method}:${pathTemplate}:${hash}`;
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
 * every key seen across all samples.
 * Uses majority-type conflict resolution: if one base type accounts for >=60%
 * of observations for a field, that type wins. Otherwise the field is marked
 * as a conflict (JSON scalar fallback).
 * Nested objects are merged recursively.
 */
function mergeSamples(items: Record<string, unknown>[]): MergeResult {
  const merged: Record<string, unknown> = {};
  const conflicts = new Set<string>();
  // key → (baseType → count) for majority-type resolution
  const typeCounts = new Map<string, Map<string, number>>();
  // key → (baseType → first value of that type) for setting merged to winning type's value
  const firstValueByType = new Map<string, Map<string, unknown>>();

  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (value === null || value === undefined) continue;

      const valueType = baseTypeOf(value);

      // Track type counts
      if (!typeCounts.has(key)) typeCounts.set(key, new Map());
      const counts = typeCounts.get(key)!;
      counts.set(valueType, (counts.get(valueType) ?? 0) + 1);

      // Track first value per type
      if (!firstValueByType.has(key)) firstValueByType.set(key, new Map());
      const typeValues = firstValueByType.get(key)!;
      if (!typeValues.has(valueType)) typeValues.set(valueType, value);

      if (!(key in merged) || merged[key] === null || merged[key] === undefined) {
        merged[key] = value;
      } else if (
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

  // Apply majority-type resolution
  for (const [key, counts] of typeCounts) {
    if (counts.size <= 1) continue; // single type → no conflict

    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    let majorityType: string | null = null;
    for (const [type, count] of counts) {
      if (count / total >= MAJORITY_THRESHOLD) {
        majorityType = type;
        break;
      }
    }

    if (majorityType) {
      // Majority type wins — set merged value to a representative of the winning type
      const winningValue = firstValueByType.get(key)!.get(majorityType);
      merged[key] = winningValue;
    } else {
      // No majority → mark as conflict
      conflicts.add(key);
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
 * Produce a structural fingerprint string from JSON data.
 * Captures keys + recursive type structure but NOT values.
 * Sorted keys ensure determinism regardless of object key order.
 * Bounded by MAX_INFER_DEPTH to match inference behavior.
 */
function shapeFingerprint(data: unknown, depth: number = 0): string {
  if (data === null || data === undefined) return "n";
  if (depth >= MAX_INFER_DEPTH) return "J";

  if (Array.isArray(data)) {
    if (data.length === 0) return "[]";
    if (hasMixedTypes(data)) return "[J]";
    const mergeResult = mergeArraySamples(data);
    if (mergeResult) return `[${shapeFingerprint(mergeResult.merged, depth + 1)}]`;
    return `[${shapeFingerprint(data[0], depth + 1)}]`;
  }

  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    if (keys.length === 0) return "{}";
    return `{${keys.map((k) => `${k}:${shapeFingerprint(obj[k], depth + 1)}`).join(",")}}`;
  }

  switch (typeof data) {
    case "number":
      return Number.isInteger(data) ? "i" : "f";
    case "boolean":
      return "b";
    default:
      return "s";
  }
}

/**
 * Compute a truncated SHA-256 hash of the structural fingerprint of JSON data.
 * Returns a 12-character hex string.
 */
export function computeShapeHash(data: unknown): string {
  const fp = shapeFingerprint(data);
  return createHash("sha256").update(fp).digest("hex").slice(0, 12);
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
      return new GraphQLList(GraphQLJSON);
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
      let wasCollision = false;

      if (usedNames.has(sanitized)) {
        let counter = 2;
        while (usedNames.has(`${sanitized}_${counter}`)) counter++;
        sanitized = `${sanitized}_${counter}`;
        wasCollision = true;
      }
      usedNames.add(sanitized);

      const key = originalKey;
      const needsDescription = wasCollision || sanitized !== originalKey;
      const description = needsDescription ? `Original API field: "${originalKey}"` : undefined;

      // Use JSON scalar for fields with type conflicts across samples
      if (conflicts?.has(originalKey)) {
        fieldConfigs[sanitized] = {
          type: GraphQLJSON,
          ...(description ? { description } : {}),
          resolve: (source: Record<string, unknown>) => source[key],
        };
        continue;
      }

      const childTypeName = `${typeName}_${sanitized}`;
      const fieldType = inferType(fieldValue, childTypeName, typeRegistry, conflicts, depth + 1);

      if (fieldType instanceof GraphQLList) {
        const arrDefault = Array.isArray(fieldValue) ? dynamicArrayLimit(fieldValue) : MAX_ARRAY_LIMIT;
        fieldConfigs[sanitized] = {
          type: fieldType,
          ...(description ? { description } : {}),
          args: {
            limit: { type: GraphQLInt, defaultValue: arrDefault },
            offset: { type: GraphQLInt, defaultValue: 0 },
          },
          resolve: (
            source: Record<string, unknown>,
            args: { limit: number; offset: number }
          ) => {
            const val = source[key];
            if (!Array.isArray(val)) return val;
            return val.slice(args.offset, args.offset + args.limit);
          },
        };
      } else {
        fieldConfigs[sanitized] = {
          type: fieldType,
          ...(description ? { description } : {}),
          resolve: (source: Record<string, unknown>) => source[key],
        };
      }
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

const MAX_INPUT_DEPTH = 6;

/**
 * Build a GraphQL input type from a RequestBodyProperty definition.
 * Recursively creates GraphQLInputObjectType for nested objects and
 * GraphQLList(GraphQLInputObjectType) for arrays with object items.
 */
function buildInputType(
  propDef: RequestBodyProperty,
  parentTypeName: string,
  propName: string,
  depth: number
): GraphQLInputType {
  if (depth >= MAX_INPUT_DEPTH) return GraphQLString;

  if (propDef.type === "object" && propDef.properties) {
    const nestedFields: GraphQLInputFieldConfigMap = {};
    const reqFields = new Set(propDef.required_fields ?? []);
    for (const [name, nested] of Object.entries(propDef.properties)) {
      const sanitized = sanitizeFieldName(name);
      let type = buildInputType(nested, `${parentTypeName}_${sanitizeFieldName(propName)}`, name, depth + 1);
      if (nested.required || reqFields.has(name)) {
        type = new GraphQLNonNull(type);
      }
      nestedFields[sanitized] = {
        type,
        ...(nested.description ? { description: nested.description } : {}),
      };
    }
    if (Object.keys(nestedFields).length === 0) return GraphQLString;
    return new GraphQLInputObjectType({
      name: `${parentTypeName}_${sanitizeFieldName(propName)}`,
      fields: nestedFields,
    });
  }

  if (propDef.type === "array" && propDef.items) {
    if (propDef.items.properties) {
      const itemFields: GraphQLInputFieldConfigMap = {};
      const reqFields = new Set(propDef.items.required ?? []);
      for (const [name, nested] of Object.entries(propDef.items.properties)) {
        const sanitized = sanitizeFieldName(name);
        let type = buildInputType(nested, `${parentTypeName}_${sanitizeFieldName(propName)}_Item`, name, depth + 1);
        if (nested.required || reqFields.has(name)) {
          type = new GraphQLNonNull(type);
        }
        itemFields[sanitized] = {
          type,
          ...(nested.description ? { description: nested.description } : {}),
        };
      }
      if (Object.keys(itemFields).length > 0) {
        return new GraphQLList(new GraphQLInputObjectType({
          name: `${parentTypeName}_${sanitizeFieldName(propName)}_Item`,
          fields: itemFields,
        }));
      }
    }
    return new GraphQLList(mapOpenApiTypeToGraphQLInput(propDef.items.type));
  }

  return mapOpenApiTypeToGraphQLInput(propDef.type);
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
    let itemType: GraphQLOutputType = GraphQLJSON;
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

    const topLimit = dynamicArrayLimit(data as unknown[]);
    queryType = new GraphQLObjectType({
      name: "Query",
      fields: {
        items: {
          type: new GraphQLList(itemType),
          args: {
            limit: { type: GraphQLInt, defaultValue: topLimit },
            offset: { type: GraphQLInt, defaultValue: 0 },
          },
          resolve: (
            source: unknown,
            args: { limit: number; offset: number }
          ) => {
            const arr = source as unknown[];
            if (!Array.isArray(arr)) return arr;
            return arr.slice(args.offset, args.offset + args.limit);
          },
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
            ...(fieldDef.description ? { description: fieldDef.description } : {}),
            args: fieldDef.args.length > 0
              ? Object.fromEntries(fieldDef.args.map(a => [a.name, { type: a.type, defaultValue: a.defaultValue }]))
              : undefined,
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
      let type: GraphQLInputType = buildInputType(propDef, `${baseName}_Input`, propName, 0);
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
 *
 * @param cacheHash Optional hash to use as the cache key discriminator.
 *   If provided (e.g. body hash for mutations), it is used instead of the
 *   response shape hash for cache lookup. The shapeHash is always computed
 *   from the response data and returned regardless.
 */
export function getOrBuildSchema(
  data: unknown,
  method: string,
  pathTemplate: string,
  requestBodySchema?: RequestBodySchema,
  cacheHash?: string
): { schema: GraphQLSchema; shapeHash: string; fromCache: boolean } {
  const shapeHash = computeShapeHash(data);
  const effectiveHash = cacheHash ?? shapeHash;
  const key = cacheKey(method, pathTemplate, effectiveHash);
  const cached = schemaCache.get(key);
  if (cached) return { schema: cached, shapeHash, fromCache: true };

  const schema = buildSchemaFromData(data, method, pathTemplate, requestBodySchema);
  schemaCache.set(key, schema);
  return { schema, shapeHash, fromCache: false };
}

/**
 * Convert a GraphQL schema to SDL string for display.
 */
export function schemaToSDL(schema: GraphQLSchema): string {
  return printSchema(schema);
}

/**
 * Walk the schema type tree and return field paths typed as the JSON scalar.
 * Helps callers understand which fields are opaque and can't be queried with
 * GraphQL field selection.
 */
export function collectJsonFields(schema: GraphQLSchema): string[] {
  const jsonFields: string[] = [];
  const queryType = schema.getQueryType();
  if (!queryType) return jsonFields;
  const visited = new Set<string>();

  function walk(type: GraphQLObjectType, prefix: string) {
    if (visited.has(type.name)) return;
    visited.add(type.name);
    for (const [name, field] of Object.entries(type.getFields())) {
      let unwrapped = field.type;
      if (unwrapped instanceof GraphQLNonNull) unwrapped = unwrapped.ofType;
      const path = prefix ? `${prefix}.${name}` : name;
      if (isScalarType(unwrapped) && unwrapped.name === "JSON") {
        jsonFields.push(path);
      } else if (isObjectType(unwrapped)) {
        walk(unwrapped, path);
      } else if (isListType(unwrapped)) {
        let inner = unwrapped.ofType;
        if (inner instanceof GraphQLNonNull) inner = inner.ofType;
        if (isScalarType(inner) && inner.name === "JSON") {
          jsonFields.push(path);
        } else if (isObjectType(inner)) {
          walk(inner, path);
        }
      }
    }
  }

  walk(queryType, "");
  return jsonFields;
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
