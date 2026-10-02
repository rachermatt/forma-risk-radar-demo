import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { randomBase64Url, signValue, verifySignedValue } from "@/lib/auth/crypto";
import type { ApsTokenSet } from "@/lib/auth/token";

export const SESSION_COOKIE = "__Host-forma_risk_session";
export const SESSION_IDLE_TTL_SECONDS = 24 * 60 * 60;
export const SESSION_ABSOLUTE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_PURGE_BATCH_SIZE = 100;

export interface StoredSession {
  readonly id: string;
  readonly accountId: string;
  readonly encryptedTokens: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastSeenAt: number;
}

export interface ExpiredSession {
  readonly id: string;
  readonly accountId: string;
}

export interface SessionStore {
  create(session: StoredSession): Promise<void>;
  read(sessionId: string): Promise<StoredSession | null>;
  replaceTokens(
    sessionId: string,
    expectedUpdatedAt: number,
    encryptedTokens: string,
    updatedAt: number,
    lastSeenAt: number,
  ): Promise<boolean>;
  touch(
    sessionId: string,
    expectedLastSeenAt: number,
    lastSeenAt: number,
  ): Promise<boolean>;
  deleteIfUnchanged(
    sessionId: string,
    expectedUpdatedAt: number,
  ): Promise<boolean>;
  delete(sessionId: string): Promise<void>;
  purgeExpired(
    absoluteCutoff: number,
    idleCutoff: number,
    limit: number,
  ): Promise<readonly ExpiredSession[]>;
  /** Serializes refresh-token rotation across processes sharing the store. */
  withRefreshLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
}

let installedSessionStore: SessionStore | null = null;

/**
 * Composition-root seam for a database-backed store. There is intentionally no
 * in-memory production fallback: losing server state must not create a session
 * whose tokens cannot be revoked or rotated.
 */
export function installSessionStore(store: SessionStore): () => void {
  if (installedSessionStore !== null && installedSessionStore !== store) {
    throw new Error("A session store is already installed.");
  }
  installedSessionStore = store;
  return () => {
    if (installedSessionStore === store) {
      installedSessionStore = null;
    }
  };
}

export function getSessionStore(): SessionStore | null {
  return installedSessionStore;
}

function deriveEncryptionKey(sessionSecret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(sessionSecret, "utf8"),
      Buffer.from("forma-risk-radar/session/v1", "utf8"),
      Buffer.from("aps-token-envelope", "utf8"),
      32,
    ),
  );
}

function envelopeAad(sessionId: string, accountId: string): Buffer {
  return Buffer.from(`v1\u0000${sessionId}\u0000${accountId}`, "utf8");
}

export function encryptTokenEnvelope(
  tokens: ApsTokenSet,
  sessionId: string,
  accountId: string,
  sessionSecret: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveEncryptionKey(sessionSecret),
    iv,
  );
  cipher.setAAD(envelopeAad(sessionId, accountId));
  const plaintext = Buffer.from(JSON.stringify(tokens), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authenticationTag.toString("base64url"),
  ].join(".");
}

function isTokenSet(value: unknown): value is ApsTokenSet {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accessToken === "string" &&
    typeof candidate.refreshToken === "string" &&
    candidate.tokenType === "Bearer" &&
    Array.isArray(candidate.scopes) &&
    candidate.scopes.every((scope) => typeof scope === "string") &&
    typeof candidate.issuedAt === "number" &&
    typeof candidate.expiresAt === "number"
  );
}

export function decryptTokenEnvelope(
  envelope: string,
  sessionId: string,
  accountId: string,
  sessionSecret: string,
): ApsTokenSet | null {
  const [version, encodedIv, encodedCiphertext, encodedTag, extra] =
    envelope.split(".");
  if (
    version !== "v1" || !encodedIv || !encodedCiphertext || !encodedTag || extra
  ) {
    return null;
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveEncryptionKey(sessionSecret),
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAAD(envelopeAad(sessionId, accountId));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    return isTokenSet(parsed) ? Object.freeze(parsed) : null;
  } catch {
    return null;
  }
}

export function createStoredSession(
  tokens: ApsTokenSet,
  accountId: string,
  sessionSecret: string,
  now = Date.now(),
): StoredSession {
  const id = randomBase64Url(32);
  return Object.freeze({
    id,
    accountId,
    encryptedTokens: encryptTokenEnvelope(tokens, id, accountId, sessionSecret),
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
}

export function sessionAbsoluteExpiresAt(session: StoredSession): number {
  return session.createdAt + SESSION_ABSOLUTE_TTL_SECONDS * 1_000;
}

export function isSessionExpired(session: StoredSession, now: number): boolean {
  return now >= sessionAbsoluteExpiresAt(session) ||
    now >= session.lastSeenAt + SESSION_IDLE_TTL_SECONDS * 1_000;
}

export function sessionCookieLifetime(
  session: StoredSession,
  now: number,
): Readonly<{ expires: Date; maxAge: number }> {
  const expiresAt = sessionAbsoluteExpiresAt(session);
  return Object.freeze({
    expires: new Date(expiresAt),
    maxAge: Math.max(0, Math.floor((expiresAt - now) / 1_000)),
  });
}

export function sessionExpiryCutoffs(now: number): Readonly<{
  absoluteCutoff: number;
  idleCutoff: number;
}> {
  return Object.freeze({
    absoluteCutoff: now - SESSION_ABSOLUTE_TTL_SECONDS * 1_000,
    idleCutoff: now - SESSION_IDLE_TTL_SECONDS * 1_000,
  });
}

export function purgeExpiredSessions(
  store: SessionStore,
  now: number,
  limit = SESSION_PURGE_BATCH_SIZE,
): Promise<readonly ExpiredSession[]> {
  const cutoffs = sessionExpiryCutoffs(now);
  return store.purgeExpired(cutoffs.absoluteCutoff, cutoffs.idleCutoff, limit);
}

export function signSessionId(sessionId: string, sessionSecret: string): string {
  return signValue(sessionId, sessionSecret);
}

export function verifySessionId(
  cookieValue: string,
  sessionSecret: string,
): string | null {
  const sessionId = verifySignedValue(cookieValue, sessionSecret);
  return sessionId && /^[A-Za-z0-9_-]{43}$/u.test(sessionId) ? sessionId : null;
}

const refreshLocks = new Map<string, Promise<unknown>>();

/** Serialises rotating refresh-token operations per opaque session id. */
export async function withSessionRefreshLock<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = refreshLocks.get(sessionId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  refreshLocks.set(sessionId, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (refreshLocks.get(sessionId) === queued) {
      refreshLocks.delete(sessionId);
    }
  }
}
