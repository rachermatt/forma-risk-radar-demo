// Preserved as tested reference code, not registered as a demo HTTP route.
import { NextRequest, NextResponse } from "next/server";
import {
  buildApsAuthorizeUrl,
  createOAuthTransaction,
  isAutodeskMode,
  loadApsAuthConfig,
  OAUTH_TRANSACTION_COOKIE,
  OAUTH_TRANSACTION_TTL_SECONDS,
  sealOAuthTransaction,
  SECURE_COOKIE_ATTRIBUTES,
} from "@/lib/auth";

export const runtime = "nodejs";

const UNAVAILABLE_MESSAGE = "Autodesk authentication is unavailable.";

export function GET(request: NextRequest): NextResponse {
  if (!isAutodeskMode()) {
    return new NextResponse(UNAVAILABLE_MESSAGE, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }

  try {
    const config = loadApsAuthConfig();
    const { transaction, codeChallenge } = createOAuthTransaction(
      request.nextUrl.searchParams.get("returnTo"),
    );
    const redirectUrl = buildApsAuthorizeUrl(
      config,
      transaction,
      codeChallenge,
    );
    const response = NextResponse.redirect(redirectUrl, 302);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    response.cookies.set(
      OAUTH_TRANSACTION_COOKIE,
      sealOAuthTransaction(transaction, config.sessionSecret),
      {
        ...SECURE_COOKIE_ATTRIBUTES,
        maxAge: OAUTH_TRANSACTION_TTL_SECONDS,
        expires: new Date(transaction.expiresAt),
      },
    );
    return response;
  } catch {
    return new NextResponse(UNAVAILABLE_MESSAGE, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
