import { normalizedApsScopes, normalizedDataMode } from "@/lib/config/environment";

export const APS_AUTHORIZE_ENDPOINT =
  "https://developer.api.autodesk.com/authentication/v2/authorize";
export const APS_TOKEN_ENDPOINT =
  "https://developer.api.autodesk.com/authentication/v2/token";

export interface ApsAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  readonly accountId: string;
  readonly scopes: readonly string[];
  readonly sessionSecret: string;
}

export type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export class AuthConfigurationError extends Error {
  constructor() {
    super("Autodesk authentication is not configured.");
    this.name = "AuthConfigurationError";
  }
}

function requireValue(
  environment: AuthEnvironment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new AuthConfigurationError();
  }
  return value;
}

function readScopes(environment: AuthEnvironment): readonly string[] {
  const rawScopes = requireValue(environment, "APS_SCOPES");
  const scopes = normalizedApsScopes(rawScopes);

  // The application deliberately has no built-in scope list. An operator must
  // supply the exact, reviewed APS scopes for the registered application.
  if (!scopes) {
    throw new AuthConfigurationError();
  }

  return Object.freeze(scopes);
}

function validateCallbackUrl(rawUrl: string): string {
  let callback: URL;
  try {
    callback = new URL(rawUrl);
  } catch {
    throw new AuthConfigurationError();
  }

  const isLoopback =
    callback.hostname === "localhost" ||
    callback.hostname === "127.0.0.1" ||
    callback.hostname === "[::1]";
  const allowedProtocol = callback.protocol === "https:" ||
    (isLoopback && callback.protocol === "http:");

  if (
    !allowedProtocol ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.hash !== ""
  ) {
    throw new AuthConfigurationError();
  }

  return callback.toString();
}

function validateSessionSecret(secret: string): string {
  if (
    Buffer.byteLength(secret, "utf8") < 32 ||
    /^(change[-_ ]?me|replace[-_ ]?me|example|placeholder)/iu.test(secret)
  ) {
    throw new AuthConfigurationError();
  }
  return secret;
}

function validateAccountId(accountId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(accountId)) {
    throw new AuthConfigurationError();
  }
  return accountId;
}

export function loadApsAuthConfig(
  environment: AuthEnvironment = process.env,
): ApsAuthConfig {
  // The embedded store is intended for a single local process. Production
  // Autodesk sessions require shared PostgreSQL so refresh locks, revocation,
  // and the scheduled expiry sweep cover every replica.
  if (environment.NODE_ENV === "production" && !environment.DATABASE_URL?.trim()) {
    throw new AuthConfigurationError();
  }
  return Object.freeze({
    clientId: requireValue(environment, "APS_CLIENT_ID"),
    clientSecret: requireValue(environment, "APS_CLIENT_SECRET"),
    callbackUrl: validateCallbackUrl(
      requireValue(environment, "APS_CALLBACK_URL"),
    ),
    accountId: validateAccountId(requireValue(environment, "ACC_ACCOUNT_ID")),
    scopes: readScopes(environment),
    sessionSecret: validateSessionSecret(
      requireValue(environment, "SESSION_SECRET"),
    ),
  });
}

export function isAutodeskMode(
  environment: AuthEnvironment = process.env,
): boolean {
  return normalizedDataMode(environment.DATA_MODE) === "autodesk";
}
