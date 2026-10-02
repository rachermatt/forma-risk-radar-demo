import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { applyMigrationPlan } from "../src/lib/db/migration-plan";
import {
  postgresPoolConfig,
  requireMigrationDatabaseUrl,
} from "../src/lib/db/postgres-config";
import type { Sql, SqlExecutor, SqlResult, SqlValue } from "../src/lib/db/sql";

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
    async exec(text: string): Promise<void> {
      await client.query(text);
    },
  };
}

function migrationSql(connectionString: string): Sql {
  const pool = new Pool(postgresPoolConfig(connectionString, "migration"));
  const root = executor(pool);
  return {
    ...root,
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let began = false;
      try {
        await client.query("BEGIN");
        began = true;
        const result = await work(executor(client));
        await client.query("COMMIT");
        began = false;
        return result;
      } catch (error) {
        if (began) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "postgres://[redacted]");
}

async function migrate(): Promise<void> {
  const connectionString = requireMigrationDatabaseUrl();
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  const baselineSchema = await readFile(schemaPath, "utf8");
  const sql = migrationSql(connectionString);
  try {
    await applyMigrationPlan(sql, (work) => sql.transaction(work), baselineSchema);
  } finally {
    await sql.close();
  }
  process.stdout.write("Database migrations are applied and verified.\n");
}

void migrate().catch((error: unknown) => {
  process.stderr.write(`Database migration failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
