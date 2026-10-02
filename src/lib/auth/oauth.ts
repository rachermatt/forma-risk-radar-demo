import type { ApsAuthConfig } from "@/lib/auth/config";
import {
  constantTimeEqual,
  openSealedJson,
  randomBase64Url,
  sealJson,
  sha256Base64Url,
} from "@/lib/auth/crypto";
import { APS_AUTHORIZE_ENDPOINT } from "@/lib/auth/config";

export const OAUTH_TRANSACTION_COOKIE = "__Host-forma_risk_oauth";
export const OAUTH_TRANSACTION_TTL_SECONDS = 10 * 60;

export const SECURE_COOKIE_ATTRIBUTES = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
});

export interface OAuthTransaction {
  readonly state: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
  readonly expiresAt: number;
}

export interface CreatedOAuthTransaction {
  readonly transaction: OAuthTransaction;
  readonly codeChallenge: string;
}

export function validateReturnTo(candidate: string | null | undefined): string {
  if (
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    /[\u0000-\u001F\u007F]/u.test(candidate)
  ) {
    return "/";
  }

  // Reject encoded or repeatedly encoded backslashes and protocol-relative
  // paths before the Location header reaches a browser URL parser.
  let decoded = candidate;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return "/";
    }
    if (decoded.startsWith("//") || decoded.includes("\\")) {
      return "/";
    }
  }

  try {
    const base = new URL("https://risk-radar.invalid");
    const resolved = new URL(candidate, base);
    if (resolved.origin !== base.origin) {
      return "/";
    }
  } catch {
    return "/";
  }

  return candidate;
}

export function createOAuthTransaction(
  returnTo: string | null | undefined,
  now = Date.now(),
): CreatedOAuthTransaction {
  const codeVerifier = randomBase64Url(32);
  const transaction = Object.freeze({
    state: randomBase64Url(32),
    codeVerifier,
    returnTo: validateReturnTo(returnTo),
    expiresAt: now + OAUTH_TRANSACTION_TTL_SECONDS * 1_000,
  });

  return Object.freeze({
    transaction,
    codeChallenge: sha256Base64Url(codeVerifier),
  });
}

export function sealOAuthTransaction(
  transaction: OAuthTransaction,
  sessionSecret: string,
): string {
  return sealJson(transaction, sessionSecret);
}

function isOAuthTransaction(value: unknown): value is OAuthTransaction {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.state === "string" &&
    candidate.state.length >= 40 &&
    typeof candidate.codeVerifier === "string" &&
    candidate.codeVerifier.length >= 43 &&
    typeof candidate.returnTo === "string" &&
    validateReturnTo(candidate.returnTo) === candidate.returnTo &&
    typeof candidate.expiresAt === "number" &&
    Number.isSafeInteger(candidate.expiresAt)
  );
}

export function openOAuthTransaction(
  cookieValue: string,
  sessionSecret: string,
  now = Date.now(),
): OAuthTransaction | null {
  const opened = openSealedJson(cookieValue, sessionSecret);
  if (!isOAuthTransaction(opened) || opened.expiresAt < now) {
    return null;
  }
  return Object.freeze(opened);
}

export function oauthStateMatches(
  expectedState: string,
  receivedState: string | null,
): boolean {
  return receivedState !== null &&
    receivedState.length <= 256 &&
    constantTimeEqual(expectedState, receivedState);
}

export function buildApsAuthorizeUrl(
  config: ApsAuthConfig,
  transaction: OAuthTransaction,
  codeChallenge: string,
): URL {
  const url = new URL(APS_AUTHORIZE_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", transaction.state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}
