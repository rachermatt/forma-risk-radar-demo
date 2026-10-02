import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { getSql } from "@/lib/db";
import type { SqlExecutor } from "@/lib/db";
import type { SessionStore, StoredSession } from "@/lib/auth/session";
import { purgeExpiredSessionRows } from "@/lib/auth/session-maintenance";

interface SessionRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string;
  readonly encrypted_tokens: string;
  readonly created_at: string | number;
  readonly updated_at: string | number;
  readonly last_seen_at: string | number;
}

function toSafeInteger(value: string | number): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function mapSession(row: SessionRow | undefined): StoredSession | null {
  if (!row) return null;
  const createdAt = toSafeInteger(row.created_at);
  const updatedAt = toSafeInteger(row.updated_at);
  const lastSeenAt = toSafeInteger(row.last_seen_at);
  if (createdAt === null || updatedAt === null || lastSeenAt === null) return null;
  return Object.freeze({
    id: row.id,
    accountId: row.account_id,
    encryptedTokens: row.encrypted_tokens,
    createdAt,
    updatedAt,
    lastSeenAt,
  });
}

/** Durable, revocable session storage shared by PGlite and PostgreSQL. */
export function createDatabaseSessionStore(): SessionStore {
  const transactionContext = new AsyncLocalStorage<SqlExecutor>();
  const executor = async (): Promise<SqlExecutor> => transactionContext.getStore() ?? await getSql();
  const store: SessionStore = {
    async create(session) {
      const sql = await executor();
      await sql.query(
        `INSERT INTO aps_sessions (
          id, account_id, encrypted_tokens, created_at, updated_at, last_seen_at
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          session.id,
          session.accountId,
          session.encryptedTokens,
          session.createdAt,
          session.updatedAt,
          session.lastSeenAt,
        ],
      );
    },

    async read(sessionId) {
      const sql = await executor();
      const result = await sql.query<SessionRow>(
        `SELECT id, account_id, encrypted_tokens, created_at, updated_at, last_seen_at
         FROM aps_sessions
         WHERE id = $1`,
        [sessionId],
      );
      return mapSession(result.rows[0]);
    },

    async replaceTokens(
      sessionId,
      expectedUpdatedAt,
      encryptedTokens,
      updatedAt,
      lastSeenAt,
    ) {
      const sql = await executor();
      const result = await sql.query<{ id: string }>(
        `UPDATE aps_sessions
         SET encrypted_tokens = $1,
             updated_at = $2,
             last_seen_at = GREATEST(last_seen_at, $3)
         WHERE id = $4 AND updated_at = $5
         RETURNING id`,
        [
          encryptedTokens,
          updatedAt,
          lastSeenAt,
          sessionId,
          expectedUpdatedAt,
        ],
      );
      return result.rows.length === 1;
    },

    async touch(sessionId, expectedLastSeenAt, lastSeenAt) {
      const sql = await executor();
      const result = await sql.query<{ id: string }>(
        `UPDATE aps_sessions
         SET last_seen_at = $1
         WHERE id = $2 AND last_seen_at = $3
         RETURNING id`,
        [lastSeenAt, sessionId, expectedLastSeenAt],
      );
      return result.rows.length === 1;
    },

    async deleteIfUnchanged(sessionId, expectedUpdatedAt) {
      const sql = await executor();
      const result = await sql.query<{ id: string }>(
        `DELETE FROM aps_sessions
         WHERE id = $1 AND updated_at = $2
         RETURNING id`,
        [sessionId, expectedUpdatedAt],
      );
      return result.rows.length === 1;
    },

    async delete(sessionId) {
      const sql = await executor();
      await sql.query("DELETE FROM aps_sessions WHERE id = $1", [sessionId]);
    },

    async purgeExpired(absoluteCutoff, idleCutoff, limit) {
      const sql = await executor();
      return purgeExpiredSessionRows(sql, absoluteCutoff, idleCutoff, limit);
    },

    async withRefreshLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
      const sql = await getSql();
      return sql.transaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
        return transactionContext.run(transaction, operation);
      });
    },
  };
  return store;
}
