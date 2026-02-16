import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get as httpGet } from "node:http";
import {
  startAuth,
  exchangeCode,
  awaitCallback,
  storeTokens,
  getTokens,
  isTokenExpired,
  getValidAccessToken,
  _resetForTests,
} from "../src/oauth.js";
import type { OAuthConfig, OAuthTokens } from "../src/types.js";

/** Hit the localhost callback server using node:http (avoids fetch mock interference). */
function hitCallback(port: string, query: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpGet(`http://127.0.0.1:${port}/callback?${query}`, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    }).on("error", reject);
  });
}

const authCodeConfig: OAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  authUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["read", "write"],
  flow: "authorization_code",
  extraParams: {},
};

const clientCredsConfig: OAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["api.read"],
  flow: "client_credentials",
  extraParams: {},
};

beforeEach(() => {
  _resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startAuth - authorization_code flow", () => {
  it("returns an authorization URL with PKCE params", async () => {
    const result = await startAuth(authCodeConfig);
    expect("url" in result).toBe(true);
    if (!("url" in result)) return;

    const url = new URL(result.url);
    expect(url.origin + url.pathname).toBe(
      "https://auth.example.com/authorize"
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBe("read write");
    const redirectUri = url.searchParams.get("redirect_uri")!;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("includes extra params in the URL", async () => {
    const config = {
      ...authCodeConfig,
      extraParams: { access_type: "offline", prompt: "consent" },
    };
    const result = await startAuth(config);
    expect("url" in result).toBe(true);
    if (!("url" in result)) return;

    const url = new URL(result.url);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("throws if authUrl is missing", async () => {
    const config = { ...authCodeConfig, authUrl: undefined };
    await expect(startAuth(config)).rejects.toThrow(
      "OAuth authorization URL is required"
    );
  });
});

describe("startAuth - client_credentials flow", () => {
  it("exchanges credentials and returns tokens", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "cc-token-123",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "api.read",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await startAuth(clientCredsConfig);
    expect("tokens" in result).toBe(true);
    if (!("tokens" in result)) return;

    expect(result.tokens.accessToken).toBe("cc-token-123");
    expect(result.tokens.tokenType).toBe("Bearer");
    expect(result.tokens.scope).toBe("api.read");
  });

  it("sends correct form body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "tok", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await startAuth(clientCredsConfig);

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://auth.example.com/token");
    const body = new URLSearchParams((opts as RequestInit).body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("scope")).toBe("api.read");
  });

  it("throws on token endpoint error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Bad credentials", { status: 401, statusText: "Unauthorized" })
    );

    await expect(startAuth(clientCredsConfig)).rejects.toThrow(
      "OAuth token request failed (401 Unauthorized)"
    );
  });
});

describe("exchangeCode", () => {
  it("exchanges code with PKCE verifier", async () => {
    // First start a flow to populate pendingPkce
    await startAuth(authCodeConfig);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access-123",
          refresh_token: "refresh-456",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const tokens = await exchangeCode(authCodeConfig, "auth-code-xyz");

    expect(tokens.accessToken).toBe("access-123");
    expect(tokens.refreshToken).toBe("refresh-456");

    const body = new URLSearchParams(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-xyz");
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("client_id")).toBe("test-client-id");
  });

  it("uses localhost redirect_uri in exchange", async () => {
    const startResult = await startAuth(authCodeConfig);
    expect("url" in startResult).toBe(true);
    if (!("url" in startResult)) return;

    const authUrl = new URL(startResult.url);
    const redirectUri = authUrl.searchParams.get("redirect_uri")!;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access-123",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await exchangeCode(authCodeConfig, "code-123");

    const body = new URLSearchParams(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(body.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/
    );
  });

  it("throws without prior startAuth", async () => {
    await expect(exchangeCode(authCodeConfig, "code")).rejects.toThrow(
      "No pending authorization flow"
    );
  });
});

describe("awaitCallback", () => {
  it("exchanges code received via localhost callback", async () => {
    const startResult = await startAuth(authCodeConfig);
    expect("url" in startResult).toBe(true);
    if (!("url" in startResult)) return;

    const authUrl = new URL(startResult.url);
    const redirectUri = authUrl.searchParams.get("redirect_uri")!;
    const port = new URL(redirectUri).port;

    // Mock the token exchange fetch (called by awaitCallback internally)
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "callback-token-123",
          refresh_token: "callback-refresh-456",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    // Start awaiting the callback
    const callbackPromise = awaitCallback(authCodeConfig);

    // Hit the callback server with the auth code (using node:http to avoid fetch mock)
    const status = await hitCallback(port, "code=auth-code-from-google&state=test");
    expect(status).toBe(200);

    const tokens = await callbackPromise;
    expect(tokens.accessToken).toBe("callback-token-123");
    expect(tokens.refreshToken).toBe("callback-refresh-456");
  });

  it("rejects on OAuth error callback", async () => {
    const startResult = await startAuth(authCodeConfig);
    expect("url" in startResult).toBe(true);
    if (!("url" in startResult)) return;

    const authUrl = new URL(startResult.url);
    const port = new URL(authUrl.searchParams.get("redirect_uri")!).port;

    // Start awaiting and register a catch handler to prevent unhandled rejection warning
    const callbackPromise = awaitCallback(authCodeConfig);
    callbackPromise.catch(() => {});

    // Hit the callback server with an error (using node:http)
    await hitCallback(port, "error=access_denied&error_description=User+denied+access");

    await expect(callbackPromise).rejects.toThrow(
      "OAuth authorization failed: access_denied: User denied access"
    );
  });

  it("throws without prior startAuth", async () => {
    await expect(awaitCallback(authCodeConfig)).rejects.toThrow(
      "No pending authorization flow"
    );
  });
});

describe("token storage", () => {
  it("stores and retrieves tokens", () => {
    const tokens: OAuthTokens = {
      accessToken: "abc",
      refreshToken: "def",
      expiresAt: Date.now() + 3600_000,
      tokenType: "Bearer",
    };
    storeTokens(tokens);
    expect(getTokens()).toEqual(tokens);
  });

  it("reports expired tokens with buffer", () => {
    storeTokens({
      accessToken: "abc",
      expiresAt: Date.now() + 30_000, // 30s left, but 60s buffer
      tokenType: "Bearer",
    });
    expect(isTokenExpired()).toBe(true);
  });

  it("reports non-expired tokens", () => {
    storeTokens({
      accessToken: "abc",
      expiresAt: Date.now() + 120_000, // 2 min left, > 60s buffer
      tokenType: "Bearer",
    });
    expect(isTokenExpired()).toBe(false);
  });
});

describe("getValidAccessToken", () => {
  it("returns undefined when no OAuth config", async () => {
    const token = await getValidAccessToken(undefined);
    expect(token).toBeUndefined();
  });

  it("returns undefined when no tokens stored", async () => {
    const token = await getValidAccessToken(authCodeConfig);
    expect(token).toBeUndefined();
  });

  it("returns access token when not expired", async () => {
    storeTokens({
      accessToken: "valid-token",
      expiresAt: Date.now() + 120_000,
      tokenType: "Bearer",
    });
    const token = await getValidAccessToken(authCodeConfig);
    expect(token).toBe("valid-token");
  });

  it("refreshes expired token for client_credentials", async () => {
    storeTokens({
      accessToken: "old-token",
      expiresAt: Date.now() - 1000, // Already expired
      tokenType: "Bearer",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "new-cc-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const token = await getValidAccessToken(clientCredsConfig);
    expect(token).toBe("new-cc-token");
  });
});
