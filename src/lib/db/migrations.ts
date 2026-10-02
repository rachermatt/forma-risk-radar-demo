import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyMigrationPlan, verifyMigrationPlan } from "./migration-plan";
import type { Sql } from "./sql";

async function readBaselineSchema(): Promise<string> {
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  return readFile(schemaPath, "utf8");
}

export async function runMigrations(sql: Sql): Promise<void> {
  const schema = await readBaselineSchema();
  await applyMigrationPlan(sql, (work) => sql.transaction(work), schema);
}

export async function verifyMigrations(sql: Sql): Promise<void> {
  const schema = await readBaselineSchema();
  await verifyMigrationPlan(sql, schema);
}
