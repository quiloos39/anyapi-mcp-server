#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ApiIndex } from "./api-index.js";
import { initLogger } from "./logger.js";
import { initTokenStorage } from "./oauth.js";
import { registerListApi } from "./tools/list-api.js";
import { registerInspectApi } from "./tools/inspect-api.js";
import { registerQueryApi } from "./tools/query-api.js";
import { registerMutateApi } from "./tools/mutate-api.js";
import { registerAuth } from "./tools/auth.js";

const config = await loadConfig();
initLogger(config.logPath ?? null);
const apiIndex = new ApiIndex(config.specs);

// --- OAuth: merge spec-derived security info and init token storage ---
if (config.oauth) {
  const schemes = apiIndex.getOAuthSchemes();
  if (schemes.length > 0) {
    const scheme = schemes[0];
    if (!config.oauth.authUrl && scheme.authorizationUrl) {
      config.oauth.authUrl = scheme.authorizationUrl;
    }
    if (config.oauth.scopes.length === 0 && scheme.scopes.length > 0) {
      config.oauth.scopes = scheme.scopes;
    }
  }
  initTokenStorage(config.name);
}

const server = new McpServer({
  name: config.name,
  version: "2.0.0",
});

const ctx = { server, config, apiIndex };

registerListApi(ctx);
registerInspectApi(ctx);
registerQueryApi(ctx);
registerMutateApi(ctx);
registerAuth(ctx);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${config.name} MCP Server running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
