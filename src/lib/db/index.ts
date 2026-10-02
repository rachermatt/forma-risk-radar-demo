import "server-only";

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runMigrations, verifyMigrations } from "./migrations";
import { createPGliteSql } from "./pglite";
import { createPostgresSql } from "./postgres";
import { runtimeSchemaPolicy } from "./runtime-policy";
import type { Sql } from "./sql";

declare global {
  // eslint-disable-next-line no-var
  var __formaRiskSql: Promise<Sql> | undefined;
}

async function createSql(): Promise<Sql> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const pgliteDir = process.env.PGLITE_DIR?.trim() || ".data/pg";
  let sql: Sql;
  if (databaseUrl) {
    sql = createPostgresSql(databaseUrl);
  } else {
    const resolvedPgliteDir = path.resolve(/* turbopackIgnore: true */ process.cwd(), pgliteDir);
    await mkdir(path.dirname(resolvedPgliteDir), { recursive: true });
    sql = createPGliteSql(resolvedPgliteDir);
  }
  try {
    if (runtimeSchemaPolicy(databaseUrl) === "verify-only") {
      // The web role is deliberately DML-only. Production schema changes are
      // applied out of process by `npm run db:migrate` with a migration role.
      await verifyMigrations(sql);
    } else {
      await runMigrations(sql);
    }
    return sql;
  } catch (error) {
    await sql.close().catch(() => undefined);
    throw error;
  }
}

export function getSql(): Promise<Sql> {
  if (!globalThis.__formaRiskSql) {
    const pending = createSql();
    globalThis.__formaRiskSql = pending;
    void pending.catch(() => {
      if (globalThis.__formaRiskSql === pending) {
        globalThis.__formaRiskSql = undefined;
      }
    });
  }
  return globalThis.__formaRiskSql;
}

export type { Sql, SqlExecutor, SqlResult, SqlValue } from "./sql";
