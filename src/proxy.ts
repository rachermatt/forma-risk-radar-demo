import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { securityHeaders } from "@/lib/security-headers";

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(randomUUID(), "utf8").toString("base64");
  const correlationId = randomUUID();
  const production = process.env.NODE_ENV === "production";
  const headers = securityHeaders(nonce, production);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-correlation-id", correlationId);
  requestHeaders.set("content-security-policy", headers["content-security-policy"]!);

  let pathname = request.nextUrl.pathname;
  try {
    // Next resolves app routes after decoding the path once.
    pathname = decodeURIComponent(pathname);
  } catch {
    // Malformed paths cannot resolve to an APS route.
  }
  const isAutodeskRoute = pathname === "/api/aps" || pathname.startsWith("/api/aps/");
  const response = isAutodeskRoute
    ? NextResponse.json(
        { error: "Autodesk authentication is disabled in this demo-only edition." },
        { status: 404, headers: { "cache-control": "no-store" } },
      )
    : NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  response.headers.set("x-correlation-id", correlationId);
  return response;
}

export const config = {
  matcher: [
    // Authentication paths must never bypass this boundary via prefetch headers.
    "/api/:path*",
    {
      source: "/((?!_next/static|_next/image|favicon.ico|og.png).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
