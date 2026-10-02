import "server-only";

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { postgresPoolConfig } from "./postgres-config";
import { installPostgresPoolErrorHandler } from "./pool-errors";
import type { Sql, SqlExecutor, SqlResult, SqlValue } from "./sql";

function postgresValue(value: SqlValue): unknown {
  if (value !== null && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function executor(client: Pool | PoolClient): SqlExecutor {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []): Promise<SqlResult<Row>> {
      const result = await client.query<Row & QueryResultRow>(text, values.map(postgresValue));
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
    async exec(text: string): Promise<void> {
      await client.query(text);
    },
  };
}

export function createPostgresSql(connectionString: string): Sql {
  const pool = new Pool(postgresPoolConfig(connectionString, "runtime"));
  installPostgresPoolErrorHandler(pool);
  const root = executor(pool);
  return {
    ...root,
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(executor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
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
