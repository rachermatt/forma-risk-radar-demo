import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(
    { status: "ok", check: "liveness" },
    { headers: { "cache-control": "no-store" } },
  );
}
