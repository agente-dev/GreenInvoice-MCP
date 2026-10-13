/**
 * Green Invoice API client with automatic token management.
 *
 * DISCLAIMER: This is an unofficial, third-party client.
 * Not affiliated with or endorsed by Green Invoice.
 */

export const PRODUCTION_BASE = "https://api.greeninvoice.co.il/api/v1";
export const SANDBOX_BASE = "https://sandbox.d.greeninvoice.co.il/api/v1";

const PRODUCTION_TOKEN_URL = "https://api.morning.co/idp/v1/oauth/token";
const SANDBOX_TOKEN_URL = "https://api.sandbox.morning.dev/idp/v1/oauth/token";
const TOKEN_TTL_MS = 25 * 60 * 1000; // Preserve the legacy flow's existing 25-minute cache.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // Existing 5-minute safety margin; at least the 60s contract minimum.
const MIN_REQUEST_INTERVAL_MS = 350; // ~3 req/s rate limit

type AuthMode = "auto" | "oauth" | "legacy";
type AuthStrategy = "oauth" | "legacy";

interface TokenCache {
  token: string;
  expiresAtMs: number;
}

const BUSINESS_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeResourceId(resourceId: string): string {
  const normalized = resourceId.trim();
  if (!BUSINESS_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid Green Invoice business ID: ${resourceId}`);
  }
  return normalized;
}

export class GreenInvoiceClient {
  private apiId: string;
  private apiSecret: string;
  private baseUrl: string;
  private tokenUrl: string;
  private authMode: AuthMode;
  private winningStrategy: AuthStrategy | null = null;
  private tokenCache: TokenCache | null = null;
  private lastRequestTime = 0;
  private activeResourceId: string | null = null;

  readonly sandbox: boolean;

  constructor(apiId: string, apiSecret: string, sandbox = false) {
    this.apiId = apiId;
    this.apiSecret = apiSecret;
    this.sandbox = sandbox;
    this.baseUrl = sandbox ? SANDBOX_BASE : PRODUCTION_BASE;

    const authMode = process.env.GREENINVOICE_AUTH_MODE ?? "auto";
    if (authMode !== "auto" && authMode !== "oauth" && authMode !== "legacy") {
      throw new Error(`Invalid GREENINVOICE_AUTH_MODE: ${authMode}`);
    }
    this.authMode = authMode;
    const tokenUrlOverride = process.env.GREENINVOICE_TOKEN_URL?.trim();
    this.tokenUrl =
      tokenUrlOverride ||
      (this.baseUrl.includes("sandbox.")
        ? SANDBOX_TOKEN_URL
        : PRODUCTION_TOKEN_URL);
  }

  /** Which environment this client is bound to. Fixed at construction. */
  get environment(): "sandbox" | "production" {
    return this.sandbox ? "sandbox" : "production";
  }

  get base(): string {
    return this.baseUrl;
  }

  /**
   * Business selected for subsequent API calls.
   *
   * Morning's representative UI keeps the same authorization token when a CPA
   * switches to an invited client business and sends the selected business UUID
   * in X-Resource-Id.
   */
  get resourceId(): string | null {
    return this.activeResourceId;
  }

  setResourceId(resourceId: string | null): void {
    if (resourceId === null) {
      this.activeResourceId = null;
      return;
    }

    this.activeResourceId = normalizeResourceId(resourceId);
  }

  private requestHeaders(
    token: string,
    resourceIdOverride?: string | null
  ): Record<string, string> {
    const resourceId =
      resourceIdOverride === undefined
        ? this.activeResourceId
        : resourceIdOverride === null
          ? null
          : normalizeResourceId(resourceIdOverride);

    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(resourceId ? { "X-Resource-Id": resourceId } : {}),
    };
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  private async getToken(): Promise<string> {
    if (
      this.tokenCache &&
      Date.now() < this.tokenCache.expiresAtMs - TOKEN_REFRESH_MARGIN_MS
    ) {
      return this.tokenCache.token;
    }

    const useLegacy =
      this.authMode === "legacy" ||
      (this.authMode === "auto" && this.winningStrategy === "legacy");
    if (useLegacy) {
      const token = await this.requestLegacyToken();
      this.tokenCache = token;
      return token.token;
    }

    if (this.authMode === "auto" && this.winningStrategy === null) {
      try {
        const token = await this.requestOAuthToken();
        this.winningStrategy = "oauth";
        this.tokenCache = token;
        return token.token;
      } catch (oauthError) {
        try {
          const token = await this.requestLegacyToken();
          this.winningStrategy = "legacy";
          this.tokenCache = token;
          return token.token;
        } catch (legacyError) {
          const oauthMessage =
            oauthError instanceof Error ? oauthError.message : String(oauthError);
          const legacyMessage =
            legacyError instanceof Error ? legacyError.message : String(legacyError);
          throw new Error(
            `OAuth auth failed: ${oauthMessage}; legacy auth failed: ${legacyMessage}`,
          );
        }
      }
    }

    const token = await this.requestOAuthToken();
    if (this.authMode === "auto") this.winningStrategy = "oauth";
    this.tokenCache = token;
    return token.token;
  }

  private async requestOAuthToken(): Promise<TokenCache> {
    await this.rateLimit();

    const res = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.apiId,
        client_secret: this.apiSecret,
        grant_type: "client_credentials",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth auth failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      accessToken?: unknown;
      expiresAt?: unknown;
    };
    if (typeof data.accessToken !== "string" || !data.accessToken) {
      throw new Error("No accessToken in OAuth response");
    }
    if (
      typeof data.expiresAt !== "number" ||
      !Number.isInteger(data.expiresAt) ||
      data.expiresAt * 1000 <= Date.now()
    ) {
      throw new Error("No valid expiresAt in OAuth response");
    }

    return { token: data.accessToken, expiresAtMs: data.expiresAt * 1000 };
  }

  private async requestLegacyToken(): Promise<TokenCache> {
    await this.rateLimit();

    const res = await fetch(`${this.baseUrl}/account/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: this.apiId, secret: this.apiSecret }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Auth failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { token?: unknown };
    const token = data.token || res.headers.get("X-Authorization-Bearer");
    if (typeof token !== "string" || !token) {
      throw new Error("No token in auth response");
    }

    // The old client cached for 25 minutes against an approximately 30-minute
    // token lifetime. Preserve that larger safety margin for legacy auth.
    return {
      token,
      expiresAtMs: Date.now() + TOKEN_TTL_MS + TOKEN_REFRESH_MARGIN_MS,
    };
  }

  private invalidateToken(): void {
    this.tokenCache = null;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    resourceId?: string | null
  ): Promise<unknown> {
    await this.rateLimit();
    const token = await this.getToken();

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.requestHeaders(token, resourceId),
      body: body ? JSON.stringify(body) : undefined,
    });

    // Retry once on 401 with fresh token
    if (res.status === 401) {
      this.invalidateToken();
      const freshToken = await this.getToken();
      const retry = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.requestHeaders(freshToken, resourceId),
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!retry.ok) {
        const text = await retry.text();
        throw new Error(`API error (${retry.status}): ${text}`);
      }
      return retry.json();
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error (${res.status}): ${text}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  async get(path: string, resourceId?: string | null): Promise<unknown> {
    return this.request("GET", path, undefined, resourceId);
  }

  async post(
    path: string,
    body?: unknown,
    resourceId?: string | null
  ): Promise<unknown> {
    return this.request("POST", path, body, resourceId);
  }

  async put(
    path: string,
    body: unknown,
    resourceId?: string | null
  ): Promise<unknown> {
    return this.request("PUT", path, body, resourceId);
  }

  async delete(path: string, resourceId?: string | null): Promise<unknown> {
    return this.request("DELETE", path, undefined, resourceId);
  }
}
