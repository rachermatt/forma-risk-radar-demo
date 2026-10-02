// Preserved as tested reference code, not registered as a demo HTTP route.
import { NextRequest, NextResponse } from "next/server";
import {
  appendDatabaseAuditEvent,
  requestCorrelationId,
  type AuditOutcome,
} from "@/lib/audit";
import {
  getSessionStore,
  isAutodeskMode,
  loadApsAuthConfig,
  OAUTH_TRANSACTION_COOKIE,
  SECURE_COOKIE_ATTRIBUTES,
  SESSION_COOKIE,
  verifySessionId,
  type ApsAuthConfig,
} from "@/lib/auth";

export const runtime = "nodejs";

function clearedResponse(status = 204): NextResponse {
  const response = new NextResponse(null, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
  for (const name of [SESSION_COOKIE, OAUTH_TRANSACTION_COOKIE]) {
    response.cookies.set(name, "", {
      ...SECURE_COOKIE_ATTRIBUTES,
      expires: new Date(0),
      maxAge: 0,
    });
  }
  return response;
}

async function auditLogout(
  correlationId: string,
  outcome: AuditOutcome,
  config: ApsAuthConfig | null,
  sessionId: string | null,
  scopeAccountId: string | null = config?.accountId ?? null,
): Promise<boolean> {
  try {
    await appendDatabaseAuditEvent({
      actorId: "system",
      sessionId,
      action: "authentication.session-invalidated",
      scopeType: scopeAccountId ? "hub" : "system",
      scopeId: scopeAccountId,
      outcome,
      correlationId,
    });
    return true;
  } catch {
    console.error("Authentication audit write failed.", {
      correlationId,
      action: "authentication.session-invalidated",
      outcome,
    });
    return false;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = requestCorrelationId(request.headers.get("x-correlation-id"));
  if (!isAutodeskMode()) return clearedResponse();

  let config;
  try {
    config = loadApsAuthConfig();
  } catch {
    await auditLogout(correlationId, "failed", null, null);
    return clearedResponse(503);
  }

  const signedId = request.cookies.get(SESSION_COOKIE)?.value;
  const sessionId = signedId
    ? verifySessionId(signedId, config.sessionSecret)
    : null;

  const expectedOrigin = new URL(config.callbackUrl).origin;
  if (request.headers.get("origin") !== expectedOrigin) {
    const audited = await auditLogout(correlationId, "denied", config, sessionId);
    if (!audited) {
      return new NextResponse("Autodesk authentication is unavailable.", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
    return new NextResponse("Forbidden", {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }

  let store = getSessionStore();
  if (!store && process.env.APS_SESSION_STORE === "database") {
    const { createDatabaseSessionStore } = await import(
      "@/lib/auth/database-session-store"
    );
    store = createDatabaseSessionStore();
  }
  if (!store) {
    await auditLogout(correlationId, "failed", config, sessionId);
    return clearedResponse(503);
  }

  if (signedId && !sessionId) {
    if (!await auditLogout(correlationId, "denied", config, null)) {
      return clearedResponse(503);
    }
  }
  if (sessionId) {
    let scopeAccountId = config.accountId;
    try {
      await store.withRefreshLock(sessionId, async () => {
        const session = await store.read(sessionId);
        if (session) scopeAccountId = session.accountId;
        await store.delete(sessionId);
      });
      if (!await auditLogout(
        correlationId,
        "succeeded",
        config,
        sessionId,
        scopeAccountId,
      )) {
        return clearedResponse(503);
      }
    } catch {
      await auditLogout(
        correlationId,
        "failed",
        config,
        sessionId,
        scopeAccountId,
      );
      return clearedResponse(503);
    }
  }
  return clearedResponse();
}
