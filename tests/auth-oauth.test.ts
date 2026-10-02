import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthConfigurationError,
  APS_TOKEN_RESPONSE_MAX_BYTES,
  buildApsAuthorizeUrl,
  constantTimeEqual,
  createOAuthTransaction,
  createStoredSession,
  decryptTokenEnvelope,
  encryptTokenEnvelope,
  exchangeAuthorizationCode,
  installSessionStore,
  loadApsAuthConfig,
  oauthStateMatches,
  openOAuthTransaction,
  parseApsTokenResponse,
  refreshApsTokens,
  scopesExactlyMatch,
  sealOAuthTransaction,
  signSessionId,
  validateReturnTo,
  verifySessionId,
  withSessionRefreshLock,
  type ApsAuthConfig,
  type ApsTokenSet,
  type SessionStore,
} from "../src/lib/auth/index";

const SECRET = "a-secure-session-secret-with-at-least-32-bytes";
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

function config(): ApsAuthConfig {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    callbackUrl: "https://risk.example.test/api/aps/callback",
    accountId: "account-id",
    scopes: ["scope:one", "scope:two"],
    sessionSecret: SECRET,
  };
}

function tokenSet(): ApsTokenSet {
  return {
    accessToken: "access-token-only-on-server",
    refreshToken: "refresh-token-only-on-server",
    tokenType: "Bearer",
    scopes: ["scope:one", "scope:two"],
    issuedAt: NOW,
    expiresAt: NOW + 3_600_000,
  };
}

test("creates a 32-byte PKCE verifier and state with an S256 challenge", () => {
  const first = createOAuthTransaction("/projects/p-1", NOW);
  const second = createOAuthTransaction("/projects/p-1", NOW);

  assert.equal(Buffer.from(first.transaction.state, "base64url").length, 32);
  assert.equal(Buffer.from(first.transaction.codeVerifier, "base64url").length, 32);
  assert.equal(first.codeChallenge.length, 43);
  assert.notEqual(first.transaction.state, second.transaction.state);
  assert.notEqual(first.transaction.codeVerifier, second.transaction.codeVerifier);
  assert.equal(first.transaction.expiresAt, NOW + 10 * 60 * 1_000);
});

test("seals, verifies, expires, and rejects tampered OAuth transactions", () => {
  const { transaction } = createOAuthTransaction("/attention?domain=rfi", NOW);
  const sealed = sealOAuthTransaction(transaction, SECRET);
  const replacement = sealed.endsWith("A") ? "B" : "A";
  const tampered = `${sealed.slice(0, -1)}${replacement}`;

  assert.deepEqual(openOAuthTransaction(sealed, SECRET, NOW), transaction);
  assert.equal(openOAuthTransaction(sealed, SECRET, transaction.expiresAt + 1), null);
  assert.notEqual(tampered, sealed);
  assert.equal(openOAuthTransaction(tampered, SECRET, NOW), null);
  assert.equal(openOAuthTransaction(sealed, `${SECRET}-wrong`, NOW), null);
});

test("returnTo accepts only same-origin relative paths", () => {
  assert.equal(validateReturnTo("/projects/p-1?tab=rfi#open"), "/projects/p-1?tab=rfi#open");
  for (const unsafe of [
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example/path",
    "/%5cevil.example/path",
    "/%255cevil.example/path",
    "projects/p-1",
    "/bad%escape",
  ]) {
    assert.equal(validateReturnTo(unsafe), "/", unsafe);
  }
});

test("uses constant-time comparison helper for OAuth state semantics", () => {
  assert.equal(constantTimeEqual("same-state", "same-state"), true);
  assert.equal(constantTimeEqual("same-state", "different-state"), false);
  assert.equal(oauthStateMatches("expected", "expected"), true);
  assert.equal(oauthStateMatches("expected", "wrong"), false);
  assert.equal(oauthStateMatches("expected", null), false);
});

test("loads scopes only from APS_SCOPES and refuses incomplete configuration", () => {
  const loaded = loadApsAuthConfig({
    DATA_MODE: "autodesk",
    APS_CLIENT_ID: "id",
    APS_CLIENT_SECRET: "secret",
    APS_CALLBACK_URL: "https://risk.example.test/api/aps/callback",
    ACC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000000",
    APS_SCOPES: "scope:first scope:second",
    SESSION_SECRET: SECRET,
  });
  assert.deepEqual(loaded.scopes, ["scope:first", "scope:second"]);

  assert.throws(
    () => loadApsAuthConfig({
      APS_CLIENT_ID: "id",
      APS_CLIENT_SECRET: "secret",
      APS_CALLBACK_URL: "https://risk.example.test/api/aps/callback",
      ACC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000000",
      SESSION_SECRET: SECRET,
    }),
    AuthConfigurationError,
  );
  assert.throws(
    () => loadApsAuthConfig({
      APS_CLIENT_ID: "id",
      APS_CLIENT_SECRET: "secret",
      APS_CALLBACK_URL: "https://risk.example.test/api/aps/callback",
      ACC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000000",
      APS_SCOPES: "scope:one",
      SESSION_SECRET: "short",
    }),
    AuthConfigurationError,
  );
});

test("production Autodesk authentication requires shared PostgreSQL persistence", () => {
  const production = {
    NODE_ENV: "production",
    DATA_MODE: "autodesk",
    APS_CLIENT_ID: "id",
    APS_CLIENT_SECRET: "secret",
    APS_CALLBACK_URL: "https://risk.example.test/api/aps/callback",
    ACC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000000",
    APS_SCOPES: "scope:first scope:second",
    SESSION_SECRET: SECRET,
  };
  assert.throws(() => loadApsAuthConfig(production), AuthConfigurationError);
  assert.equal(loadApsAuthConfig({
    ...production,
    DATABASE_URL: "postgres://runtime@database.example.test/risk",
  }).clientId, "id");
});

test("builds an authorization request with PKCE S256 and configured scopes", () => {
  const created = createOAuthTransaction("/", NOW);
  const url = buildApsAuthorizeUrl(config(), created.transaction, created.codeChallenge);

  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "scope:one scope:two");
  assert.equal(url.searchParams.get("state"), created.transaction.state);
  assert.equal(url.searchParams.get("code_challenge"), created.codeChallenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), config().callbackUrl);
});

test("parses expires_in and requires the exact granted scope set", () => {
  const parsed = parseApsTokenResponse({
    access_token: "access",
    refresh_token: "refresh",
    token_type: "bearer",
    expires_in: 3_599,
    scope: "scope:two scope:one",
  }, config().scopes, NOW);

  assert.equal(parsed.issuedAt, NOW);
  assert.equal(parsed.expiresAt, NOW + 3_599_000);
  assert.equal(scopesExactlyMatch(config().scopes, "scope:two scope:one"), true);
  assert.equal(scopesExactlyMatch(config().scopes, "scope:one"), false);
  assert.throws(
    () => parseApsTokenResponse({
      access_token: "access",
      refresh_token: "refresh",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "scope:one",
    }, config().scopes, NOW),
    (error: unknown) => error instanceof Error && error.message === "Autodesk authentication failed.",
  );
});

test("exchanges and refreshes tokens without network in tests", async () => {
  const bodies: string[] = [];
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      token_type: "Bearer",
      expires_in: "1800",
      scope: "scope:one scope:two",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const exchanged = await exchangeAuthorizationCode(
    config(),
    "authorization-code",
    "pkce-verifier",
    fakeFetch,
    NOW,
  );
  const refreshed = await refreshApsTokens(
    config(),
    "old-refresh",
    fakeFetch,
    NOW,
  );

  assert.equal(exchanged.expiresAt, NOW + 1_800_000);
  assert.equal(refreshed.refreshToken, "new-refresh");
  assert.match(bodies[0] ?? "", /grant_type=authorization_code/u);
  assert.match(bodies[0] ?? "", /code_verifier=pkce-verifier/u);
  assert.match(bodies[1] ?? "", /grant_type=refresh_token/u);
  assert.match(bodies[1] ?? "", /refresh_token=old-refresh/u);
});

test("does not read or surface an OAuth error response body", async () => {
  let bodyRead = false;
  const secretBody = "server-body-containing-a-secret-token";
  const failingFetch = async () => ({
    ok: false,
    status: 401,
    json: async () => {
      bodyRead = true;
      return { error_description: secretBody };
    },
  } as Response);

  await assert.rejects(
    exchangeAuthorizationCode(
      config(),
      "authorization-code",
      "pkce-verifier",
      failingFetch,
      NOW,
    ),
    (error: unknown) => {
      assert.equal(bodyRead, false);
      assert.equal(String(error).includes(secretBody), false);
      return error instanceof Error && error.message === "Autodesk authentication failed.";
    },
  );
});

test("route OAuth caps successful response bodies before JSON allocation", async () => {
  await assert.rejects(
    exchangeAuthorizationCode(
      config(),
      "authorization-code",
      "pkce-verifier",
      async () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(APS_TOKEN_RESPONSE_MAX_BYTES + 1),
        },
      }),
      NOW,
    ),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal(String(error), "OAuthTokenError: Autodesk authentication failed.");
      return true;
    },
  );
});

test("encrypts tokens at rest with session/account binding and signs an opaque id", () => {
  const tokens = tokenSet();
  const sessionId = "6hxYAv11hxhDsUEYtVw0D8e3dDjF39gzexdKGpgAwTQ";
  const encrypted = encryptTokenEnvelope(tokens, sessionId, "account-id", SECRET);

  assert.equal(encrypted.includes(tokens.accessToken), false);
  assert.equal(encrypted.includes(tokens.refreshToken), false);
  assert.deepEqual(
    decryptTokenEnvelope(encrypted, sessionId, "account-id", SECRET),
    tokens,
  );
  assert.equal(decryptTokenEnvelope(encrypted, sessionId, "wrong-account", SECRET), null);
  assert.equal(decryptTokenEnvelope(encrypted, sessionId, "account-id", `${SECRET}-wrong`), null);

  const signedId = signSessionId(sessionId, SECRET);
  assert.equal(verifySessionId(signedId, SECRET), sessionId);
  assert.equal(signedId.includes(tokens.accessToken), false);
});

test("requires an explicitly installed session store and serialises refreshes", async () => {
  const rows = new Map<string, ReturnType<typeof createStoredSession>>();
  const store: SessionStore = {
    async create(session) { rows.set(session.id, session); },
    async read(id) { return rows.get(id) ?? null; },
    async replaceTokens() { return false; },
    async touch() { return false; },
    async deleteIfUnchanged() { return false; },
    async delete(id) { rows.delete(id); },
    async purgeExpired() { return []; },
    async withRefreshLock(_id, operation) { return operation(); },
  };
  const uninstall = installSessionStore(store);
  const session = createStoredSession(tokenSet(), "account-id", SECRET, NOW);
  await store.create(session);
  assert.equal((await store.read(session.id))?.accountId, "account-id");
  uninstall();

  const order: number[] = [];
  await Promise.all([
    withSessionRefreshLock("session", async () => {
      order.push(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(2);
    }),
    withSessionRefreshLock("session", async () => {
      order.push(3);
    }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});
