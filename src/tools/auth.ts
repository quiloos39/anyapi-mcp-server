import { z } from "zod";
import type { ToolContext } from "./shared.js";
import {
  startAuth,
  exchangeCode,
  awaitCallback,
  storeTokens,
  getTokens,
  isTokenExpired,
} from "../oauth.js";

export function registerAuth({ server, config }: ToolContext): void {
  if (!config.oauth) return;

  server.tool(
    "auth",
    `Manage OAuth 2.0 authentication for ${config.name}. ` +
      "Use action 'start' to begin the OAuth flow (returns an authorization URL for " +
      "authorization_code flow, or completes token exchange for client_credentials). " +
      "Use action 'exchange' to complete the flow — the callback is captured automatically " +
      "via a localhost server, or you can provide a 'code' manually. " +
      "Use action 'status' to check the current token status.",
    {
      action: z
        .enum(["start", "exchange", "status"])
        .describe(
          "'start' begins auth flow, 'exchange' completes code exchange, 'status' shows token info"
        ),
      code: z
        .string()
        .optional()
        .describe(
          "Authorization code from the OAuth provider (optional for 'exchange' — " +
            "if omitted, waits for the localhost callback automatically)"
        ),
    },
    async ({ action, code }) => {
      try {
        if (action === "start") {
          const result = await startAuth(config.oauth!);
          if ("url" in result) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      message:
                        "Open this URL to authorize. A local callback server is listening. " +
                        "After you approve, call auth with action 'exchange' to complete authentication.",
                      authorizationUrl: result.url,
                      flow: config.oauth!.flow,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          // client_credentials: tokens obtained directly
          storeTokens(result.tokens);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    message:
                      "Authentication successful (client_credentials flow).",
                    tokenType: result.tokens.tokenType,
                    expiresIn: Math.round(
                      (result.tokens.expiresAt - Date.now()) / 1000
                    ),
                    scope: result.tokens.scope ?? null,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        if (action === "exchange") {
          const tokens = code
            ? await exchangeCode(config.oauth!, code)
            : await awaitCallback(config.oauth!);
          storeTokens(tokens);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    message: "Authentication successful.",
                    tokenType: tokens.tokenType,
                    expiresIn: Math.round(
                      (tokens.expiresAt - Date.now()) / 1000
                    ),
                    hasRefreshToken: !!tokens.refreshToken,
                    scope: tokens.scope ?? null,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // action === "status"
        const tokens = getTokens();
        if (!tokens) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    authenticated: false,
                    message:
                      "No tokens stored. Use auth with action 'start' to authenticate.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const expired = isTokenExpired();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  authenticated: true,
                  tokenType: tokens.tokenType,
                  expired,
                  expiresIn: Math.round(
                    (tokens.expiresAt - Date.now()) / 1000
                  ),
                  hasRefreshToken: !!tokens.refreshToken,
                  scope: tokens.scope ?? null,
                },
                null,
                2
              ),
            },
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
