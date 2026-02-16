import { randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OAuthConfig, OAuthTokens } from "./types.js";

const EXPIRY_BUFFER_MS = 60_000;
const CALLBACK_PATH = "/callback";
const CALLBACK_TIMEOUT_MS = 300_000; // 5 minutes

const TOKEN_DIR =
  process.platform === "win32"
    ? join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "anyapi-mcp",
        "tokens"
      )
    : join(homedir(), ".cache", "anyapi-mcp", "tokens");

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let pendingPkce: { verifier: string; state: string } | null = null;
let currentTokens: OAuthTokens | null = null;
let persistName: string | null = null;
let refreshPromise: Promise<OAuthTokens> | null = null;

// Localhost callback server state
let callbackServer: Server | null = null;
let callbackCodePromise: Promise<string> | null = null;
let callbackRedirectUri = "";
let callbackTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

export function initTokenStorage(name: string): void {
  persistName = name;
  const tokenPath = join(TOKEN_DIR, `${name}.json`);
  if (existsSync(tokenPath)) {
    try {
      const raw = readFileSync(tokenPath, "utf-8");
      const loaded = JSON.parse(raw) as OAuthTokens;
      if (loaded.accessToken && typeof loaded.expiresAt === "number") {
        currentTokens = loaded;
      }
    } catch {
      // Corrupt file — will re-auth
    }
  }
}

function persistTokens(tokens: OAuthTokens): void {
  if (!persistName) return;
  try {
    mkdirSync(TOKEN_DIR, { recursive: true });
    writeFileSync(
      join(TOKEN_DIR, `${persistName}.json`),
      JSON.stringify(tokens, null, 2),
      "utf-8"
    );
  } catch (err) {
    console.error(`[oauth] Failed to persist tokens: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Token accessors
// ---------------------------------------------------------------------------

export function storeTokens(tokens: OAuthTokens): void {
  currentTokens = tokens;
  persistTokens(tokens);
}

export function getTokens(): OAuthTokens | null {
  return currentTokens;
}

export function clearTokens(): void {
  currentTokens = null;
}

export function isTokenExpired(): boolean {
  if (!currentTokens) return true;
  return Date.now() >= currentTokens.expiresAt - EXPIRY_BUFFER_MS;
}

// ---------------------------------------------------------------------------
// Localhost callback server
// ---------------------------------------------------------------------------

function cleanupCallbackServer(): void {
  if (callbackTimeoutHandle) {
    clearTimeout(callbackTimeoutHandle);
    callbackTimeoutHandle = null;
  }
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
  }
  callbackCodePromise = null;
  callbackRedirectUri = "";
}

function startCallbackServer(): Promise<{
  port: number;
  codePromise: Promise<string>;
}> {
  return new Promise((resolveSetup, rejectSetup) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;

    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // Mark promise as handled to prevent Node.js unhandled rejection warning.
    // The rejection will still propagate through awaitCallback/exchangeCode.
    codePromise.catch(() => {});

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const errorDesc = url.searchParams.get("error_description");

      if (error) {
        const msg = errorDesc ? `${error}: ${errorDesc}` : error;
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          "<html><body style=\"font-family:system-ui;text-align:center;padding:40px\">" +
            `<h1>Authentication Failed</h1><p>${msg}</p>` +
            "<p style=\"color:#666\">You can close this window.</p></body></html>"
        );
        rejectCode(new Error(`OAuth authorization failed: ${msg}`));
      } else if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body style=\"font-family:system-ui;text-align:center;padding:40px\">" +
            "<h1>Authentication Successful</h1>" +
            "<p>You can close this window and return to Claude.</p></body></html>"
        );
        resolveCode(code);
      } else {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          "<html><body style=\"font-family:system-ui;text-align:center;padding:40px\">" +
            "<h1>Error</h1><p>No authorization code received.</p></body></html>"
        );
      }

      // Close the HTTP server (no longer needed) but preserve
      // callbackCodePromise and callbackRedirectUri for awaitCallback/exchangeCode.
      if (callbackTimeoutHandle) {
        clearTimeout(callbackTimeoutHandle);
        callbackTimeoutHandle = null;
      }
      setTimeout(() => {
        if (callbackServer) {
          callbackServer.close();
          callbackServer = null;
        }
      }, 500);
    });

    server.on("error", rejectSetup);

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      callbackServer = server;

      // Timeout: reject code promise and clean up after 5 minutes
      callbackTimeoutHandle = setTimeout(() => {
        rejectCode(
          new Error(
            "OAuth callback timed out after 5 minutes. Please try auth start again."
          )
        );
        cleanupCallbackServer();
      }, CALLBACK_TIMEOUT_MS);

      resolveSetup({ port, codePromise });
    });
  });
}

// ---------------------------------------------------------------------------
// Token exchange helpers
// ---------------------------------------------------------------------------

async function fetchTokens(
  tokenUrl: string,
  body: URLSearchParams
): Promise<OAuthTokens> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(
      `OAuth token request failed (${res.status} ${res.statusText}): ${errorBody}`
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  if (typeof data.access_token !== "string") {
    throw new Error("OAuth token response missing access_token");
  }

  const expiresIn =
    typeof data.expires_in === "number" ? data.expires_in : 3600;

  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType:
      typeof data.token_type === "string" ? data.token_type : "Bearer",
    scope: typeof data.scope === "string" ? data.scope : undefined,
  };
}

async function exchangeClientCredentials(
  config: OAuthConfig
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  if (config.scopes.length > 0) {
    body.set("scope", config.scopes.join(" "));
  }
  return fetchTokens(config.tokenUrl, body);
}

// ---------------------------------------------------------------------------
// Public API — auth flow
// ---------------------------------------------------------------------------

export async function startAuth(
  config: OAuthConfig
): Promise<{ url: string } | { tokens: OAuthTokens }> {
  if (config.flow === "client_credentials") {
    const tokens = await exchangeClientCredentials(config);
    return { tokens };
  }

  if (!config.authUrl) {
    throw new Error(
      "OAuth authorization URL is required for authorization_code flow. " +
        "Provide --oauth-auth-url or ensure the OpenAPI spec has securitySchemes with an authorizationUrl."
    );
  }

  // Clean up any previous callback server
  cleanupCallbackServer();

  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = randomBytes(16).toString("hex");

  pendingPkce = { verifier, state };

  // Start localhost callback server on a random available port
  const { port, codePromise } = await startCallbackServer();
  callbackRedirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  callbackCodePromise = codePromise;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: callbackRedirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...config.extraParams,
  });
  if (config.scopes.length > 0) {
    params.set("scope", config.scopes.join(" "));
  }

  const url = `${config.authUrl}?${params.toString()}`;
  return { url };
}

export async function exchangeCode(
  config: OAuthConfig,
  code: string
): Promise<OAuthTokens> {
  if (!pendingPkce) {
    throw new Error(
      "No pending authorization flow. Call auth with action 'start' first."
    );
  }

  const { verifier } = pendingPkce;
  pendingPkce = null;

  const redirectUri = callbackRedirectUri;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

  cleanupCallbackServer();
  return fetchTokens(config.tokenUrl, body);
}

/**
 * Wait for the localhost callback server to receive the authorization code,
 * then exchange it for tokens automatically.
 */
export async function awaitCallback(
  config: OAuthConfig
): Promise<OAuthTokens> {
  if (!callbackCodePromise) {
    throw new Error(
      "No pending authorization flow. Call auth with action 'start' first."
    );
  }
  if (!pendingPkce) {
    throw new Error(
      "No pending PKCE state. Call auth with action 'start' first."
    );
  }

  const code = await callbackCodePromise;

  const { verifier } = pendingPkce;
  pendingPkce = null;

  const redirectUri = callbackRedirectUri;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

  cleanupCallbackServer();
  return fetchTokens(config.tokenUrl, body);
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export async function refreshTokens(
  config: OAuthConfig
): Promise<OAuthTokens> {
  if (!currentTokens?.refreshToken) {
    throw new Error(
      "Cannot refresh: no refresh token available. " +
        "Re-authenticate using the auth tool with action 'start'."
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: currentTokens.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const tokens = await fetchTokens(config.tokenUrl, body);

  // Preserve refresh token if server didn't issue a new one
  if (!tokens.refreshToken && currentTokens.refreshToken) {
    tokens.refreshToken = currentTokens.refreshToken;
  }

  storeTokens(tokens);
  return tokens;
}

// ---------------------------------------------------------------------------
// Auth middleware — called by api-client before each request
// ---------------------------------------------------------------------------

export async function getValidAccessToken(
  config: OAuthConfig | undefined
): Promise<string | undefined> {
  if (!config || !currentTokens) return undefined;

  if (isTokenExpired()) {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        try {
          if (config.flow === "client_credentials") {
            const tokens = await exchangeClientCredentials(config);
            storeTokens(tokens);
            return tokens;
          }
          return await refreshTokens(config);
        } finally {
          refreshPromise = null;
        }
      })();
    }
    const tokens = await refreshPromise;
    return tokens.accessToken;
  }

  return currentTokens.accessToken;
}

// ---------------------------------------------------------------------------
// Test helpers — reset module state
// ---------------------------------------------------------------------------

export function _resetForTests(): void {
  pendingPkce = null;
  currentTokens = null;
  persistName = null;
  refreshPromise = null;
  cleanupCallbackServer();
}
