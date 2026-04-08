import { z } from "zod";
import type { ToolContext } from "./shared.js";
import {
  getOrBuildSchema,
  truncateIfArray,
  executeQuery,
} from "../graphql-schema.js";

export function registerListApi({ server, config, apiIndex }: ToolContext): void {
  server.tool(
    "list_api",
    `List available ${config.name} API endpoints. ` +
      "Call with no arguments to see all endpoints. " +
      "Provide 'category' to filter by tag. " +
      "Provide 'search' to search across paths and summaries (supports regex). " +
      "Results are paginated with limit (default 20) and offset.",
    {
      category: z
        .string()
        .optional()
        .describe("Tag/category to filter by. Case-insensitive."),
      search: z
        .string()
        .optional()
        .describe("Search keyword or regex pattern across endpoint paths and summaries"),
      query: z
        .string()
        .optional()
        .describe(
          "GraphQL selection query. Default: '{ items { method path summary } _count }'. " +
            "Available fields: method, path, summary, tag, parameters { name in required description }"
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max items to return (default: 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Items to skip (default: 0)"),
    },
    async ({ category, search, query, limit, offset }) => {
      try {
        let data: unknown[];
        if (search) {
          data = apiIndex.searchAll(search);
        } else if (category) {
          data = apiIndex.listAllByCategory(category);
        } else {
          data = apiIndex.listAll();
        }

        if (data.length === 0) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ items: [], _count: 0 }, null, 2) },
            ],
          };
        }

        const defaultQuery = "{ items { method path summary } _count }";
        const effectiveQuery = query ?? defaultQuery;

        const { schema } = getOrBuildSchema(data, "LIST", category ?? search ?? "_all");
        const { data: sliced, truncated, total } = truncateIfArray(data, limit ?? 20, offset);
        const queryResult = await executeQuery(schema, sliced, effectiveQuery);

        if (truncated && typeof queryResult === "object" && queryResult !== null) {
          (queryResult as Record<string, unknown>)._meta = {
            total,
            offset: offset ?? 0,
            limit: limit ?? 20,
            hasMore: true,
          };
        }

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(queryResult, null, 2) },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: message }) },
          ],
          isError: true,
        };
      }
    }
  );
}
