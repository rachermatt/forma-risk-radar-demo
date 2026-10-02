import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { sweepExpiredSessionsToBound } from "../src/lib/auth/session-maintenance";
import { verifyMigrationPlan } from "../src/lib/db/migration-plan";
import { postgresPoolConfig } from "../src/lib/db/postgres-config";
import type { SqlExecutor, SqlResult, SqlValue } from "../src/lib/db/sql";

function postgresValue(value: SqlValue): unknown {
  if (value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function executor(client: Pool | PoolClient): SqlExecutor {
  return {
    async query<Row extends Record<string, unknown>>(
      text: string,
      values: readonly SqlValue[] = [],
    ): Promise<SqlResult<Row>> {
      const result = await client.query<Row & QueryResultRow>(text, values.map(postgresValue));
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
    async exec(text: string): Promise<void> { await client.query(text); },
  };
}

function runtimeDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "DATABASE_URL is required for sessions:sweep; production Autodesk sessions do not use PGlite.",
    );
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "postgres://[redacted]");
}

async function sweep(): Promise<void> {
  const pool = new Pool(postgresPoolConfig(runtimeDatabaseUrl(), "runtime"));
  const baselineSchema = await readFile(
    path.join(process.cwd(), "src", "lib", "db", "schema.sql"),
    "utf8",
  );
  try {
    await verifyMigrationPlan(executor(pool), baselineSchema);
    const client = await pool.connect();
    let began = false;
    try {
      await client.query("BEGIN");
      began = true;
      const result = await sweepExpiredSessionsToBound(
        executor(client),
        Date.now(),
        randomUUID(),
      );
      await client.query("COMMIT");
      began = false;
      process.stdout.write(
        `Expired session sweep removed ${result.removedCount} session(s) in ${result.batches} batch(es).\n`,
      );
      if (!result.complete) {
        process.stderr.write(
          "Expired session sweep reached its hard run cap; schedule another run to drain the reported backlog.\n",
        );
        process.exitCode = 2;
      }
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void sweep().catch((error: unknown) => {
  process.stderr.write(`Expired session sweep failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
