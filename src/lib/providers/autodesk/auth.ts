import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ApsAccessContext,
  ApsAuthProvider,
  ApsSessionTokens,
  AuthorizationAttempt,
  AuthorizationCallback,
  CoverageResult,
  HubRegion,
} from "../contracts";
import { available } from "../contracts";
import { ProviderOperationError } from "../errors";
import type { AutodeskProviderConfig } from "./config";
import { ApsReadTransport, ApsTransportError, type FetchLike, type JsonObject, type JsonValue } from "./transport";
import {
  BoundedResponseError,
  readBoundedResponseText,
} from "@/lib/http/bounded-response";

export const APS_AUTHORIZE_URL = "https://developer.api.autodesk.com/authentication/v2/authorize";
export const APS_TOKEN_URL = "https://developer.api.autodesk.com/authentication/v2/token";

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonValue, key: string): string | null {
  if (!isObject(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function numberField(value: JsonValue, key: string): number | null {
  if (!isObject(value)) return null;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function sameScopes(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false;
  const actualSet = new Set(actual);
  return expected.every((scope) => actualSet.has(scope));
}

function safeReturnTo(returnTo: string): string {
  if (
    !returnTo.startsWith("/") ||
    returnTo.startsWith("//") ||
    returnTo.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(returnTo)
  ) {
    return "/";
  }
  return returnTo;
}

function matchesState(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

interface AuthProviderOptions {
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export const APS_PROVIDER_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

/** Stateless OAuth/PKCE mechanics. Session encryption and cookies remain route-layer concerns. */
export class AutodeskApsAuthProvider implements ApsAuthProvider {
  readonly mode = "autodesk" as const;
  readonly #config: AutodeskProviderConfig;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #refreshLocks = new Map<string, Promise<ApsSessionTokens>>();

  constructor(config: AutodeskProviderConfig, options: AuthProviderOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = Math.max(1, Math.min(options.requestTimeoutMs ?? 30_000, 120_000));
    this.#maxResponseBytes = Math.max(
      1,
      Math.min(
        options.maxResponseBytes ?? APS_PROVIDER_TOKEN_RESPONSE_MAX_BYTES,
        APS_PROVIDER_TOKEN_RESPONSE_MAX_BYTES,
      ),
    );
  }

  async beginAuthorization(returnTo: string): Promise<AuthorizationAttempt> {
    const codeVerifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const authorizationUrl = new URL(APS_AUTHORIZE_URL);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: this.#config.clientId,
      redirect_uri: this.#config.callbackUrl,
      scope: this.#config.scopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();

    return {
      authorizationUrl: authorizationUrl.toString(),
      state,
      codeVerifier,
      expiresAt: new Date(this.#now() + 10 * 60_000).toISOString(),
      returnTo: safeReturnTo(returnTo),
    };
  }

  async exchangeAuthorizationCode(callback: AuthorizationCallback): Promise<ApsSessionTokens> {
    if (!matchesState(callback.state, callback.expectedState)) {
      throw new ProviderOperationError("oauth-state-mismatch", "The OAuth callback state is invalid.");
    }
    return this.#tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.code,
        redirect_uri: this.#config.callbackUrl,
        code_verifier: callback.codeVerifier,
      }),
    );
  }

  refresh(sessionId: string, refreshToken: string): Promise<ApsSessionTokens> {
    const existing = this.#refreshLocks.get(sessionId);
    if (existing) return existing;

    const pending = this.#tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: this.#config.scopes.join(" "),
      }),
    ).finally(() => {
      if (this.#refreshLocks.get(sessionId) === pending) this.#refreshLocks.delete(sessionId);
    });
    this.#refreshLocks.set(sessionId, pending);
    return pending;
  }

  async resolveHubRegion(
    context: ApsAccessContext,
    hubId: string,
  ): Promise<CoverageResult<HubRegion>> {
    const successes: HubRegion[] = [];
    let restricted = false;
    let retryable = false;
    for (const region of ["US", "EMEA"] as const) {
      const transport = new ApsReadTransport({
        accessContext: async () => context,
        region,
        fetch: this.#fetch,
        maxAttempts: 1,
      });
      try {
        await transport.get({
          service: "hub-admin",
          path: `/construction/admin/v1/accounts/${encodeURIComponent(hubId)}/projects`,
          query: { limit: 1 },
        });
        successes.push(region);
      } catch (error) {
        if (error instanceof ApsTransportError) {
          if (error.status === 401 || error.status === 403) restricted = true;
          if (error.retryable) retryable = true;
          if (error.status === 404) continue;
        } else {
          retryable = true;
        }
      }
    }

    const observedAt = new Date(this.#now()).toISOString();
    const resolvedRegion = successes[0];
    if (successes.length === 1 && resolvedRegion) return available(resolvedRegion, observedAt);
    if (restricted) {
      return {
        state: "restricted",
        observedAt,
        reason: "Hub membership or custom-integration access could not be established.",
        warnings: [],
      };
    }
    return {
      state: "unreachable",
      observedAt,
      reason:
        successes.length > 1
          ? "The hub region probe was inconclusive."
          : "The hub could not be reached in a supported region.",
      retryable,
      warnings: [],
    };
  }

  async #tokenRequest(body: URLSearchParams): Promise<ApsSessionTokens> {
    const basic = Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`).toString("base64");
    let response: Response;
    let responseText = "";
    try {
      response = await this.#fetch(APS_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      if (response.ok) {
        responseText = await readBoundedResponseText(response, this.#maxResponseBytes);
      }
    } catch (error) {
      if (
        error instanceof BoundedResponseError &&
        error.failure !== "body-unreadable"
      ) {
        throw new ProviderOperationError(
          "oauth-token-malformed",
          "APS returned a token response outside the configured body bounds.",
        );
      }
      throw new ProviderOperationError(
        "oauth-token-unreachable",
        "APS token service could not be reached.",
        true,
      );
    }
    if (!response.ok) {
      throw new ProviderOperationError(
        "oauth-token-failed",
        `APS token exchange failed with HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
      );
    }

    let payload: JsonValue;
    try {
      payload = JSON.parse(responseText) as JsonValue;
    } catch {
      throw new ProviderOperationError("oauth-token-malformed", "APS returned an unreadable token response.");
    }
    const accessToken = stringField(payload, "access_token");
    const refreshToken = stringField(payload, "refresh_token");
    const expiresIn = numberField(payload, "expires_in");
    const grantedScope = stringField(payload, "scope");
    if (!accessToken || !refreshToken || expiresIn === null || expiresIn <= 0 || !grantedScope) {
      throw new ProviderOperationError("oauth-token-malformed", "APS returned an incomplete token response.");
    }
    const grantedScopes = grantedScope.split(/\s+/u).filter(Boolean);
    if (!sameScopes(this.#config.scopes, grantedScopes)) {
      throw new ProviderOperationError(
        "oauth-scope-mismatch",
        "APS granted a scope set different from the configured scope set.",
      );
    }

    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(this.#now() + expiresIn * 1_000).toISOString(),
      grantedScopes,
      userId: null,
    };
  }
}
