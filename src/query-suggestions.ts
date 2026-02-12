import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLList,
  GraphQLOutputType,
  isScalarType,
  isObjectType,
  isListType,
  isNonNullType,
} from "graphql";

export interface QuerySuggestion {
  name: string;
  query: string;
  description: string;
}

const MAX_DEPTH = 2;
const MAX_FIELDS_PER_LEVEL = 8;

function unwrapType(type: GraphQLOutputType): GraphQLOutputType {
  if (isNonNullType(type)) return type.ofType;
  return type;
}

function getScalarFieldNames(type: GraphQLObjectType): string[] {
  const fields = type.getFields();
  return Object.keys(fields).filter((name) => {
    const fieldType = unwrapType(fields[name].type);
    return isScalarType(fieldType);
  });
}

function buildDepthLimitedQuery(
  type: GraphQLObjectType,
  maxDepth: number,
  depth: number = 0
): string | null {
  if (depth > maxDepth) return null;
  const fields = type.getFields();
  const parts: string[] = [];

  let count = 0;
  for (const [name, field] of Object.entries(fields)) {
    if (count >= MAX_FIELDS_PER_LEVEL) break;
    const fieldType = unwrapType(field.type);

    if (isScalarType(fieldType)) {
      parts.push(name);
      count++;
    } else if (isObjectType(fieldType) && depth < maxDepth) {
      const nested = buildDepthLimitedQuery(fieldType, maxDepth, depth + 1);
      if (nested) {
        parts.push(`${name} ${nested}`);
        count++;
      }
    } else if (isListType(fieldType)) {
      const elementType = unwrapType(fieldType.ofType);
      if (isScalarType(elementType)) {
        parts.push(name);
        count++;
      } else if (isObjectType(elementType) && depth < maxDepth) {
        const nested = buildDepthLimitedQuery(elementType, maxDepth, depth + 1);
        if (nested) {
          parts.push(`${name} ${nested}`);
          count++;
        }
      }
    }
  }

  return parts.length > 0 ? `{ ${parts.join(" ")} }` : null;
}

export function generateSuggestions(schema: GraphQLSchema): QuerySuggestion[] {
  const suggestions: QuerySuggestion[] = [];
  const queryType = schema.getQueryType();
  if (!queryType) return suggestions;

  const fields = queryType.getFields();
  const fieldNames = Object.keys(fields);

  // Suggestion 1: All scalar fields at root
  const scalarFields = fieldNames.filter((name) => {
    const type = unwrapType(fields[name].type);
    return isScalarType(type);
  });
  if (scalarFields.length > 0) {
    const selected = scalarFields.slice(0, MAX_FIELDS_PER_LEVEL);
    suggestions.push({
      name: "All top-level scalar fields",
      query: `{ ${selected.join(" ")} }`,
      description: `Returns ${selected.join(", ")}`,
    });
  }

  // Suggestion 2: For each list field, suggest with basic subfields
  for (const [name, field] of Object.entries(fields)) {
    const type = unwrapType(field.type);
    if (isListType(type)) {
      const elementType = unwrapType(type.ofType);
      if (isObjectType(elementType)) {
        const subfields = getScalarFieldNames(elementType).slice(
          0,
          MAX_FIELDS_PER_LEVEL
        );
        if (subfields.length > 0) {
          suggestions.push({
            name: `List ${name} with basic fields`,
            query: `{ ${name} { ${subfields.join(" ")} } }`,
            description: `Fetches ${subfields.join(", ")} for each item in ${name}`,
          });
        }
      }
    }
  }

  // Suggestion 3: Array response pattern (items + _count)
  if (fields["items"] && fields["_count"]) {
    const itemsType = unwrapType(fields["items"].type);
    if (isListType(itemsType)) {
      const elementType = unwrapType(itemsType.ofType);
      if (isObjectType(elementType)) {
        const subfields = getScalarFieldNames(elementType).slice(0, 6);
        if (subfields.length > 0) {
          suggestions.push({
            name: "Items with count",
            query: `{ items { ${subfields.join(" ")} } _count }`,
            description: `Array response: fetches ${subfields.join(", ")} with total count`,
          });
        }
      }
    }
  }

  // Suggestion 4: Full depth-2 query
  const depth2Query = buildDepthLimitedQuery(queryType, MAX_DEPTH);
  if (depth2Query) {
    suggestions.push({
      name: "Full query (depth 2)",
      query: depth2Query,
      description: "All fields up to 2 levels deep, including nested objects",
    });
  }

  // Suggestion 5: Mutation queries
  const mutationType = schema.getMutationType();
  if (mutationType) {
    const mutFields = mutationType.getFields();
    for (const [mutName, mutField] of Object.entries(mutFields)) {
      const returnType = unwrapType(mutField.type);
      let returnFields = "value";
      if (isObjectType(returnType)) {
        const scalars = getScalarFieldNames(returnType).slice(0, 6);
        if (scalars.length > 0) returnFields = scalars.join(" ");
      }
      const hasArgs = mutField.args.length > 0;
      suggestions.push({
        name: `Mutation: ${mutName}`,
        query: `mutation { ${mutName}${hasArgs ? "(input: { ... })" : ""} { ${returnFields} } }`,
        description: `Write operation returning ${returnFields}`,
      });
    }
  }

  return suggestions;
}
