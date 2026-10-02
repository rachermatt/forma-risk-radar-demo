import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { NextRequest } from "next/server";
import { GET as callback } from "../src/lib/auth/reference-routes/callback";
import { GET as login } from "../src/lib/auth/reference-routes/login";
import { POST as logout } from "../src/lib/auth/reference-routes/logout";
import {
  installAuditSink,
  type AuditEvent,
} from "../src/lib/audit";
import {
  createOAuthTransaction,
  createStoredSession,
  installSessionStore,
  OAUTH_TRANSACTION_COOKIE,
  sealOAuthTransaction,
  SESSION_COOKIE,
  signSessionId,
  type ApsTokenSet,
  type SessionStore,
  type StoredSession,
} from "../src/lib/auth/index";

const ENVIRONMENT_KEYS = [
  "DATA_MODE",
  "APS_CLIENT_ID",
  "APS_CLIENT_SECRET",
  "APS_CALLBACK_URL",
  "ACC_ACCOUNT_ID",
  "APS_SCOPES",
  "SESSION_SECRET",
  "APS_SESSION_STORE",
] as const;
const originalEnvironment = new Map<string, string | undefined>();
const SECRET = "route-test-session-secret-with-at-least-32-bytes";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000000";
let auditEvents: AuditEvent[] = [];
let uninstallAuditSink: (() => void) | null = null;

interface RouteMemoryStore extends SessionStore {
  readonly rows: Map<string, StoredSession>;
  readonly deleted: string[];
}

function routeMemoryStore(initial: readonly StoredSession[] = []): RouteMemoryStore {
  const rows = new Map(initial.map((session) => [session.id, session]));
  const deleted: string[] = [];
  return {
    rows,
    deleted,
    async create(session) { rows.set(session.id, session); },
    async read(id) { return rows.get(id) ?? null; },
    async replaceTokens(id, expectedUpdatedAt, encryptedTokens, updatedAt, lastSeenAt) {
      const current = rows.get(id);
      if (!current || current.updatedAt !== expectedUpdatedAt) return false;
      rows.set(id, Object.freeze({
        ...current,
        encryptedTokens,
        updatedAt,
        lastSeenAt: Math.max(current.lastSeenAt, lastSeenAt),
      }));
      return true;
    },
    async touch(id, expectedLastSeenAt, lastSeenAt) {
      const current = rows.get(id);
      if (!current || current.lastSeenAt !== expectedLastSeenAt) return false;
      rows.set(id, Object.freeze({ ...current, lastSeenAt }));
      return true;
    },
    async deleteIfUnchanged(id, expectedUpdatedAt) {
      const current = rows.get(id);
      if (!current || current.updatedAt !== expectedUpdatedAt) return false;
      rows.delete(id);
      deleted.push(id);
      return true;
    },
    async delete(id) { rows.delete(id); deleted.push(id); },
    async purgeExpired() { return []; },
    async withRefreshLock(_id, operation) { return operation(); },
  };
}

function routeTokens(now: number): ApsTokenSet {
  return {
    accessToken: "prior-access",
    refreshToken: "prior-refresh",
    tokenType: "Bearer",
    scopes: ["scope:one", "scope:two"],
    issuedAt: now,
    expiresAt: now + 3_600_000,
  };
}

beforeEach(() => {
  for (const key of ENVIRONMENT_KEYS) {
    originalEnvironment.set(key, process.env[key]);
  }
  Object.assign(process.env, {
    DATA_MODE: "autodesk",
    APS_CLIENT_ID: "route-client-id",
    APS_CLIENT_SECRET: "route-client-secret",
    APS_CALLBACK_URL: "http://localhost:8080/api/aps/callback",
    ACC_ACCOUNT_ID: ACCOUNT_ID,
    APS_SCOPES: "scope:one scope:two",
    SESSION_SECRET: SECRET,
  });
  delete process.env.APS_SESSION_STORE;
  auditEvents = [];
  uninstallAuditSink = installAuditSink(async (event) => {
    auditEvents.push(event);
    return "route-audit-id";
  });
});

afterEach(() => {
  uninstallAuditSink?.();
  uninstallAuditSink = null;
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnvironment.clear();
});

test("login redirects to APS and sets a ten-minute secure signed transaction cookie", () => {
  const response = login(
    new NextRequest("http://localhost:8080/api/aps/login?returnTo=%2Fattention"),
  );
  const location = new URL(response.headers.get("location") ?? "");
  const setCookie = response.headers.get("set-cookie") ?? "";

  assert.equal(response.status, 302);
  assert.equal(location.origin, "https://developer.api.autodesk.com");
  assert.equal(location.searchParams.get("scope"), "scope:one scope:two");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.match(setCookie, new RegExp(`${OAUTH_TRANSACTION_COOKIE}=`));
  assert.match(setCookie, /Max-Age=600/iu);
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /Secure/iu);
  assert.match(setCookie, /SameSite=lax/iu);
  assert.match(setCookie, /Path=\//iu);
  assert.equal(setCookie.includes("route-client-secret"), false);
});

test("callback rejects bad state and always deletes the transient cookie", async () => {
  const created = createOAuthTransaction("/", Date.now());
  const cookie = sealOAuthTransaction(created.transaction, SECRET);
  const request = new NextRequest(
    "http://localhost:8080/api/aps/callback?code=unused&state=wrong",
    { headers: { cookie: `${OAUTH_TRANSACTION_COOKIE}=${cookie}` } },
  );

  const response = await callback(request);
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Autodesk authentication failed.");
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/iu);
  assert.deepEqual(auditEvents.map(({ action, outcome }) => ({ action, outcome })), [{
    action: "authentication.session-established",
    outcome: "denied",
  }]);
});

test("callback fails closed before token exchange when no SessionStore is wired", async () => {
  const created = createOAuthTransaction("/attention", Date.now());
  const cookie = sealOAuthTransaction(created.transaction, SECRET);
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("network must not be called");
  };

  try {
    const request = new NextRequest(
      `http://localhost:8080/api/aps/callback?code=unused&state=${created.transaction.state}`,
      { headers: { cookie: `${OAUTH_TRANSACTION_COOKIE}=${cookie}` } },
    );
    const response = await callback(request);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "Autodesk authentication is unavailable.");
    assert.equal(fetchCalled, false);
    assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/iu);
    assert.equal(auditEvents.some((event) =>
      event.action === "authentication.session-established" &&
      event.outcome === "failed"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a custom SessionStore without a durable audit sink fails closed", async () => {
  const created = createOAuthTransaction("/", Date.now());
  const transactionCookie = sealOAuthTransaction(created.transaction, SECRET);
  const store = routeMemoryStore();
  const uninstallStore = installSessionStore(store);
  uninstallAuditSink?.();
  uninstallAuditSink = null;
  const auditFailures: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => { auditFailures.push(values); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "Bearer",
    expires_in: 3_600,
    scope: "scope:one scope:two",
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const response = await callback(new NextRequest(
      `http://localhost:8080/api/aps/callback?code=one-time-code&state=${created.transaction.state}`,
      { headers: { cookie: `${OAUTH_TRANSACTION_COOKIE}=${transactionCookie}` } },
    ));
    assert.equal(response.status, 502);
    assert.equal(await response.text(), "Autodesk authentication failed.");
    assert.equal(store.rows.size, 0);
    assert.equal(store.deleted.length, 1);
    assert.equal(auditFailures.length > 0, true);
    assert.equal(JSON.stringify(auditFailures).includes("access-token"), false);
    assert.equal(JSON.stringify(auditFailures).includes("refresh-token"), false);
  } finally {
    console.error = originalConsoleError;
    globalThis.fetch = originalFetch;
    uninstallStore();
  }
});

test("callback stores encrypted tokens server-side and redirects only to the configured origin", async () => {
  const created = createOAuthTransaction("/attention?domain=rfi", Date.now());
  const cookie = sealOAuthTransaction(created.transaction, SECRET);
  const storedSessions: StoredSession[] = [];
  const store: SessionStore = {
    async create(session) { storedSessions.push(session); },
    async read() { return storedSessions[0] ?? null; },
    async replaceTokens() { return false; },
    async touch() { return false; },
    async deleteIfUnchanged() { return false; },
    async delete() { storedSessions.length = 0; },
    async purgeExpired() { return []; },
    async withRefreshLock(_id, operation) { return operation(); },
  };
  const uninstall = installSessionStore(store);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: "access-token-that-must-stay-server-side",
    refresh_token: "refresh-token-that-must-stay-server-side",
    token_type: "Bearer",
    expires_in: 3_600,
    scope: "scope:two scope:one",
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const request = new NextRequest(
      `http://untrusted-host.invalid/api/aps/callback?code=one-time-code&state=${created.transaction.state}`,
      { headers: { cookie: `${OAUTH_TRANSACTION_COOKIE}=${cookie}` } },
    );
    const response = await callback(request);
    const setCookie = response.headers.get("set-cookie") ?? "";

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "http://localhost:8080/attention?domain=rfi",
    );
    const stored = storedSessions[0];
    assert.ok(stored);
    assert.equal(stored.encryptedTokens.includes("access-token"), false);
    assert.equal(stored.encryptedTokens.includes("refresh-token"), false);
    assert.match(setCookie, new RegExp(`${SESSION_COOKIE}=`));
    assert.match(setCookie, /Max-Age=604800/iu);
    assert.match(setCookie, /Expires=/iu);
    assert.equal(setCookie.includes("access-token"), false);
    assert.equal(setCookie.includes("refresh-token"), false);
    assert.equal(auditEvents.some((event) =>
      event.action === "authentication.session-established" &&
      event.outcome === "succeeded" && event.sessionId === stored.id), true);
  } finally {
    globalThis.fetch = originalFetch;
    uninstall();
  }
});

test("successful re-login establishes the replacement before revoking the prior session", async () => {
  const now = Date.now();
  const prior = createStoredSession(routeTokens(now - 1_000), ACCOUNT_ID, SECRET, now - 1_000);
  const store = routeMemoryStore([prior]);
  const uninstallStore = installSessionStore(store);
  const created = createOAuthTransaction("/", now);
  const transactionCookie = sealOAuthTransaction(created.transaction, SECRET);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: "new-access-token",
    refresh_token: "new-refresh-token",
    token_type: "Bearer",
    expires_in: 3_600,
    scope: "scope:one scope:two",
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const response = await callback(new NextRequest(
      `http://localhost:8080/api/aps/callback?code=one-time-code&state=${created.transaction.state}`,
      { headers: { cookie: [
        `${OAUTH_TRANSACTION_COOKIE}=${transactionCookie}`,
        `${SESSION_COOKIE}=${signSessionId(prior.id, SECRET)}`,
      ].join("; ") } },
    ));
    assert.equal(response.status, 302);
    assert.equal(store.rows.has(prior.id), false);
    assert.equal(store.rows.size, 1);
    const actions = auditEvents.map((event) => `${event.action}:${event.outcome}`);
    assert.deepEqual(actions, [
      "authentication.session-established:succeeded",
      "authentication.session-invalidated:succeeded",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    uninstallStore();
  }
});

test("re-login fails closed when prior-session revocation cannot be audited", async () => {
  const now = Date.now();
  const prior = createStoredSession(routeTokens(now - 1_000), ACCOUNT_ID, SECRET, now - 1_000);
  const store = routeMemoryStore([prior]);
  const uninstallStore = installSessionStore(store);
  const created = createOAuthTransaction("/", now);
  const transactionCookie = sealOAuthTransaction(created.transaction, SECRET);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: "new-access-token",
    refresh_token: "new-refresh-token",
    token_type: "Bearer",
    expires_in: 3_600,
    scope: "scope:one scope:two",
  }), { status: 200, headers: { "content-type": "application/json" } });
  uninstallAuditSink?.();
  let auditCalls = 0;
  uninstallAuditSink = installAuditSink(async (event) => {
    auditCalls += 1;
    if (auditCalls > 1) throw new Error("audit unavailable");
    auditEvents.push(event);
    return "route-audit-id";
  });

  try {
    const response = await callback(new NextRequest(
      `http://localhost:8080/api/aps/callback?code=one-time-code&state=${created.transaction.state}`,
      { headers: { cookie: [
        `${OAUTH_TRANSACTION_COOKIE}=${transactionCookie}`,
        `${SESSION_COOKIE}=${signSessionId(prior.id, SECRET)}`,
      ].join("; ") } },
    ));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("set-cookie")?.includes(`${SESSION_COOKIE}=`) ?? false, false);
    assert.equal(store.rows.has(prior.id), false);
    assert.equal(store.rows.size, 0, "the replacement session must be deleted before failure is returned");
    assert.deepEqual(auditEvents.map((event) => `${event.action}:${event.outcome}`), [
      "authentication.session-established:succeeded",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    uninstallStore();
  }
});

test("logout requires a same-origin request and revokes the server session", async () => {
  const sessionId = "6hxYAv11hxhDsUEYtVw0D8e3dDjF39gzexdKGpgAwTQ";
  const deleted: string[] = [];
  const store: SessionStore = {
    async create() {},
    async read() { return null; },
    async replaceTokens() { return false; },
    async touch() { return false; },
    async deleteIfUnchanged() { return false; },
    async delete(id) { deleted.push(id); },
    async purgeExpired() { return []; },
    async withRefreshLock(_id, operation) { return operation(); },
  };
  const uninstall = installSessionStore(store);
  const cookie = `${SESSION_COOKIE}=${signSessionId(sessionId, SECRET)}`;
  try {
    const rejected = await logout(new NextRequest(
      "http://localhost:8080/api/aps/logout",
      { method: "POST", headers: { cookie } },
    ));
    assert.equal(rejected.status, 403);
    assert.deepEqual(deleted, []);

    const response = await logout(new NextRequest(
      "http://localhost:8080/api/aps/logout",
      { method: "POST", headers: { cookie, origin: "http://localhost:8080" } },
    ));
    assert.equal(response.status, 204);
    assert.deepEqual(deleted, [sessionId]);
    assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/iu);
    assert.deepEqual(auditEvents.map(({ action, outcome }) => ({ action, outcome })), [
      { action: "authentication.session-invalidated", outcome: "denied" },
      { action: "authentication.session-invalidated", outcome: "succeeded" },
    ]);
  } finally {
    uninstall();
  }
});

test("logout remains effective but reports an unavailable durable audit sink", async () => {
  const now = Date.now();
  const session = createStoredSession(routeTokens(now), ACCOUNT_ID, SECRET, now);
  const store = routeMemoryStore([session]);
  const uninstallStore = installSessionStore(store);
  uninstallAuditSink?.();
  uninstallAuditSink = null;
  const auditFailures: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => { auditFailures.push(values); };
  try {
    const response = await logout(new NextRequest(
      "http://localhost:8080/api/aps/logout",
      {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${signSessionId(session.id, SECRET)}`,
          origin: "http://localhost:8080",
        },
      },
    ));
    assert.equal(response.status, 503);
    assert.equal(store.rows.has(session.id), false);
    assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/iu);
    assert.equal(auditFailures.length, 1);
    assert.equal(JSON.stringify(auditFailures).includes("prior-refresh"), false);
  } finally {
    console.error = originalConsoleError;
    uninstallStore();
  }
});

test("routes remain inert in demo mode", async () => {
  process.env.DATA_MODE = "demo";
  const loginResponse = login(new NextRequest("http://localhost:8080/api/aps/login"));
  const callbackResponse = await callback(
    new NextRequest("http://localhost:8080/api/aps/callback"),
  );
  assert.equal(loginResponse.status, 503);
  assert.equal(callbackResponse.status, 503);
});
