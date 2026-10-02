import { APS_TOKEN_ENDPOINT, type ApsAuthConfig } from "@/lib/auth/config";
import {
  BoundedResponseError,
  readBoundedResponseText,
} from "@/lib/http/bounded-response";

export interface ApsTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: "Bearer";
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class OAuthTokenError extends Error {
  readonly code:
    | "token_exchange_failed"
    | "invalid_token_response"
    | "scope_mismatch";
  readonly status: number | null;

  constructor(
    code: OAuthTokenError["code"],
    status: number | null = null,
  ) {
    super("Autodesk authentication failed.");
    this.name = "OAuthTokenError";
    this.code = code;
    this.status = status;
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const APS_TOKEN_REQUEST_TIMEOUT_MS = 15_000;
export const APS_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readExpiresIn(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isSafeInteger(numeric)) {
    return null;
  }
  return numeric;
}

function scopeSet(scopeText: string): Set<string> {
  return new Set(scopeText.split(/\s+/u).filter(Boolean));
}

export function scopesExactlyMatch(
  expectedScopes: readonly string[],
  grantedScopeText: string,
): boolean {
  const expected = new Set(expectedScopes);
  const granted = scopeSet(grantedScopeText);
  return expected.size === granted.size &&
    [...expected].every((scope) => granted.has(scope));
}

export function parseApsTokenResponse(
  value: unknown,
  expectedScopes: readonly string[],
  now = Date.now(),
): ApsTokenSet {
  if (!isRecord(value)) {
    throw new OAuthTokenError("invalid_token_response");
  }

  const accessToken = value.access_token;
  const refreshToken = value.refresh_token;
  const tokenType = value.token_type;
  const scope = value.scope;
  const expiresIn = readExpiresIn(value.expires_in);

  if (
    typeof accessToken !== "string" || accessToken.length === 0 ||
    typeof refreshToken !== "string" || refreshToken.length === 0 ||
    typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer" ||
    typeof scope !== "string" ||
    expiresIn === null
  ) {
    throw new OAuthTokenError("invalid_token_response");
  }

  if (!scopesExactlyMatch(expectedScopes, scope)) {
    throw new OAuthTokenError("scope_mismatch");
  }

  return Object.freeze({
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    scopes: Object.freeze([...expectedScopes]),
    issuedAt: now,
    expiresAt: now + expiresIn * 1_000,
  });
}

async function requestTokens(
  parameters: URLSearchParams,
  expectedScopes: readonly string[],
  fetchImplementation: FetchLike,
  now: number,
): Promise<ApsTokenSet> {
  let response: Response;
  try {
    response = await fetchImplementation(APS_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: parameters.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(APS_TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthTokenError("token_exchange_failed");
  }

  if (!response.ok) {
    // Do not read or propagate Autodesk's response body: OAuth errors can echo
    // request material or implementation details that do not belong in the UI.
    throw new OAuthTokenError("token_exchange_failed", response.status);
  }

  let payload: unknown;
  try {
    const responseText = await readBoundedResponseText(
      response,
      APS_TOKEN_RESPONSE_MAX_BYTES,
    );
    payload = JSON.parse(responseText) as unknown;
  } catch (error) {
    if (error instanceof BoundedResponseError) {
      // A bounded-read failure is an upstream transport failure. Preserve a
      // stored refresh token so a later request can retry safely.
      throw new OAuthTokenError("token_exchange_failed", response.status);
    }
    throw new OAuthTokenError("invalid_token_response", response.status);
  }

  return parseApsTokenResponse(payload, expectedScopes, now);
}

export function exchangeAuthorizationCode(
  config: ApsAuthConfig,
  code: string,
  codeVerifier: string,
  fetchImplementation: FetchLike = fetch,
  now = Date.now(),
): Promise<ApsTokenSet> {
  const parameters = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.callbackUrl,
    code_verifier: codeVerifier,
  });
  return requestTokens(parameters, config.scopes, fetchImplementation, now);
}

export function refreshApsTokens(
  config: ApsAuthConfig,
  refreshToken: string,
  fetchImplementation: FetchLike = fetch,
  now = Date.now(),
): Promise<ApsTokenSet> {
  const parameters = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });
  return requestTokens(parameters, config.scopes, fetchImplementation, now);
}
