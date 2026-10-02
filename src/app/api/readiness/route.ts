import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      status: "ready",
      check: "readiness",
      mode: "demo",
      database: "not-required",
      liveData: "synthetic-demo",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
