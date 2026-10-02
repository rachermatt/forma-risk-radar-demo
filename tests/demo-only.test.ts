import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy, config } from "../src/proxy";
import { GET as readiness } from "../src/app/api/readiness/route";

test("APS authentication paths are unavailable even if live mode is configured", async () => {
  const previousMode = process.env.DATA_MODE;
  process.env.DATA_MODE = "autodesk";
  try {
    for (const path of ["/api/aps", "/api/aps/login", "/api/aps/callback", "/api/aps/logout", "/api/%61ps/login", "/api/aps%2flogin", "/api%2faps%2flogin"]) {
      for (const headers of [new Headers(), new Headers({ purpose: "prefetch", "next-router-prefetch": "1" })]) {
        const response = proxy(new NextRequest(`http://localhost:8080${path}`, { headers }));
        assert.equal(response.status, 404);
        assert.equal(response.headers.get("location"), null);
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("x-frame-options"), "DENY");
        assert.match((await response.json()).error, /disabled/);
      }
    }
    assert.ok(config.matcher.includes("/api/:path*"));
  } finally {
    if (previousMode === undefined) delete process.env.DATA_MODE;
    else process.env.DATA_MODE = previousMode;
  }
});

test("the synthetic dashboard remains publicly accessible with CSP protection", () => {
  const response = proxy(new NextRequest("http://localhost:8080/"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-/);
});

test("readiness requires neither an Autodesk session nor a database", async () => {
  const response = await readiness();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ready",
    check: "readiness",
    mode: "demo",
    database: "not-required",
    liveData: "synthetic-demo",
  });
});
