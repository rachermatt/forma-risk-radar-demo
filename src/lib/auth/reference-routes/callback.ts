// Preserved as tested reference code, not registered as a demo HTTP route.
import { NextRequest, NextResponse } from "next/server";
import {
  appendDatabaseAuditEvent,
  requestCorrelationId,
  type AuditOutcome,
} from "@/lib/audit";
import {
  createStoredSession,
  exchangeAuthorizationCode,
  getSessionStore,
  isSessionExpired,
  isAutodeskMode,
  loadApsAuthConfig,
  oauthStateMatches,
  openOAuthTransaction,
  OAUTH_TRANSACTION_COOKIE,
  SECURE_COOKIE_ATTRIBUTES,
  SESSION_COOKIE,
  sessionCookieLifetime,
  signSessionId,
  verifySessionId,
  type ApsAuthConfig,
  type SessionStore,
} from "@/lib/auth";

export const runtime = "nodejs";

const FAILURE_MESSAGE = "Autodesk authentication failed.";
const UNAVAILABLE_MESSAGE = "Autodesk authentication is unavailable.";

function clearTransientCookie(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.cookies.set(OAUTH_TRANSACTION_COOKIE, "", {
    ...SECURE_COOKIE_ATTRIBUTES,
    expires: new Date(0),
    maxAge: 0,
  });
  return response;
}

function failure(status: number, unavailable = false): NextResponse {
  return clearTransientCookie(
    new NextResponse(unavailable ? UNAVAILABLE_MESSAGE : FAILURE_MESSAGE, {
      status,
    }),
  );
}

async function auditAuthentication(
  correlationId: string,
  action: "authentication.session-established" | "authentication.session-invalidated" | "authentication.session-expired",
  outcome: AuditOutcome,
  config: ApsAuthConfig | null,
  sessionId: string | null = null,
  scopeAccountId: string | null = config?.accountId ?? null,
): Promise<boolean> {
  try {
    await appendDatabaseAuditEvent({
      actorId: "system",
      sessionId,
      action,
      scopeType: scopeAccountId ? "hub" : "system",
      scopeId: scopeAccountId,
      outcome,
      correlationId,
    });
    return true;
  } catch {
    console.error("Authentication audit write failed.", {
      correlationId,
      action,
      outcome,
    });
    return false;
  }
}

async function revokePreviousSession(
  request: NextRequest,
  store: SessionStore,
  config: ApsAuthConfig,
  newSessionId: string,
  now: number,
  correlationId: string,
): Promise<void> {
  const priorCookie = request.cookies.get(SESSION_COOKIE)?.value;
  const priorSessionId = priorCookie
    ? verifySessionId(priorCookie, config.sessionSecret)
    : null;
  if (!priorSessionId || priorSessionId === newSessionId) return;

  let action: "authentication.session-invalidated" | "authentication.session-expired" =
    "authentication.session-invalidated";
  let outcome: AuditOutcome = "failed";
  let scopeAccountId = config.accountId;
  try {
    await store.withRefreshLock(priorSessionId, async () => {
      const prior = await store.read(priorSessionId);
      if (!prior) {
        outcome = "denied";
        return;
      }
      scopeAccountId = prior.accountId;
      action = isSessionExpired(prior, now)
        ? "authentication.session-expired"
        : "authentication.session-invalidated";
      outcome = await store.deleteIfUnchanged(priorSessionId, prior.updatedAt)
        ? "succeeded"
        : "failed";
    });
  } catch {
    outcome = "failed";
  }
  const audited = await auditAuthentication(
    correlationId,
    action,
    outcome,
    config,
    priorSessionId,
    scopeAccountId,
  );
  if (!audited || outcome === "failed") {
    throw new Error("Previous-session revocation could not be durably audited.");
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = requestCorrelationId(request.headers.get("x-correlation-id"));
  if (!isAutodeskMode()) {
    return failure(503, true);
  }

  let config;
  try {
    config = loadApsAuthConfig();
  } catch {
    await auditAuthentication(
      correlationId,
      "authentication.session-established",
      "failed",
      null,
    );
    return failure(503, true);
  }

  const cookieValue = request.cookies.get(OAUTH_TRANSACTION_COOKIE)?.value;
  const transaction = cookieValue
    ? openOAuthTransaction(cookieValue, config.sessionSecret)
    : null;
  const receivedState = request.nextUrl.searchParams.get("state");

  // Validate state before processing either a success or an APS error. The
  // transient cookie is cleared on every return path, making callbacks single-use.
  if (!transaction || !oauthStateMatches(transaction.state, receivedState)) {
    const audited = await auditAuthentication(
      correlationId,
      "authentication.session-established",
      "denied",
      config,
    );
    return audited ? failure(400) : failure(503, true);
  }

  if (request.nextUrl.searchParams.has("error")) {
    const audited = await auditAuthentication(
      correlationId,
      "authentication.session-established",
      "denied",
      config,
    );
    return audited ? failure(400) : failure(503, true);
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code || code.length > 4_096) {
    const audited = await auditAuthentication(
      correlationId,
      "authentication.session-established",
      "denied",
      config,
    );
    return audited ? failure(400) : failure(503, true);
  }

  // Fail before exchanging the one-time authorization code unless a durable,
  // revocable server-side store has been explicitly wired by the composition root.
  let sessionStore = getSessionStore();
  if (!sessionStore && process.env.APS_SESSION_STORE === "database") {
    const { createDatabaseSessionStore } = await import(
      "@/lib/auth/database-session-store"
    );
    sessionStore = createDatabaseSessionStore();
  }
  if (!sessionStore) {
    await auditAuthentication(correlationId, "authentication.session-established", "failed", config);
    return failure(503, true);
  }

  let createdSessionId: string | null = null;
  try {
    const tokens = await exchangeAuthorizationCode(
      config,
      code,
      transaction.codeVerifier,
    );
    const sessionCreatedAt = Date.now();
    const session = createStoredSession(
      tokens,
      config.accountId,
      config.sessionSecret,
      sessionCreatedAt,
    );
    await sessionStore.create(session);
    createdSessionId = session.id;
    const establishedAudited = await auditAuthentication(
      correlationId,
      "authentication.session-established",
      "succeeded",
      config,
      session.id,
    );
    if (!establishedAudited) throw new Error("Authentication audit is unavailable.");
    await revokePreviousSession(
      request,
      sessionStore,
      config,
      session.id,
      sessionCreatedAt,
      correlationId,
    );

    const redirectTarget = new URL(transaction.returnTo, config.callbackUrl);
    const response = clearTransientCookie(
      NextResponse.redirect(redirectTarget, 302),
    );
    response.cookies.set(
      SESSION_COOKIE,
      signSessionId(session.id, config.sessionSecret),
      {
        ...SECURE_COOKIE_ATTRIBUTES,
        ...sessionCookieLifetime(session, sessionCreatedAt),
      },
    );
    return response;
  } catch {
    if (createdSessionId) {
      let invalidated = false;
      try {
        await sessionStore.delete(createdSessionId);
        invalidated = true;
      } catch {
        invalidated = false;
      }
      await auditAuthentication(
        correlationId,
        "authentication.session-invalidated",
        invalidated ? "succeeded" : "failed",
        config,
        createdSessionId,
      );
    }
    await auditAuthentication(correlationId, "authentication.session-established", "failed", config);
    return failure(502);
  }
}
