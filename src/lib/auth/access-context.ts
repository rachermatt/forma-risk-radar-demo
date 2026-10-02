import type { ApsAuthConfig } from "@/lib/auth/config";
import {
  appendDatabaseAuditEvent,
  requestCorrelationId,
  type AuditEvent,
  type AuditSink,
} from "@/lib/audit";
import {
  decryptTokenEnvelope,
  encryptTokenEnvelope,
  isSessionExpired,
  type SessionStore,
  type StoredSession,
  verifySessionId,
  withSessionRefreshLock,
} from "@/lib/auth/session";
import {
  OAuthTokenError,
  refreshApsTokens,
  scopesExactlyMatch,
  type ApsTokenSet,
} from "@/lib/auth/token";

export const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1_000;

export interface SessionAccessContext {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

export interface ResolveSessionAccessOptions {
  readonly signedSessionId: string | null | undefined;
  readonly config: ApsAuthConfig;
  readonly store: SessionStore;
  readonly forceRefresh?: boolean;
  readonly now?: () => number;
  readonly correlationId?: string;
  readonly audit?: AuditSink;
  readonly refresh?: (
    config: ApsAuthConfig,
    refreshToken: string,
    now: number,
  ) => Promise<ApsTokenSet>;
}

export class SessionAuthenticationError extends Error {
  constructor() {
    super("Autodesk session is unavailable.");
    this.name = "SessionAuthenticationError";
  }
}

function readEnvelope(
  session: StoredSession | null,
  sessionId: string,
  config: ApsAuthConfig,
): ApsTokenSet | null {
  if (!session || session.accountId !== config.accountId) return null;
  const tokens = decryptTokenEnvelope(
    session.encryptedTokens,
    sessionId,
    session.accountId,
    config.sessionSecret,
  );
  return tokens && scopesExactlyMatch(config.scopes, tokens.scopes.join(" "))
    ? tokens
    : null;
}

function accessContext(
  sessionId: string,
  tokens: ApsTokenSet,
): SessionAccessContext {
  return Object.freeze({
    sessionId,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  });
}

type LockedSessionResolution =
  | Readonly<{
      status: "resolved";
      context: SessionAccessContext;
      auditEvents: readonly AuditEvent[];
    }>
  | Readonly<{
      status: "rejected";
      auditEvents: readonly AuditEvent[];
    }>;

function resolvedSession(
  context: SessionAccessContext,
  auditEvents: readonly AuditEvent[],
): LockedSessionResolution {
  return Object.freeze({ status: "resolved", context, auditEvents: Object.freeze([...auditEvents]) });
}

function rejectedSession(
  auditEvents: readonly AuditEvent[],
): LockedSessionResolution {
  return Object.freeze({ status: "rejected", auditEvents: Object.freeze([...auditEvents]) });
}

function invalidatesSession(error: unknown): boolean {
  if (!(error instanceof OAuthTokenError)) return false;
  if (error.code === "invalid_token_response" || error.code === "scope_mismatch") return true;
  return error.status !== null && error.status >= 400 && error.status < 500 &&
    error.status !== 408 && error.status !== 429;
}

function authAuditEvent(
  sessionId: string | null,
  accountId: string,
  action: "authentication.session-refreshed" | "authentication.session-invalidated" | "authentication.session-expired",
  outcome: "succeeded" | "failed",
  correlationId: string,
): AuditEvent {
  return {
    actorId: "system",
    sessionId,
    action,
    scopeType: "hub",
    scopeId: accountId,
    outcome,
    correlationId,
  };
}

async function emitAuditEvents(
  sink: AuditSink,
  events: readonly AuditEvent[],
): Promise<void> {
  for (const event of events) {
    await sink(event);
  }
}

async function touchSession(
  store: SessionStore,
  session: StoredSession,
  now: number,
): Promise<boolean> {
  const lastSeenAt = Math.max(now, session.lastSeenAt + 1);
  return store.touch(session.id, session.lastSeenAt, lastSeenAt);
}

/**
 * Resolves a browser's opaque cookie to a server token, refreshing five minutes
 * early and rotating both APS tokens with optimistic concurrency.
 */
export async function resolveSessionAccess(
  options: ResolveSessionAccessOptions,
): Promise<SessionAccessContext> {
  const sessionId = options.signedSessionId
    ? verifySessionId(options.signedSessionId, options.config.sessionSecret)
    : null;
  if (!sessionId) throw new SessionAuthenticationError();

  const now = options.now ?? Date.now;
  const correlationId = options.correlationId ?? requestCorrelationId(null);
  const audit = options.audit ?? appendDatabaseAuditEvent;
  const auditEvents: AuditEvent[] = [];
  let resolved: SessionAccessContext | null = null;
  let operationFailed = false;

  try {
    const observedSession = await options.store.read(sessionId);
    const resolution = await withSessionRefreshLock(
      sessionId,
      () => options.store.withRefreshLock(sessionId, async () => {
        // A durable store runs this callback in a transaction. Authentication
        // rejection is therefore returned as data so an invalidation DELETE can
        // commit before the public authentication error is thrown below.
        const lockedAuditEvents: AuditEvent[] = [];
        const currentSession = await options.store.read(sessionId);
        const currentTokens = readEnvelope(currentSession, sessionId, options.config);
        if (!currentSession || !currentTokens) {
          if (currentSession) {
            const deleted = await options.store.deleteIfUnchanged(
              sessionId,
              currentSession.updatedAt,
            );
            lockedAuditEvents.push(authAuditEvent(
              sessionId,
              currentSession.accountId,
              "authentication.session-invalidated",
              deleted ? "succeeded" : "failed",
              correlationId,
            ));
          }
          return rejectedSession(lockedAuditEvents);
        }

        const accessAt = now();
        if (isSessionExpired(currentSession, accessAt)) {
          const deleted = await options.store.deleteIfUnchanged(
            sessionId,
            currentSession.updatedAt,
          );
          lockedAuditEvents.push(authAuditEvent(
            sessionId,
            currentSession.accountId,
            "authentication.session-expired",
            deleted ? "succeeded" : "failed",
            correlationId,
          ));
          return rejectedSession(lockedAuditEvents);
        }

        const anotherRequestRefreshed = Boolean(
          observedSession && currentSession.updatedAt !== observedSession.updatedAt,
        );
        if (
          (!options.forceRefresh && currentTokens.expiresAt > accessAt + TOKEN_REFRESH_LEEWAY_MS) ||
          (options.forceRefresh && anotherRequestRefreshed && currentTokens.expiresAt > accessAt)
        ) {
          if (!await touchSession(options.store, currentSession, accessAt)) {
            return rejectedSession(lockedAuditEvents);
          }
          return resolvedSession(accessContext(sessionId, currentTokens), lockedAuditEvents);
        }

        let refreshed: ApsTokenSet;
        try {
          refreshed = options.refresh
            ? await options.refresh(
                options.config,
                currentTokens.refreshToken,
                accessAt,
              )
            : await refreshApsTokens(
                options.config,
                currentTokens.refreshToken,
                fetch,
                accessAt,
              );
        } catch (error) {
          // If another replica completed rotation while this request was in
          // flight, prefer its winner instead of revoking the new session.
          const winner = await options.store.read(sessionId);
          const winnerTokens = readEnvelope(winner, sessionId, options.config);
          const winnerAt = now();
          if (
            winner && winner.updatedAt !== currentSession.updatedAt &&
            winnerTokens && !isSessionExpired(winner, winnerAt) &&
            winnerTokens.expiresAt > winnerAt &&
            await touchSession(options.store, winner, winnerAt)
          ) {
            lockedAuditEvents.push(authAuditEvent(
              sessionId,
              winner.accountId,
              "authentication.session-refreshed",
              "succeeded",
              correlationId,
            ));
            return resolvedSession(accessContext(sessionId, winnerTokens), lockedAuditEvents);
          }

          lockedAuditEvents.push(authAuditEvent(
            sessionId,
            currentSession.accountId,
            "authentication.session-refreshed",
            "failed",
            correlationId,
          ));
          // Network failures, timeouts, 429s and APS 5xx responses are transient;
          // preserve the encrypted refresh token so a later request can retry.
          if (invalidatesSession(error)) {
            const deleted = await options.store.deleteIfUnchanged(
              sessionId,
              currentSession.updatedAt,
            );
            lockedAuditEvents.push(authAuditEvent(
              sessionId,
              currentSession.accountId,
              "authentication.session-invalidated",
              deleted ? "succeeded" : "failed",
              correlationId,
            ));
          }
          return rejectedSession(lockedAuditEvents);
        }

        const completedAt = now();
        if (isSessionExpired(currentSession, completedAt)) {
          const deleted = await options.store.deleteIfUnchanged(
            sessionId,
            currentSession.updatedAt,
          );
          lockedAuditEvents.push(authAuditEvent(
            sessionId,
            currentSession.accountId,
            "authentication.session-expired",
            deleted ? "succeeded" : "failed",
            correlationId,
          ));
          return rejectedSession(lockedAuditEvents);
        }

        const updatedAt = Math.max(completedAt, currentSession.updatedAt + 1);
        const lastSeenAt = Math.max(completedAt, currentSession.lastSeenAt + 1);
        const encrypted = encryptTokenEnvelope(
          refreshed,
          sessionId,
          currentSession.accountId,
          options.config.sessionSecret,
        );
        const replaced = await options.store.replaceTokens(
          sessionId,
          currentSession.updatedAt,
          encrypted,
          updatedAt,
          lastSeenAt,
        );
        if (replaced) {
          lockedAuditEvents.push(authAuditEvent(
            sessionId,
            currentSession.accountId,
            "authentication.session-refreshed",
            "succeeded",
            correlationId,
          ));
          return resolvedSession(accessContext(sessionId, refreshed), lockedAuditEvents);
        }

        // A concurrent process may have won the rotation. Use only its valid,
        // already-rotated token; never retry the stale refresh token.
        const winner = await options.store.read(sessionId);
        const winnerTokens = readEnvelope(winner, sessionId, options.config);
        const winnerAt = now();
        if (
          winner && winnerTokens && !isSessionExpired(winner, winnerAt) &&
          winnerTokens.expiresAt > winnerAt &&
          await touchSession(options.store, winner, winnerAt)
        ) {
          lockedAuditEvents.push(authAuditEvent(
            sessionId,
            winner.accountId,
            "authentication.session-refreshed",
            "succeeded",
            correlationId,
          ));
          return resolvedSession(accessContext(sessionId, winnerTokens), lockedAuditEvents);
        }
        lockedAuditEvents.push(authAuditEvent(
          sessionId,
          currentSession.accountId,
          "authentication.session-refreshed",
          "failed",
          correlationId,
        ));
        return rejectedSession(lockedAuditEvents);
      }),
    );
    auditEvents.push(...resolution.auditEvents);
    if (resolution.status === "resolved") resolved = resolution.context;
    else operationFailed = true;
  } catch {
    operationFailed = true;
  }

  try {
    await emitAuditEvents(audit, auditEvents);
  } catch {
    console.error("Authentication audit write failed.", { correlationId });
    throw new SessionAuthenticationError();
  }
  if (operationFailed || !resolved) throw new SessionAuthenticationError();
  return resolved;
}
