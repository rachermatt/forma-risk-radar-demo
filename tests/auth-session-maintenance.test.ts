import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  sweepExpiredSessionsToBound,
  sweepExpiredSessionsWithAudit,
} from "../src/lib/auth/session-maintenance";
import { applyMigrationPlan } from "../src/lib/db/migration-plan";
import type { SqlExecutor, SqlResult, SqlValue } from "../src/lib/db/sql";

const NOW = Date.UTC(2026, 8, 8, 12);
const CORRELATION_ID = "be5dc927-414c-42dc-b01b-791f305ab93b";

interface QueryCall {
  readonly text: string;
  readonly values: readonly SqlValue[];
}

function pgliteExecutor(database: Pick<PGlite, "query" | "exec">): SqlExecutor {
  return {
    async query<Row extends Record<string, unknown>>(
      text: string,
      values: readonly SqlValue[] = [],
    ): Promise<SqlResult<Row>> {
      const result = await database.query<Row>(text, [...values] as unknown[]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(text: string): Promise<void> { await database.exec(text); },
  };
}

function expiredRows(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${offset + index}`,
    account_id: `account-${offset + index}`,
    last_seen_at: NOW - 2 * 24 * 60 * 60 * 1_000 + offset + index,
    created_at: NOW - 8 * 24 * 60 * 60 * 1_000 + offset + index,
    was_deleted: true,
  }));
}

test("the scheduled sweep drains more than 100 rows in deterministic bounded batches", async () => {
  const calls: QueryCall[] = [];
  const deletionBatches = [expiredRows(100), expiredRows(37, 100)];
  const sql: SqlExecutor = {
    async query<Row extends Record<string, unknown>>(
      text: string,
      values: readonly SqlValue[] = [],
    ): Promise<SqlResult<Row>> {
      calls.push({ text, values });
      const rows = text.includes("DELETE FROM aps_sessions")
        ? deletionBatches.shift() ?? []
        : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    },
    async exec() {},
  };

  const result = await sweepExpiredSessionsToBound(
    sql,
    NOW,
    CORRELATION_ID,
    100,
    10,
  );
  assert.deepEqual(result, { removedCount: 137, batches: 2, complete: true });
  const deletes = calls.filter((call) => call.text.includes("DELETE FROM aps_sessions"));
  const audits = calls.filter((call) => call.text.includes("INSERT INTO audit_log"));
  assert.equal(deletes.length, 2);
  assert.equal(audits.length, 2);
  assert.match(deletes[0]?.text ?? "", /ORDER BY last_seen_at, created_at, id/iu);
  assert.match(deletes[0]?.text ?? "", /FOR UPDATE SKIP LOCKED/iu);
  assert.deepEqual(deletes[0]?.values.slice(0, 3), [
    NOW - 7 * 24 * 60 * 60 * 1_000,
    NOW - 24 * 60 * 60 * 1_000,
    100,
  ]);
  assert.equal(audits[0]?.values[1], CORRELATION_ID);
  assert.equal((audits[0]?.values[3] as readonly string[]).length, 100);
});

test("a refresh-locked candidate neither hides later expired rows nor reports a false drain", async () => {
  const first = expiredRows(100);
  const locked = first[0];
  assert.ok(locked);
  first[0] = { ...locked, was_deleted: false };
  const batches = [first, expiredRows(5, 100)];
  let deletionCalls = 0;
  const sql: SqlExecutor = {
    async query<Row extends Record<string, unknown>>(
      text: string,
    ): Promise<SqlResult<Row>> {
      if (text.includes("DELETE FROM aps_sessions")) {
        deletionCalls += 1;
        const rows = batches.shift() ?? [];
        return { rows: rows as unknown as Row[], rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    async exec() {},
  };

  const result = await sweepExpiredSessionsToBound(
    sql,
    NOW,
    CORRELATION_ID,
    100,
    10,
  );
  assert.deepEqual(result, { removedCount: 104, batches: 2, complete: false });
  assert.equal(deletionCalls, 2);
});

test("the sweep reports a remaining backlog when its hard cap is reached", async () => {
  let deletionCalls = 0;
  const sql: SqlExecutor = {
    async query<Row extends Record<string, unknown>>(
      text: string,
    ): Promise<SqlResult<Row>> {
      if (text.includes("DELETE FROM aps_sessions")) {
        deletionCalls += 1;
        const rows = expiredRows(100) as unknown as Row[];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("SELECT EXISTS")) {
        return { rows: [{ remaining: true } as unknown as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async exec() {},
  };

  const result = await sweepExpiredSessionsToBound(
    sql,
    NOW,
    CORRELATION_ID,
    100,
    2,
  );
  assert.deepEqual(result, { removedCount: 200, batches: 2, complete: false });
  assert.equal(deletionCalls, 2);
});

test("an empty sweep performs no audit insert", async () => {
  const calls: string[] = [];
  const sql: SqlExecutor = {
    async query<Row extends Record<string, unknown>>(text: string): Promise<SqlResult<Row>> {
      calls.push(text);
      return { rows: [], rowCount: 0 };
    },
    async exec() {},
  };
  assert.deepEqual(
    await sweepExpiredSessionsWithAudit(sql, NOW, CORRELATION_ID),
    [],
  );
  assert.equal(calls.length, 1);
});

test("expiry deletion and audit commit together on the PostgreSQL-compatible engine", async () => {
  const database = new PGlite();
  try {
    const schema = await readFile(
      path.join(process.cwd(), "src", "lib", "db", "schema.sql"),
      "utf8",
    );
    await applyMigrationPlan(
      pgliteExecutor(database),
      (work) => database.transaction((transaction) => work(pgliteExecutor(transaction))),
      schema,
    );
    await database.query(
      `INSERT INTO aps_sessions (
         id, account_id, encrypted_tokens, created_at, updated_at, last_seen_at
       ) VALUES
         ('expired', 'hub-expired', 'ciphertext', $1, $1, $2),
         ('active', 'hub-active', 'ciphertext', $3, $3, $4)`,
      [
        NOW - 8 * 24 * 60 * 60 * 1_000,
        NOW - 2 * 24 * 60 * 60 * 1_000,
        NOW - 24 * 60 * 60 * 1_000,
        NOW - 60 * 60 * 1_000,
      ],
    );

    const result = await database.transaction((transaction) =>
      sweepExpiredSessionsToBound(
        pgliteExecutor(transaction),
        NOW,
        CORRELATION_ID,
      ));
    assert.deepEqual(result, { removedCount: 1, batches: 1, complete: true });
    const sessions = await database.query<{ id: string }>(
      "SELECT id FROM aps_sessions ORDER BY id",
    );
    assert.deepEqual(sessions.rows, [{ id: "active" }]);
    const audit = await database.query<{ action: string; scope_id: string; outcome: string }>(
      "SELECT action, scope_id, outcome FROM audit_log",
    );
    assert.deepEqual(audit.rows, [{
      action: "authentication.session-expired",
      scope_id: "hub-expired",
      outcome: "succeeded",
    }]);
  } finally {
    await database.close();
  }
});
