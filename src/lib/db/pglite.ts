import "server-only";

import { PGlite } from "@electric-sql/pglite";
import type { Sql, SqlExecutor, SqlResult, SqlValue } from "./sql";

type PGliteQueryResult<Row> = {
  rows: Row[];
  affectedRows?: number;
};

function valuesForPGlite(values: readonly SqlValue[]): unknown[] {
  return values.map((value) => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value;
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return value;
  });
}

function executor(client: Pick<PGlite, "query" | "exec">): SqlExecutor {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []): Promise<SqlResult<Row>> {
      const result = (await client.query(text, valuesForPGlite(values))) as PGliteQueryResult<Row>;
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(text: string): Promise<void> {
      await client.exec(text);
    },
  };
}

export function createPGliteSql(dataDir: string): Sql {
  const client = new PGlite(dataDir);
  const root = executor(client);
  return {
    ...root,
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      return client.transaction(async (transaction) => work(executor(transaction as unknown as PGlite)));
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}
