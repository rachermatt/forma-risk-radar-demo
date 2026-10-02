import assert from "node:assert/strict";
import test from "node:test";
import {
  createStoredSession,
  decryptTokenEnvelope,
  OAuthTokenError,
  purgeExpiredSessions,
  resolveSessionAccess,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
  SessionAuthenticationError,
  signSessionId,
  type ApsAuthConfig,
  type ApsTokenSet,
  type ResolveSessionAccessOptions,
  type SessionStore,
  type StoredSession,
} from "../src/lib/auth";
import type { AuditEvent } from "../src/lib/audit";
import { createDatabaseSessionStore } from "../src/lib/auth/database-session-store";
import { runMigrations } from "../src/lib/db/migrations";
import { createPGliteSql } from "../src/lib/db/pglite";

const NOW = Date.UTC(2026, 8, 8, 12);
const SECRET = "session-access-test-secret-with-at-least-32-bytes";
const CORRELATION_ID = "4c27eec2-511f-4c6e-b1e2-8a74273cb832";
const CONFIG: ApsAuthConfig = {
  clientId: "client",
  clientSecret: "server-secret",
  callbackUrl: "https://risk.example.test/api/aps/callback",
  accountId: "00000000-0000-4000-8000-000000000000",
  scopes: ["scope:read"],
  sessionSecret: SECRET,
};

interface MemorySessionStore extends SessionStore {
  row: StoredSession | null;
  purgeCalls: number;
  touchCalls: number;
}

function tokens(expiresAt: number, suffix = "old"): ApsTokenSet {
  return {
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    tokenType: "Bearer",
    scopes: CONFIG.scopes,
    issuedAt: NOW,
    expiresAt,
  };
}

function memoryStore(initial: StoredSession): MemorySessionStore {
  return {
    row: initial,
    purgeCalls: 0,
    touchCalls: 0,
    async create(session) { this.row = session; },
    async read(id) { return this.row?.id === id ? this.row : null; },
    async replaceTokens(id, expectedUpdatedAt, encryptedTokens, updatedAt, lastSeenAt) {
      if (this.row?.id !== id || this.row.updatedAt !== expectedUpdatedAt) return false;
      this.row = Object.freeze({
        ...this.row,
        encryptedTokens,
        updatedAt,
        lastSeenAt: Math.max(this.row.lastSeenAt, lastSeenAt),
      });
      return true;
    },
    async touch(id, expectedLastSeenAt, lastSeenAt) {
      this.touchCalls += 1;
      if (this.row?.id !== id || this.row.lastSeenAt !== expectedLastSeenAt) return false;
      this.row = Object.freeze({
        ...this.row,
        lastSeenAt: Math.max(this.row.lastSeenAt, lastSeenAt),
      });
      return true;
    },
    async deleteIfUnchanged(id, expectedUpdatedAt) {
      if (this.row?.id !== id || this.row.updatedAt !== expectedUpdatedAt) return false;
      this.row = null;
      return true;
    },
    async delete(id) { if (this.row?.id === id) this.row = null; },
    async purgeExpired(absoluteCutoff, idleCutoff, limit) {
      this.purgeCalls += 1;
      if (
        limit > 0 && this.row &&
        (this.row.createdAt <= absoluteCutoff || this.row.lastSeenAt <= idleCutoff)
      ) {
        const expired = [{ id: this.row.id, accountId: this.row.accountId }];
        this.row = null;
        return expired;
      }
      return [];
    },
    async withRefreshLock(_id, operation) { return operation(); },
  };
}

function auditCollector(events: AuditEvent[]) {
  return async (event: AuditEvent): Promise<void> => { events.push(event); };
}

test("session access refreshes early, rotates the envelope, and audits the CAS winner", async () => {
  const session = createStoredSession(tokens(NOW + 60_000), CONFIG.accountId, SECRET, NOW);
  const store = memoryStore(session);
  const events: AuditEvent[] = [];
  let refreshes = 0;
  const resolved = await resolveSessionAccess({
    signedSessionId: signSessionId(session.id, SECRET),
    config: CONFIG,
    store,
    now: () => NOW,
    correlationId: CORRELATION_ID,
    audit: auditCollector(events),
    refresh: async () => {
      refreshes += 1;
      return tokens(NOW + 3_600_000, "new");
    },
  });

  assert.equal(refreshes, 1);
  assert.equal(resolved.accessToken, "access-new");
  assert.ok(store.row && store.row.updatedAt > session.updatedAt);
  assert.equal(store.row?.encryptedTokens.includes("access-new"), false);
  assert.deepEqual(events.map(({ action, outcome }) => ({ action, outcome })), [{
    action: "authentication.session-refreshed",
    outcome: "succeeded",
  }]);
});

test("valid access touches only idle activity and never sweeps unrelated sessions", async () => {
  const session = createStoredSession(tokens(NOW + 3_600_000), CONFIG.accountId, SECRET, NOW);
  const store = memoryStore(session);
  const resolved = await resolveSessionAccess({
    signedSessionId: signSessionId(session.id, SECRET),
    config: CONFIG,
    store,
    now: () => NOW + 1_000,
    audit: async () => undefined,
  });

  assert.equal(resolved.accessToken, "access-old");
  assert.equal(store.row?.updatedAt, session.updatedAt);
  assert.equal(store.row?.lastSeenAt, NOW + 1_000);
  assert.equal(store.touchCalls, 1);
  assert.equal(store.purgeCalls, 0);
});

test("invalid signed sessions fail closed without attempting refresh", async () => {
  const session = createStoredSession(tokens(NOW + 3_600_000), CONFIG.accountId, SECRET, NOW);
  const store = memoryStore(session);
  let refreshes = 0;
  await assert.rejects(
    resolveSessionAccess({
      signedSessionId: "tampered.cookie",
      config: CONFIG,
      store,
      now: () => NOW,
      audit: async () => undefined,
      refresh: async () => {
        refreshes += 1;
        return tokens(NOW + 3_600_000, "new");
      },
    }),
    SessionAuthenticationError,
  );
  assert.equal(refreshes, 0);
});

test("idle and absolute session boundaries delete the requested session without refresh", async (t) => {
  const cases = [
    {
      name: "idle",
      accessAt: NOW + SESSION_IDLE_TTL_SECONDS * 1_000,
      session: createStoredSession(tokens(NOW + 10 * 86_400_000), CONFIG.accountId, SECRET, NOW),
    },
    {
      name: "absolute",
      accessAt: NOW + SESSION_ABSOLUTE_TTL_SECONDS * 1_000,
      session: Object.freeze({
        ...createStoredSession(tokens(NOW + 10 * 86_400_000), CONFIG.accountId, SECRET, NOW),
        lastSeenAt: NOW + 6 * 86_400_000,
      }),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const store = memoryStore(item.session);
      const events: AuditEvent[] = [];
      let refreshes = 0;
      await assert.rejects(resolveSessionAccess({
        signedSessionId: signSessionId(item.session.id, SECRET),
        config: CONFIG,
        store,
        now: () => item.accessAt,
        correlationId: CORRELATION_ID,
        audit: auditCollector(events),
        refresh: async () => {
          refreshes += 1;
          return tokens(item.accessAt + 3_600_000, "new");
        },
      }), SessionAuthenticationError);
      assert.equal(refreshes, 0);
      assert.equal(store.row, null);
      assert.deepEqual(events.map(({ action, outcome }) => ({ action, outcome })), [{
        action: "authentication.session-expired",
        outcome: "succeeded",
      }]);
    });
  }
});

test("the maintenance helper applies the same inclusive idle boundary", async () => {
  const session = createStoredSession(tokens(NOW + 3_600_000), CONFIG.accountId, SECRET, NOW);
  const store = memoryStore(session);
  const expired = await purgeExpiredSessions(
    store,
    NOW + SESSION_IDLE_TTL_SECONDS * 1_000,
    1,
  );
  assert.deepEqual(expired, [{ id: session.id, accountId: CONFIG.accountId }]);
  assert.equal(store.row, null);
  assert.equal(store.purgeCalls, 1);
});

test("transient refresh failures are audited and preserve the revocable session", async () => {
  const session = createStoredSession(tokens(NOW + 60_000), CONFIG.accountId, SECRET, NOW);
  const store = memoryStore(session);
  const events: AuditEvent[] = [];
  await assert.rejects(
    resolveSessionAccess({
      signedSessionId: signSessionId(session.id, SECRET),
      config: CONFIG,
      store,
      now: () => NOW,
      correlationId: CORRELATION_ID,
      audit: auditCollector(events),
      refresh: async () => { throw new OAuthTokenError("token_exchange_failed", 503); },
    }),
    SessionAuthenticationError,
  );
  assert.equal(store.row?.id, session.id);
  assert.deepEqual(events.map(({ action, outcome }) => ({ action, outcome })), [{
    action: "authentication.session-refreshed",
    outcome: "failed",
  }]);
});

test("terminal refresh rejection audits failure then invalidates the unchanged session", async () => {
  const session = createStoredSession(tokens(NOW + 60_000), CONFIG.accountId, SECRET, NOW);
  const store = memoryStore(session);
  const events: AuditEvent[] = [];
  await assert.rejects(
    resolveSessionAccess({
      signedSessionId: signSessionId(session.id, SECRET),
      config: CONFIG,
      store,
      now: () => NOW,
      correlationId: CORRELATION_ID,
      audit: auditCollector(events),
      refresh: async () => { throw new OAuthTokenError("token_exchange_failed", 400); },
    }),
    SessionAuthenticationError,
  );
  assert.equal(store.row, null);
  assert.deepEqual(events.map(({ action, outcome }) => ({ action, outcome })), [
    { action: "authentication.session-refreshed", outcome: "failed" },
    { action: "authentication.session-invalidated", outcome: "succeeded" },
  ]);
});

test("account changes invalidate and audit against the session's original hub", async () => {
  const originalAccountId = "08cdd85f-5f14-4e1c-a254-cacc553d4523";
  const session = createStoredSession(tokens(NOW + 3_600_000), originalAccountId, SECRET, NOW);
  const store = memoryStore(session);
  const events: AuditEvent[] = [];
  await assert.rejects(resolveSessionAccess({
    signedSessionId: signSessionId(session.id, SECRET),
    config: CONFIG,
    store,
    now: () => NOW,
    correlationId: CORRELATION_ID,
    audit: auditCollector(events),
  }), SessionAuthenticationError);
  assert.equal(store.row, null);
  assert.equal(events[0]?.action, "authentication.session-invalidated");
  assert.equal(events[0]?.scopeId, originalAccountId);
});

test("scope configuration changes invalidate an otherwise current session", async () => {
  const session = createStoredSession(tokens(NOW + 3_600_000), CONFIG.accountId, SECRET, NOW);
  const store = memoryStore(session);
  const events: AuditEvent[] = [];
  let refreshes = 0;

  await assert.rejects(resolveSessionAccess({
    signedSessionId: signSessionId(session.id, SECRET),
    config: { ...CONFIG, scopes: ["scope:least-privilege"] },
    store,
    now: () => NOW,
    correlationId: CORRELATION_ID,
    audit: auditCollector(events),
    refresh: async () => {
      refreshes += 1;
      return tokens(NOW + 3_600_000, "unexpected");
    },
  }), SessionAuthenticationError);

  assert.equal(refreshes, 0);
  assert.equal(store.row, null);
  assert.deepEqual(events.map(({ action, outcome }) => ({ action, outcome })), [{
    action: "authentication.session-invalidated",
    outcome: "succeeded",
  }]);
});

test("stored session scope comparison is order-independent", async () => {
  const configuredScopes = ["scope:read", "scope:account"];
  const reorderedTokens: ApsTokenSet = {
    ...tokens(NOW + 3_600_000),
    scopes: [...configuredScopes].reverse(),
  };
  const session = createStoredSession(reorderedTokens, CONFIG.accountId, SECRET, NOW);
  const store = memoryStore(session);

  const resolved = await resolveSessionAccess({
    signedSessionId: signSessionId(session.id, SECRET),
    config: { ...CONFIG, scopes: configuredScopes },
    store,
    now: () => NOW,
    audit: async () => undefined,
  });

  assert.equal(resolved.accessToken, reorderedTokens.accessToken);
  assert.ok(store.row);
});

test("a concurrent idle touch cannot defeat refresh-token rotation CAS", async () => {
  const session = createStoredSession(tokens(NOW + 60_000), CONFIG.accountId, SECRET, NOW);
  const store = memoryStore(session);
  const concurrentLastSeenAt = NOW + 5_000;
  const resolved = await resolveSessionAccess({
    signedSessionId: signSessionId(session.id, SECRET),
    config: CONFIG,
    store,
    now: () => NOW + 1_000,
    audit: async () => undefined,
    refresh: async () => {
      assert.equal(await store.touch(session.id, session.lastSeenAt, concurrentLastSeenAt), true);
      return tokens(NOW + 3_600_000, "rotated");
    },
  });

  assert.equal(resolved.accessToken, "access-rotated");
  assert.equal(store.row?.lastSeenAt, concurrentLastSeenAt);
  assert.ok(store.row && store.row.updatedAt > session.updatedAt);
  const storedTokens = store.row
    ? decryptTokenEnvelope(store.row.encryptedTokens, store.row.id, store.row.accountId, SECRET)
    : null;
  assert.equal(storedTokens?.refreshToken, "refresh-rotated");
});

test("a required audit sink failure is surfaced after token rotation", async () => {
  const session = createStoredSession(tokens(NOW + 60_000), CONFIG.accountId, SECRET, NOW);
  const store = memoryStore(session);
  const auditFailures: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => { auditFailures.push(values); };
  try {
    await assert.rejects(resolveSessionAccess({
      signedSessionId: signSessionId(session.id, SECRET),
      config: CONFIG,
      store,
      now: () => NOW,
      audit: async () => { throw new Error("sink unavailable with sensitive detail"); },
      refresh: async () => tokens(NOW + 3_600_000, "rotated"),
    }), (error: unknown) => {
      assert.equal(error instanceof SessionAuthenticationError, true);
      assert.equal(String(error).includes("sensitive detail"), false);
      return true;
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(auditFailures.length, 1);
  assert.equal(JSON.stringify(auditFailures).includes("sensitive detail"), false);
  assert.ok(store.row && store.row.updatedAt > session.updatedAt);
});

test("database refresh locks commit terminal session deletion before authentication fails", async (t) => {
  const sql = createPGliteSql("memory://");
  const previousSql = globalThis.__formaRiskSql;
  await runMigrations(sql);
  globalThis.__formaRiskSql = Promise.resolve(sql);
  const store = createDatabaseSessionStore();

  async function expectRejected(session: StoredSession, options: Pick<ResolveSessionAccessOptions, "now" | "refresh">) {
    const events: AuditEvent[] = [];
    await store.create(session);
    await assert.rejects(resolveSessionAccess({
      signedSessionId: signSessionId(session.id, SECRET),
      config: CONFIG,
      store,
      correlationId: CORRELATION_ID,
      audit: auditCollector(events),
      ...options,
    }), SessionAuthenticationError);
    assert.equal(await store.read(session.id), null, "terminal session row must remain deleted after the lock transaction commits");
    return events.map(({ action, outcome }) => ({ action, outcome }));
  }

  try {
    await t.test("invalid encrypted envelope", async () => {
      const session = Object.freeze({
        ...createStoredSession(tokens(NOW + 3_600_000), CONFIG.accountId, SECRET, NOW),
        encryptedTokens: "invalid-envelope",
      });
      assert.deepEqual(await expectRejected(session, { now: () => NOW }), [{
        action: "authentication.session-invalidated",
        outcome: "succeeded",
      }]);
    });

    await t.test("lifetime expiry before refresh", async () => {
      const session = createStoredSession(tokens(NOW + 10 * 86_400_000), CONFIG.accountId, SECRET, NOW);
      let refreshes = 0;
      assert.deepEqual(await expectRejected(session, {
        now: () => NOW + SESSION_IDLE_TTL_SECONDS * 1_000,
        refresh: async () => {
          refreshes += 1;
          return tokens(NOW + 11 * 86_400_000, "unexpected");
        },
      }), [{ action: "authentication.session-expired", outcome: "succeeded" }]);
      assert.equal(refreshes, 0);
    });

    await t.test("lifetime expiry while refresh is in flight", async () => {
      const session = createStoredSession(tokens(NOW + 60_000), CONFIG.accountId, SECRET, NOW);
      let clockReads = 0;
      let refreshes = 0;
      assert.deepEqual(await expectRejected(session, {
        now: () => {
          clockReads += 1;
          return clockReads === 1 ? NOW + 1_000 : NOW + SESSION_IDLE_TTL_SECONDS * 1_000;
        },
        refresh: async () => {
          refreshes += 1;
          return tokens(NOW + SESSION_IDLE_TTL_SECONDS * 1_000 + 3_600_000, "late");
        },
      }), [{ action: "authentication.session-expired", outcome: "succeeded" }]);
      assert.equal(refreshes, 1);
    });

    await t.test("terminal refresh rejection", async () => {
      const session = createStoredSession(tokens(NOW + 60_000), CONFIG.accountId, SECRET, NOW);
      assert.deepEqual(await expectRejected(session, {
        now: () => NOW,
        refresh: async () => { throw new OAuthTokenError("token_exchange_failed", 400); },
      }), [
        { action: "authentication.session-refreshed", outcome: "failed" },
        { action: "authentication.session-invalidated", outcome: "succeeded" },
      ]);
    });
  } finally {
    globalThis.__formaRiskSql = previousSql;
    await sql.close();
  }
});
