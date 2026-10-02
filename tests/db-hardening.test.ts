import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { applyMigrationPlan, verifyMigrationPlan } from "../src/lib/db/migration-plan";
import {
  POSTGRES_POOL_LIMITS,
  postgresPoolConfig,
  requireMigrationDatabaseUrl,
  type PostgresPoolPurpose,
} from "../src/lib/db/postgres-config";
import { runtimeSchemaPolicy } from "../src/lib/db/runtime-policy";
import type { SqlExecutor, SqlResult, SqlValue } from "../src/lib/db/sql";

function executor(database: Pick<PGlite, "query" | "exec">): SqlExecutor {
  return {
    async query<Row extends Record<string, unknown>>(
      text: string,
      values: readonly SqlValue[] = [],
    ): Promise<SqlResult<Row>> {
      const result = await database.query<Row>(text, [...values] as unknown[]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(text: string): Promise<void> {
      await database.exec(text);
    },
  };
}

async function baselineSchema(): Promise<string> {
  return readFile(path.join(process.cwd(), "src", "lib", "db", "schema.sql"), "utf8");
}

test("the external PostgreSQL runtime policy is verification-only", () => {
  assert.equal(runtimeSchemaPolicy("postgres://app@example.test/risk"), "verify-only");
  assert.equal(runtimeSchemaPolicy("  postgres://app@example.test/risk  "), "verify-only");
  assert.equal(runtimeSchemaPolicy(undefined), "apply-local");
  assert.equal(runtimeSchemaPolicy("  "), "apply-local");
});

test("migration verification accepts a complete plan without executing DDL", async () => {
  const database = new PGlite();
  try {
    const schema = await baselineSchema();
    const adapter = executor(database);
    await applyMigrationPlan(
      adapter,
      (work) => database.transaction((transaction) => work(executor(transaction))),
      schema,
    );

    const statements: string[] = [];
    const readOnly: SqlExecutor = {
      async query<Row extends Record<string, unknown>>(
        text: string,
        values: readonly SqlValue[] = [],
      ): Promise<SqlResult<Row>> {
        statements.push(text);
        return adapter.query<Row>(text, values);
      },
      async exec(): Promise<void> {
        throw new Error("verification attempted DDL");
      },
    };

    await verifyMigrationPlan(readOnly, schema);
    assert.deepEqual(statements, ["SELECT id, checksum FROM schema_migrations"]);
  } finally {
    await database.close();
  }
});

test("migration verification fails closed for missing and altered migrations", async () => {
  const database = new PGlite();
  try {
    const schema = await baselineSchema();
    const adapter = executor(database);
    await applyMigrationPlan(
      adapter,
      (work) => database.transaction((transaction) => work(executor(transaction))),
      schema,
    );

    await database.exec("DELETE FROM schema_migrations WHERE id = '0009_source_record_attribution_integrity'");
    await assert.rejects(
      verifyMigrationPlan(adapter, schema),
      /0009_source_record_attribution_integrity is not applied/u,
    );

    await database.exec(
      "UPDATE schema_migrations SET checksum = 'tampered' WHERE id = '0008_snapshot_forward_fill_metadata'",
    );
    await assert.rejects(
      verifyMigrationPlan(adapter, schema),
      /Migration 0008_snapshot_forward_fill_metadata changed after it was applied/u,
    );
  } finally {
    await database.close();
  }
});

test("migration verification reports an uninitialized database without creating metadata", async () => {
  const database = new PGlite();
  try {
    await assert.rejects(
      verifyMigrationPlan(executor(database), await baselineSchema()),
      /Run `npm run db:migrate` before starting the web runtime/u,
    );
    const tables = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'",
    );
    assert.equal(tables.rows[0]?.count, 0);
  } finally {
    await database.close();
  }
});

test("every PostgreSQL workload has bounded pool, acquisition, query, statement, and lock waits", () => {
  const purposes: readonly PostgresPoolPurpose[] = ["runtime", "migration", "demo-seed"];
  const numericKeys = [
    "max",
    "connectionTimeoutMillis",
    "idleTimeoutMillis",
    "maxLifetimeSeconds",
    "statement_timeout",
    "query_timeout",
    "lock_timeout",
    "idle_in_transaction_session_timeout",
  ] as const;

  for (const purpose of purposes) {
    const limits = POSTGRES_POOL_LIMITS[purpose];
    for (const key of numericKeys) {
      assert.equal(typeof limits[key], "number", `${purpose}.${key} must be numeric`);
      assert.ok(Number(limits[key]) > 0, `${purpose}.${key} must be bounded above zero`);
    }
    assert.ok(Number(limits.query_timeout) > Number(limits.statement_timeout));

    const config = postgresPoolConfig("postgres://secret@example.test/risk", purpose);
    assert.equal(config.connectionString, "postgres://secret@example.test/risk");
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    assert.equal(config.enableChannelBinding, true);
    assert.match(String(config.application_name), /^forma-risk-radar/u);

    const client = new Client(config) as Client & {
      connectionParameters: {
        application_name: string;
        idle_in_transaction_session_timeout: number | string;
        lock_timeout: number | string;
        options: string;
        query_timeout: number | string;
        statement_timeout: number | string;
      };
    };
    assert.equal(Number(client.connectionParameters.statement_timeout), Number(limits.statement_timeout));
    assert.equal(Number(client.connectionParameters.query_timeout), Number(limits.query_timeout));
    assert.equal(Number(client.connectionParameters.lock_timeout), Number(limits.lock_timeout));
    assert.equal(
      Number(client.connectionParameters.idle_in_transaction_session_timeout),
      Number(limits.idle_in_transaction_session_timeout),
    );
    assert.equal(client.connectionParameters.application_name, config.application_name);
    assert.equal(client.connectionParameters.options, "-c timezone=UTC");
  }
});

test("PostgreSQL URLs cannot override bounded or identifying client settings", () => {
  const reserved = [
    "query_timeout=0",
    "statement_timeout=0",
    "lock_timeout=0",
    "idle_in_transaction_session_timeout=0",
    "connect_timeout=0",
    "connectionTimeoutMillis=0",
    "application_name=other",
    "fallback_application_name=other",
    "host=evil.example",
    "hostaddr=203.0.113.7",
    "options=-c%20statement_timeout%3D0",
    "password=other",
    "port=6543",
    "user=other",
    "database=other",
  ];
  for (const parameter of reserved) {
    assert.throws(
      () => postgresPoolConfig(`postgres://user:secret@example.test/risk?${parameter}`, "runtime"),
      /must not set reserved client parameter/u,
    );
  }
  for (const parameter of ["sslmode=disable", "sslmode=require", "sslcert=%2Ftmp%2Fclient.crt", "sslnegotiation=direct"]) {
    assert.throws(
      () => postgresPoolConfig(`postgres://user:secret@example.test/risk?${parameter}`, "runtime"),
      /must not set TLS parameter/u,
    );
  }
  assert.throws(
    () => postgresPoolConfig("postgres://user:secret@localhost/risk?host=evil.example", "runtime"),
    /reserved client parameter host/u,
  );
  assert.throws(
    () => postgresPoolConfig("postgres://user:secret@localhost/risk?arbitrary=value", "runtime"),
    /unapproved client parameter/u,
  );
  assert.throws(
    () => postgresPoolConfig("postgres://user:secret@localhost/risk#fragment", "runtime"),
    /must not contain a fragment/u,
  );
});

test("remote PostgreSQL is certificate-verified while plaintext is loopback-only", () => {
  for (const connectionString of [
    "postgres://user:secret@database.example.test/risk",
    "postgresql://user:secret@10.0.0.8/risk",
  ]) {
    const config = postgresPoolConfig(connectionString, "runtime");
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    assert.equal(config.enableChannelBinding, true);
  }
  for (const connectionString of [
    "postgres://user:secret@localhost/risk",
    "postgres://user:secret@localhost./risk",
    "postgres://user:secret@127.0.0.1/risk",
    "postgres://user:secret@[::1]/risk",
  ]) {
    const config = postgresPoolConfig(connectionString, "runtime");
    assert.equal(config.ssl, false);
    assert.equal(config.enableChannelBinding, false);
  }
});

test("the migration command requires its dedicated credential and ignores DATABASE_URL", () => {
  assert.throws(
    () => requireMigrationDatabaseUrl({ DATABASE_URL: "postgres://runtime@example.test/risk" }),
    /MIGRATION_DATABASE_URL is required.*DATABASE_URL is deliberately ignored/u,
  );
  assert.equal(
    requireMigrationDatabaseUrl({
      DATABASE_URL: "postgres://runtime@example.test/risk",
      MIGRATION_DATABASE_URL: "  postgres://migration@example.test/risk  ",
    }),
    "postgres://migration@example.test/risk",
  );
});
