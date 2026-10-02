import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { recordIdentityKey, type MetricProvenance, type RiskRecord } from "../src/lib/canonical/types";
import { applyMigrationPlan, verifyMigrationPlan } from "../src/lib/db/migration-plan";
import { postgresPoolConfig } from "../src/lib/db/postgres-config";
import type { SqlExecutor, SqlResult, SqlValue } from "../src/lib/db/sql";
import { getDemoDataset } from "../src/lib/demo/generator";
import type { DemoDataset } from "../src/lib/demo/types";
import { RISK_CONFIGURATION_ID } from "../src/lib/risk/definitions";
import { normalizeLifecycle } from "../src/lib/risk/normalization";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function pgliteLocation(): string {
  const configured = process.env.PGLITE_DIR?.trim() || ".data/pg";
  return configured.includes("://") ? configured : path.resolve(process.cwd(), configured);
}

interface SeedExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  exec(text: string): Promise<void>;
}

interface SeedDatabase extends SeedExecutor {
  transaction<T>(work: (transaction: SeedExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function databaseValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

function pgliteDatabase(client: PGlite): SeedDatabase {
  const executorFor = (connection: Pick<PGlite, "query" | "exec">): SeedExecutor => ({
    async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      const result = await connection.query<Row>(text, values.map(databaseValue));
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(text: string): Promise<void> {
      await connection.exec(text);
    },
  });
  const root = executorFor(client);
  return {
    ...root,
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      return client.transaction((transaction) => work(executorFor(transaction as unknown as PGlite)));
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

function postgresExecutor(client: Pool | PoolClient): SeedExecutor {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      const result = await client.query<Row & QueryResultRow>(text, values.map(databaseValue));
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
    async exec(text: string): Promise<void> {
      await client.query(text);
    },
  };
}

function postgresDatabase(connectionString: string): SeedDatabase {
  const pool = new Pool(postgresPoolConfig(connectionString, "demo-seed"));
  const root = postgresExecutor(pool);
  let manualTransaction: PoolClient | null = null;
  return {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      return postgresExecutor(manualTransaction ?? pool).query<Row>(text, values);
    },
    async exec(text: string): Promise<void> {
      const command = text.trim().toUpperCase();
      if (command === "BEGIN") {
        if (manualTransaction) throw new Error("A seed transaction is already active.");
        manualTransaction = await pool.connect();
        await manualTransaction.query("BEGIN");
        return;
      }
      if (command === "COMMIT" || command === "ROLLBACK") {
        if (!manualTransaction) throw new Error("No seed transaction is active.");
        const client = manualTransaction;
        try {
          await client.query(command);
        } finally {
          manualTransaction = null;
          client.release();
        }
        return;
      }
      await (manualTransaction ?? pool).query(text);
    },
    async transaction<T>(work: (transaction: SeedExecutor) => Promise<T>): Promise<T> {
      if (manualTransaction) throw new Error("Nested seed transactions are not supported.");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(postgresExecutor(client));
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
      if (manualTransaction) {
        const client = manualTransaction;
        manualTransaction = null;
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      await pool.end();
    },
  };
}

async function openDatabase(): Promise<{
  database: SeedDatabase;
  engine: "pglite" | "postgres";
  location: string;
}> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return {
      database: postgresDatabase(databaseUrl),
      engine: "postgres",
      location: "the configured PostgreSQL database",
    };
  }
  const location = pgliteLocation();
  if (!location.includes("://")) await mkdir(location, { recursive: true });
  return { database: pgliteDatabase(new PGlite(location)), engine: "pglite", location };
}

function migrationExecutor(database: SeedExecutor): SqlExecutor {
  return {
    query: (text, values) => database.query(text, values),
    exec: (text) => database.exec(text),
  };
}

async function prepareSchema(
  database: SeedDatabase,
  engine: "pglite" | "postgres",
  schema: string,
): Promise<void> {
  const executor = migrationExecutor(database);
  if (engine === "postgres") {
    await verifyMigrationPlan(executor, schema);
    return;
  }
  await applyMigrationPlan(
    executor,
    (work) => database.transaction((transaction) => work(migrationExecutor(transaction))),
    schema,
  );
}

async function upsertProvenance(
  database: SeedExecutor,
  ingestionJobId: string,
  provenance: MetricProvenance,
  inputs: unknown,
  result: unknown,
): Promise<string> {
  const inputDigest = fingerprint(inputs);
  const id = `provenance-demo-${fingerprint({
    definitionId: provenance.definitionId,
    definitionVersion: provenance.definitionVersion,
    projectId: provenance.projectId ?? null,
    inputDigest,
  }).slice(0, 24)}`;
  const inserted = await database.query<{ id: string }>(
    `INSERT INTO data_provenance (
      id, ingestion_job_id, source_system, source_dataset, source_record_id,
      project_id, extracted_at, calculated_at, definition_id,
      definition_version, algorithm_version, value_kind, autodesk_term,
      input_digest, inputs, result
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13,
      $14, $15::jsonb, $16::jsonb
    )
    ON CONFLICT (definition_id, definition_version, algorithm_version, input_digest)
    DO UPDATE SET
      ingestion_job_id = EXCLUDED.ingestion_job_id,
      source_system = EXCLUDED.source_system,
      source_dataset = EXCLUDED.source_dataset,
      source_record_id = EXCLUDED.source_record_id,
      project_id = EXCLUDED.project_id,
      extracted_at = EXCLUDED.extracted_at,
      calculated_at = EXCLUDED.calculated_at,
      value_kind = EXCLUDED.value_kind,
      autodesk_term = EXCLUDED.autodesk_term,
      inputs = EXCLUDED.inputs,
      result = EXCLUDED.result
    RETURNING id`,
    [
      id,
      ingestionJobId,
      provenance.sourceSystem,
      provenance.sourceDataset,
      provenance.sourceRecordId ?? null,
      provenance.projectId ?? null,
      provenance.extractedAt,
      provenance.calculatedAt,
      provenance.definitionId,
      provenance.definitionVersion,
      RISK_CONFIGURATION_ID,
      provenance.valueKind,
      provenance.autodeskTerm ?? null,
      inputDigest,
      canonicalJson(inputs),
      canonicalJson(result),
    ],
  );
  const provenanceId = inserted.rows[0]?.id;
  if (!provenanceId) throw new Error(`Failed to persist provenance ${id}.`);
  return provenanceId;
}

function recordFingerprint(record: RiskRecord): string {
  return fingerprint({
    kind: record.kind,
    id: record.id,
    projectId: record.projectId,
    displayId: record.displayId,
    title: record.title,
    status: record.status,
    open: record.open,
    domain: record.domain,
    constructionIqRisk: record.constructionIqRisk,
    constructionIqModelRisk: record.constructionIqModelRisk,
    riskUserOverridden: record.riskUserOverridden,
    rfiCategory: record.rfiCategory,
    iqSafetyRiskCategory: record.iqSafetyRiskCategory,
    iqSafetyRiskPredictedAt: record.iqSafetyRiskPredictedAt,
    iqSafetyHazardCategory: record.iqSafetyHazardCategory,
    iqSafetyHazardPredictedAt: record.iqSafetyHazardPredictedAt,
    iqSafetyObservationCategory: record.iqSafetyObservationCategory,
    iqSafetyObservationPredictedAt: record.iqSafetyObservationPredictedAt,
    typeName: record.typeName,
    subtypeName: record.subtypeName,
    rootCauseId: record.rootCauseId,
    rootCause: record.rootCause,
    rootCauseCategory: record.rootCauseCategory,
    iqRootCauseModel: record.iqRootCauseModel,
    iqRootCause: record.iqRootCause,
    iqRootCauseUserOverridden: record.iqRootCauseUserOverridden,
    discipline: record.discipline,
    disciplineOrigin: record.disciplineOrigin,
    buildingComponentModel: record.buildingComponentModel,
    buildingComponent: record.buildingComponent,
    buildingComponentUserOverridden: record.buildingComponentUserOverridden,
    locationId: record.locationId,
    locationPath: record.locationPath,
    companyId: record.companyId,
    companyAttribution: record.companyAttribution,
    assigneeId: record.assigneeId,
    assigneeName: record.assigneeName,
    assigneeType: record.assigneeType,
    ownerId: record.ownerId,
    ownerName: record.ownerName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    dueDate: record.dueDate,
    closedAt: record.closedAt,
    respondedAt: record.respondedAt,
    costImpact: record.costImpact,
    scheduleImpact: record.scheduleImpact,
    iqCostImpact: record.iqCostImpact,
    href: record.href ?? null,
    raw: record.raw ?? {},
  });
}

async function rebuildTypedDemoRows(database: SeedExecutor, dataset: DemoDataset): Promise<void> {
  const hubId = dataset.hub.id;
  const sourceExtractedAt = dataset.ingestion.sourceExtractedAt ?? dataset.asOf;
  const projectSubquery = "SELECT id FROM projects WHERE hub_id = $1";

  await database.query(`DELETE FROM rfi_transitions WHERE project_id IN (${projectSubquery})`, [hubId]);
  await database.query(`DELETE FROM form_answers WHERE project_id IN (${projectSubquery})`, [hubId]);
  await database.query(`DELETE FROM form_questions WHERE project_id IN (${projectSubquery})`, [hubId]);
  await database.query(`DELETE FROM review_tasks WHERE project_id IN (${projectSubquery})`, [hubId]);
  for (const table of ["issues", "rfis", "forms", "reviews", "submittals", "schedule_activities"] as const) {
    await database.query(`DELETE FROM ${table} WHERE project_id IN (${projectSubquery})`, [hubId]);
  }
  await database.query(`DELETE FROM project_users WHERE project_id IN (${projectSubquery})`, [hubId]);
  await database.query("DELETE FROM users WHERE hub_id = $1", [hubId]);
  await database.query(`DELETE FROM locations WHERE project_id IN (${projectSubquery})`, [hubId]);

  const userRows = new Map<string, { companyId: string | null; projects: Map<string, string | null> }>();
  for (const record of dataset.records) {
    const linkedUsers = [
      record.assigneeType === "user" && record.assigneeId
        ? { id: record.assigneeId, companyId: record.companyAttribution === "via-assignee-membership" ? record.companyId : null }
        : null,
      record.ownerId
        ? { id: record.ownerId, companyId: record.companyAttribution === "via-owner-membership" ? record.companyId : null }
        : null,
    ].filter((entry): entry is { id: string; companyId: string | null } => entry !== null);
    for (const linkedUser of linkedUsers) {
      const user = userRows.get(linkedUser.id) ?? { companyId: linkedUser.companyId, projects: new Map() };
      if (!user.companyId && linkedUser.companyId) user.companyId = linkedUser.companyId;
      user.projects.set(record.projectId, linkedUser.companyId);
      userRows.set(linkedUser.id, user);
    }
  }
  for (const [userId, user] of userRows) {
    await database.query(
      `INSERT INTO users (
        id, hub_id, autodesk_id, name, status, default_company_id,
        source_extracted_at, ingested_at
      ) VALUES ($1, $2, $1, $3, 'active', $4, $5, $6)`,
      [userId, hubId, `Synthetic ${userId.replaceAll("-", " ")}`, user.companyId, sourceExtractedAt, dataset.asOf],
    );
    for (const [projectId, companyId] of user.projects) {
      await database.query(
        `INSERT INTO project_users (
          project_id, user_id, company_id, access_level, status,
          source_extracted_at, ingested_at
        ) VALUES ($1, $2, $3, 'member', 'active', $4, $5)`,
        [projectId, userId, companyId, sourceExtractedAt, dataset.asOf],
      );
    }
  }

  for (const location of [...dataset.locations].sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id))) {
    const derivedTier = location.depth === 0 ? "building" : location.depth === 1 ? "level" : location.depth === 2 ? "zone" : "room";
    await database.query(
      `INSERT INTO locations (
        id, project_id, tree_id, parent_id, name, sort_order, depth, path,
        derived_tier, derived_tier_rule, source_extracted_at, ingested_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'synthetic path depth', $10, $11)`,
      [location.id, location.projectId, location.treeId, location.parentId, location.name, location.order, location.depth, location.path, derivedTier, sourceExtractedAt, dataset.asOf],
    );
  }

  for (const record of dataset.records) {
    const digest = recordFingerprint(record);
    if (record.kind === "issue") {
      await database.query(
        `INSERT INTO issues (
          issue_id, project_id, display_id, title, type_id, subtype_id, status,
          assignee_id, assignee_type, due_date, location_id, owner_id, root_cause_id,
          created_at, updated_at, closed_at, iq_quality_risk, iq_quality_user_risk,
          iq_cost_impact, iq_safety_risk_category, iq_safety_hazard_category,
          iq_safety_observation_category, iq_design_root_cause,
          iq_design_building_component, fingerprint, source_extracted_at, ingested_at,
          iq_design_user_root_cause, iq_design_user_building_component,
          iq_safety_risk_predicted_at, iq_safety_hazard_predicted_at,
          iq_safety_observation_predicted_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18,
          $19, $20, $21,
          $22, $23,
          $24, $25, $26, $27,
          $28, $29, $30, $31, $32
        )`,
        [
          record.id, record.projectId, record.displayId, record.title, record.typeName, record.subtypeName, record.status,
          record.assigneeId, record.assigneeType, record.dueDate, record.locationId, record.ownerId, record.rootCauseId,
          record.createdAt, record.updatedAt, record.closedAt, record.raw?.risk ?? null, record.raw?.user_risk ?? null,
          record.iqCostImpact, record.iqSafetyRiskCategory, record.iqSafetyHazardCategory,
          record.iqSafetyObservationCategory, record.iqRootCauseModel,
          record.buildingComponentModel, digest, sourceExtractedAt, dataset.asOf,
          record.iqRootCauseUserOverridden ? record.iqRootCause : null,
          record.buildingComponentUserOverridden ? record.buildingComponent : null,
          record.iqSafetyRiskPredictedAt, record.iqSafetyHazardPredictedAt,
          record.iqSafetyObservationPredictedAt,
        ],
      );
    } else if (record.kind === "rfi") {
      await database.query(
        `INSERT INTO rfis (
          id, project_id, custom_identifier, title, status, priority,
          cost_impact, schedule_impact, due_date, location_id, rfi_type,
          manager_id, responded_at, closed_at, created_at, updated_at,
          iq_risk, iq_risk_score, iq_root_cause, iq_discipline, operational_discipline,
          iq_building_component, fingerprint, source_extracted_at, ingested_at,
          operational_category
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21,
          $22, $23, $24, $25, $26
        )`,
        [
          record.id, record.projectId, record.displayId, record.title, record.status, record.raw?.priority ?? null,
          record.costImpact, record.scheduleImpact, record.dueDate, record.locationId, record.typeName,
          record.ownerId, record.respondedAt, record.closedAt, record.createdAt, record.updatedAt,
          record.raw?.risk ?? null, record.raw?.score ?? null, record.iqRootCause,
          record.disciplineOrigin === "construction-iq" ? record.discipline : null,
          record.disciplineOrigin === "operational" ? record.discipline : null,
          record.buildingComponentModel, digest, sourceExtractedAt, dataset.asOf,
          record.rfiCategory,
        ],
      );
    } else if (record.kind === "form") {
      await database.query(
        `INSERT INTO forms (
          id, project_id, template_id, native_form_id, name, number, status,
          location_id, created_at, updated_at, closed_at, last_submitted_at,
          fingerprint, source_extracted_at, ingested_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [record.id, record.projectId, record.raw?.template_id ?? null, record.raw?.native_form_id ?? record.raw?.form_id ?? record.id, record.title, record.displayId, record.status, record.locationId, record.createdAt, record.updatedAt, record.closedAt, record.raw?.last_submitted_at ?? record.createdAt, digest, sourceExtractedAt, dataset.asOf],
      );
    } else if (record.kind === "review") {
      await database.query(
        `INSERT INTO reviews (
          id, project_id, name, status, created_at, updated_at, completed_at,
          raw, fingerprint, source_extracted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
        [record.id, record.projectId, record.title, record.status, record.createdAt, record.updatedAt, record.closedAt, canonicalJson(record.raw ?? {}), digest, sourceExtractedAt],
      );
    } else if (record.kind === "submittal") {
      await database.query(
        `INSERT INTO submittals (
          id, project_id, title, status, revision, submitter_due_date,
          manager_due_date, required_on_job_date, lead_time, responsible_company_id,
          created_at, updated_at, closed_at, fingerprint, source_extracted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [record.id, record.projectId, record.title, record.status, record.raw?.revision ?? null, record.dueDate, record.dueDate, record.raw?.required_on_job_date ?? null, record.raw?.lead_time ?? null, record.companyId, record.createdAt, record.updatedAt, record.closedAt, digest, sourceExtractedAt],
      );
    } else if (record.kind === "schedule-activity") {
      await database.query(
        `INSERT INTO schedule_activities (
          id, project_id, name, start_date, finish_date, is_critical_path,
          activity_code, raw, fingerprint, source_extracted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
        [record.id, record.projectId, record.title, record.createdAt, record.dueDate, record.raw?.is_critical ?? null, record.displayId, canonicalJson(record.raw ?? {}), digest, sourceExtractedAt],
      );
    }
  }
}

async function pruneStaleDemoEntities(database: SeedExecutor, dataset: DemoDataset): Promise<void> {
  const currentProjectIds = dataset.projects.map((summary) => summary.project.id);
  const staleProjects = await database.query<{ id: string }>(
    `SELECT id FROM projects
     WHERE hub_id = $1 AND NOT (id = ANY($2::text[]))`,
    [dataset.hub.id, currentProjectIds],
  );
  const staleProjectIds = staleProjects.rows.map((row) => row.id);
  if (staleProjectIds.length) {
    const staleProvenance = "SELECT id FROM data_provenance WHERE project_id = ANY($1::text[])";
    await database.query(`DELETE FROM mitigation_recommendations WHERE project_id = ANY($1::text[]) OR provenance_id IN (${staleProvenance})`, [staleProjectIds]);
    await database.query(`DELETE FROM risk_recurrence_groups WHERE provenance_id IN (${staleProvenance})`, [staleProjectIds]);
    await database.query(`DELETE FROM risk_factors WHERE scope_id = ANY($1::text[]) OR provenance_id IN (${staleProvenance})`, [staleProjectIds]);
    await database.query(`DELETE FROM subcontractor_risk_snapshots WHERE project_id = ANY($1::text[]) OR provenance_id IN (${staleProvenance})`, [staleProjectIds]);
    await database.query(`DELETE FROM risk_exposure_snapshots WHERE scope_id = ANY($1::text[]) OR provenance_id IN (${staleProvenance})`, [staleProjectIds]);
    await database.query(`DELETE FROM project_risk_snapshots WHERE project_id = ANY($1::text[]) OR provenance_id IN (${staleProvenance})`, [staleProjectIds]);
    await database.query(`DELETE FROM risk_snapshots WHERE scope_id = ANY($1::text[]) OR provenance_id IN (${staleProvenance})`, [staleProjectIds]);
    await database.query("DELETE FROM risk_relationships WHERE project_id = ANY($1::text[])", [staleProjectIds]);
    await database.query("DELETE FROM rfi_transitions WHERE project_id = ANY($1::text[])", [staleProjectIds]);
    await database.query("DELETE FROM form_answers WHERE project_id = ANY($1::text[])", [staleProjectIds]);
    await database.query("DELETE FROM form_questions WHERE project_id = ANY($1::text[])", [staleProjectIds]);
    await database.query("DELETE FROM review_tasks WHERE project_id = ANY($1::text[])", [staleProjectIds]);
    for (const table of ["issues", "rfis", "forms", "reviews", "submittals", "schedule_activities"] as const) {
      await database.query(`DELETE FROM ${table} WHERE project_id = ANY($1::text[])`, [staleProjectIds]);
    }
    await database.query("DELETE FROM source_records WHERE project_id = ANY($1::text[])", [staleProjectIds]);
    await database.query("DELETE FROM project_users WHERE project_id = ANY($1::text[])", [staleProjectIds]);
    await database.query("DELETE FROM locations WHERE project_id = ANY($1::text[])", [staleProjectIds]);
    await database.query("DELETE FROM roles WHERE project_id = ANY($1::text[])", [staleProjectIds]);
    await database.query(`DELETE FROM data_provenance WHERE id IN (${staleProvenance})`, [staleProjectIds]);
    await database.query("UPDATE ingestion_jobs SET project_id = NULL WHERE project_id = ANY($1::text[])", [staleProjectIds]);
    await database.query("DELETE FROM projects WHERE id = ANY($1::text[])", [staleProjectIds]);
  }

  const currentCompanyIds = dataset.companies.map((company) => company.id);
  const staleCompanies = await database.query<{ id: string }>(
    `SELECT id FROM companies
     WHERE hub_id = $1 AND NOT (id = ANY($2::text[]))`,
    [dataset.hub.id, currentCompanyIds],
  );
  const staleCompanyIds = staleCompanies.rows.map((row) => row.id);
  if (staleCompanyIds.length) {
    await database.query("DELETE FROM subcontractor_risk_snapshots WHERE company_id = ANY($1::text[])", [staleCompanyIds]);
    await database.query("UPDATE users SET default_company_id = NULL WHERE default_company_id = ANY($1::text[])", [staleCompanyIds]);
    await database.query("UPDATE project_users SET company_id = NULL WHERE company_id = ANY($1::text[])", [staleCompanyIds]);
    await database.query(
      `UPDATE source_records
       SET company_id = NULL,
           company_attribution = 'unattributed',
           assignee_id = CASE
             WHEN assignee_type = 'company' AND assignee_id = ANY($1::text[]) THEN NULL
             ELSE assignee_id
           END,
           assignee_type = CASE
             WHEN assignee_type = 'company' AND assignee_id = ANY($1::text[]) THEN NULL
             ELSE assignee_type
           END
       WHERE company_id = ANY($1::text[])`,
      [staleCompanyIds],
    );
    await database.query("UPDATE submittals SET responsible_company_id = NULL WHERE responsible_company_id = ANY($1::text[])", [staleCompanyIds]);
    await database.query("DELETE FROM companies WHERE id = ANY($1::text[])", [staleCompanyIds]);
  }
}

async function seed(): Promise<void> {
  if (process.env.DATA_MODE?.trim().toLowerCase() === "autodesk") {
    throw new Error("Refusing to write synthetic demo data while DATA_MODE=autodesk.");
  }
  if (process.env.NODE_ENV?.trim().toLowerCase() === "production") {
    throw new Error("Refusing to run the synthetic demo seed with NODE_ENV=production.");
  }
  if (process.env.DATABASE_URL?.trim() && process.env.ALLOW_DEMO_SEED_TO_DATABASE_URL !== "true") {
    throw new Error("Set ALLOW_DEMO_SEED_TO_DATABASE_URL=true to confirm seeding the configured PostgreSQL database.");
  }
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  const schema = await readFile(schemaPath, "utf8");
  const dataset = getDemoDataset();
  const { database, engine, location } = await openDatabase();

  try {
    await prepareSchema(database, engine, schema);
    await database.exec("BEGIN");
    try {
      await database.query(
        `INSERT INTO hubs (
          id, name, region, integration_verified, source_extracted_at, ingested_at
        ) VALUES ($1, $2, $3, false, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          region = EXCLUDED.region,
          integration_verified = EXCLUDED.integration_verified,
          source_extracted_at = EXCLUDED.source_extracted_at,
          ingested_at = EXCLUDED.ingested_at`,
        [dataset.hub.id, dataset.hub.name, dataset.hub.region ?? null, dataset.ingestion.sourceExtractedAt, dataset.asOf],
      );

      for (const unit of dataset.businessUnits) {
        await database.query(
          `INSERT INTO business_units (hub_id, id, parent_id, name, path, source_extracted_at, ingested_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (hub_id, id) DO UPDATE SET
             parent_id = EXCLUDED.parent_id,
             name = EXCLUDED.name,
             path = EXCLUDED.path,
             source_extracted_at = EXCLUDED.source_extracted_at,
             ingested_at = EXCLUDED.ingested_at`,
          [unit.hubId, unit.id, unit.parentId, unit.name, unit.path, dataset.ingestion.sourceExtractedAt, dataset.asOf],
        );
      }

      for (const summary of dataset.projects) {
        const project = summary.project;
        await database.query(
          `INSERT INTO projects (
            id, hub_id, name, status, type, classification, business_unit_id,
            start_date, end_date, city, country, value, currency,
            total_member_size, total_company_size, accessible, is_production,
            production_exclusion_reason, available_domains, ciq_eligible,
            current_phase, source_extracted_at, ingested_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13,
            $14, $15, $16, true,
            NULL, $17::jsonb, $18,
            $19, $20, $21
          )
          ON CONFLICT (id) DO UPDATE SET
            hub_id = EXCLUDED.hub_id,
            name = EXCLUDED.name,
            status = EXCLUDED.status,
            type = EXCLUDED.type,
            classification = EXCLUDED.classification,
            business_unit_id = EXCLUDED.business_unit_id,
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            city = EXCLUDED.city,
            country = EXCLUDED.country,
            value = EXCLUDED.value,
            currency = EXCLUDED.currency,
            total_member_size = EXCLUDED.total_member_size,
            total_company_size = EXCLUDED.total_company_size,
            accessible = EXCLUDED.accessible,
            is_production = EXCLUDED.is_production,
            production_exclusion_reason = EXCLUDED.production_exclusion_reason,
            available_domains = EXCLUDED.available_domains,
            ciq_eligible = EXCLUDED.ciq_eligible,
            current_phase = EXCLUDED.current_phase,
            source_extracted_at = EXCLUDED.source_extracted_at,
            ingested_at = EXCLUDED.ingested_at`,
          [
            project.id,
            project.hubId,
            project.name,
            project.status,
            project.type,
            project.classification,
            project.businessUnitId,
            project.startDate,
            project.endDate,
            project.city,
            project.country,
            project.value,
            project.currency,
            project.memberCount,
            project.companyCount,
            project.accessible,
            canonicalJson(project.availableDomains),
            summary.ciqObservedAt !== null,
            project.currentPhase,
            dataset.ingestion.sourceExtractedAt,
            dataset.asOf,
          ],
        );
      }

      for (const company of dataset.companies) {
        const [tradePrimary, ...tradeRest] = company.trade?.split("|").map((part) => part.trim()) ?? [];
        await database.query(
          `INSERT INTO companies (
            id, hub_id, name, trade, trade_primary, trade_secondary,
            category, status, source_extracted_at, ingested_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO UPDATE SET
            hub_id = EXCLUDED.hub_id,
            name = EXCLUDED.name,
            trade = EXCLUDED.trade,
            trade_primary = EXCLUDED.trade_primary,
            trade_secondary = EXCLUDED.trade_secondary,
            category = EXCLUDED.category,
            status = EXCLUDED.status,
            source_extracted_at = EXCLUDED.source_extracted_at,
            ingested_at = EXCLUDED.ingested_at`,
          [
            company.id,
            company.hubId,
            company.name,
            company.trade,
            tradePrimary ?? null,
            tradeRest.length ? tradeRest.join(" | ") : null,
            company.category,
            company.status,
            dataset.ingestion.sourceExtractedAt,
            dataset.asOf,
          ],
        );
      }

      const existingSourceRecords = await database.query<{
        project_id: string;
        kind: RiskRecord["kind"];
        id: string;
        fingerprint: string;
      }>(
        `SELECT source.project_id, source.kind, source.id, source.fingerprint
         FROM source_records source
         JOIN projects project ON project.id = source.project_id
         WHERE project.hub_id = $1`,
        [dataset.hub.id],
      );
      const existingFingerprints = new Map(
        existingSourceRecords.rows.map((row) => [
          recordIdentityKey({ projectId: row.project_id, kind: row.kind, id: row.id }),
          row.fingerprint,
        ]),
      );
      const currentKeys = new Set(dataset.records.map(recordIdentityKey));
      const staleSourceRecords = existingSourceRecords.rows.filter((row) => !currentKeys.has(recordIdentityKey({
        projectId: row.project_id,
        kind: row.kind,
        id: row.id,
      })));
      let rowsInserted = 0;
      let rowsUpdated = 0;
      let rowsUnchanged = 0;
      for (const record of dataset.records) {
        const previous = existingFingerprints.get(recordIdentityKey(record));
        if (previous === undefined) rowsInserted += 1;
        else if (previous === recordFingerprint(record)) rowsUnchanged += 1;
        else rowsUpdated += 1;
      }
      const seedWarnings = staleSourceRecords.length
        ? [...dataset.ingestion.warnings, `${staleSourceRecords.length} stale synthetic source rows were reconciled.`]
        : dataset.ingestion.warnings;

      await database.query(
        `INSERT INTO ingestion_jobs (
          id, hub_id, source, job_type, started_at, completed_at, project_id,
          rows_processed, rows_inserted, rows_updated, rows_unchanged,
          failures, warnings, source_extracted_at, status, budget_consumed
        ) VALUES (
          $1, $2, $3, 'demo-seed', $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12::jsonb, $13, $14, false
        )
        ON CONFLICT (id) DO UPDATE SET
          hub_id = EXCLUDED.hub_id,
          source = EXCLUDED.source,
          job_type = EXCLUDED.job_type,
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at,
          project_id = EXCLUDED.project_id,
          rows_processed = EXCLUDED.rows_processed,
          rows_inserted = EXCLUDED.rows_inserted,
          rows_updated = EXCLUDED.rows_updated,
          rows_unchanged = EXCLUDED.rows_unchanged,
          failures = EXCLUDED.failures,
          warnings = EXCLUDED.warnings,
          source_extracted_at = EXCLUDED.source_extracted_at,
          status = EXCLUDED.status,
          budget_consumed = EXCLUDED.budget_consumed`,
        [
          dataset.ingestion.id,
          dataset.hub.id,
          dataset.ingestion.source,
          dataset.ingestion.startedAt,
          dataset.ingestion.completedAt,
          dataset.ingestion.projectId,
          dataset.records.length,
          rowsInserted,
          rowsUpdated,
          rowsUnchanged,
          dataset.ingestion.failures,
          canonicalJson(seedWarnings),
          dataset.ingestion.sourceExtractedAt,
          dataset.ingestion.status,
        ],
      );

      for (const record of dataset.records) {
        const lifecycle = normalizeLifecycle(record.kind, {
          status: record.status,
          closedAt: record.closedAt,
          respondedAt: record.respondedAt,
          deletedAt: typeof record.raw?.deleted_at === "string" ? record.raw.deleted_at : null,
        });
        await database.query(
          `INSERT INTO source_records (
            kind, id, project_id, display_id, title, status, status_normalized,
            open, domain, ciq_risk, ciq_model_risk, ciq_risk_user_override,
            ciq_cost_impact, ciq_root_cause, type_name, subtype_name,
            root_cause, root_cause_id, root_cause_category, discipline,
            discipline_origin, building_component,
            location_id, location_path, company_id, company_attribution,
            assignee_id, assignee_type, owner_id, created_at, updated_at,
            due_date, closed_at, responded_at, cost_impact, schedule_impact,
            href, raw, fingerprint, first_seen_at, last_seen_at,
            source_extracted_at, ingested_at,
            rfi_category,
            ciq_root_cause_model, ciq_root_cause_user_override,
            ciq_building_component_model, ciq_building_component_user_override,
            ciq_safety_risk_category, ciq_safety_risk_predicted_at,
            ciq_safety_hazard_category, ciq_safety_hazard_predicted_at,
            ciq_safety_observation_category, ciq_safety_observation_predicted_at,
            assignee_name, owner_name
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12,
            $13, $14, $15, $16,
            $17, $18, $19, $20,
            $21, $22, $23, $24,
            $25, $26, $27, $28,
            $29, $30, $31, $32, $33, $34,
            $35, $36, $37, $38::jsonb, $39,
            $40, $41, $42, $43,
            $44, $45, $46, $47, $48,
            $49, $50, $51, $52, $53, $54,
            $55, $56
          )
          ON CONFLICT (project_id, kind, id) DO UPDATE SET
            display_id = EXCLUDED.display_id,
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            status_normalized = EXCLUDED.status_normalized,
            open = EXCLUDED.open,
            domain = EXCLUDED.domain,
            ciq_risk = EXCLUDED.ciq_risk,
            ciq_model_risk = EXCLUDED.ciq_model_risk,
            ciq_risk_user_override = EXCLUDED.ciq_risk_user_override,
            ciq_cost_impact = EXCLUDED.ciq_cost_impact,
            ciq_root_cause = EXCLUDED.ciq_root_cause,
            type_name = EXCLUDED.type_name,
            subtype_name = EXCLUDED.subtype_name,
            root_cause = EXCLUDED.root_cause,
            root_cause_id = EXCLUDED.root_cause_id,
            root_cause_category = EXCLUDED.root_cause_category,
            discipline = EXCLUDED.discipline,
            discipline_origin = EXCLUDED.discipline_origin,
            building_component = EXCLUDED.building_component,
            location_id = EXCLUDED.location_id,
            location_path = EXCLUDED.location_path,
            company_id = EXCLUDED.company_id,
            company_attribution = EXCLUDED.company_attribution,
            assignee_id = EXCLUDED.assignee_id,
            assignee_type = EXCLUDED.assignee_type,
            owner_id = EXCLUDED.owner_id,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            due_date = EXCLUDED.due_date,
            closed_at = EXCLUDED.closed_at,
            responded_at = EXCLUDED.responded_at,
            cost_impact = EXCLUDED.cost_impact,
            schedule_impact = EXCLUDED.schedule_impact,
            href = EXCLUDED.href,
            raw = EXCLUDED.raw,
            fingerprint = EXCLUDED.fingerprint,
            last_seen_at = EXCLUDED.last_seen_at,
            source_extracted_at = EXCLUDED.source_extracted_at,
            ingested_at = EXCLUDED.ingested_at,
            rfi_category = EXCLUDED.rfi_category,
            ciq_root_cause_model = EXCLUDED.ciq_root_cause_model,
            ciq_root_cause_user_override = EXCLUDED.ciq_root_cause_user_override,
            ciq_building_component_model = EXCLUDED.ciq_building_component_model,
            ciq_building_component_user_override = EXCLUDED.ciq_building_component_user_override,
            ciq_safety_risk_category = EXCLUDED.ciq_safety_risk_category,
            ciq_safety_risk_predicted_at = EXCLUDED.ciq_safety_risk_predicted_at,
            ciq_safety_hazard_category = EXCLUDED.ciq_safety_hazard_category,
            ciq_safety_hazard_predicted_at = EXCLUDED.ciq_safety_hazard_predicted_at,
            ciq_safety_observation_category = EXCLUDED.ciq_safety_observation_category,
            ciq_safety_observation_predicted_at = EXCLUDED.ciq_safety_observation_predicted_at,
            assignee_name = EXCLUDED.assignee_name,
            owner_name = EXCLUDED.owner_name`,
          [
            record.kind,
            record.id,
            record.projectId,
            record.displayId,
            record.title,
            record.status,
            lifecycle,
            lifecycle === "open",
            record.domain,
            record.constructionIqRisk,
            record.constructionIqModelRisk,
            record.riskUserOverridden,
            record.iqCostImpact,
            record.iqRootCause,
            record.typeName,
            record.subtypeName,
            record.rootCause,
            record.rootCauseId,
            record.rootCauseCategory,
            record.discipline,
            record.disciplineOrigin,
            record.buildingComponent,
            record.locationId,
            record.locationPath,
            record.companyId,
            record.companyAttribution,
            record.assigneeId,
            record.assigneeType,
            record.ownerId,
            record.createdAt,
            record.updatedAt,
            record.dueDate,
            record.closedAt,
            record.respondedAt,
            record.costImpact,
            record.scheduleImpact,
            record.href ?? null,
            canonicalJson(record.raw ?? {}),
            recordFingerprint(record),
            dataset.ingestion.sourceExtractedAt ?? dataset.asOf,
            dataset.asOf,
            dataset.ingestion.sourceExtractedAt,
            dataset.asOf,
            record.rfiCategory,
            record.iqRootCauseModel,
            record.iqRootCauseUserOverridden,
            record.buildingComponentModel,
            record.buildingComponentUserOverridden,
            record.iqSafetyRiskCategory,
            record.iqSafetyRiskPredictedAt,
            record.iqSafetyHazardCategory,
            record.iqSafetyHazardPredictedAt,
            record.iqSafetyObservationCategory,
            record.iqSafetyObservationPredictedAt,
            record.assigneeName,
            record.ownerName,
          ],
        );
      }

      for (const stale of staleSourceRecords) {
        await database.query(
          "DELETE FROM source_records WHERE project_id = $1 AND kind = $2 AND id = $3",
          [stale.project_id, stale.kind, stale.id],
        );
      }
      await rebuildTypedDemoRows(database, dataset);

      const projectIdsForHub = "SELECT id FROM projects WHERE hub_id = $1";
      const provenanceForJob = "SELECT id FROM data_provenance WHERE ingestion_job_id = $1";
      await database.query(`DELETE FROM mitigation_recommendations WHERE provenance_id IN (${provenanceForJob})`, [dataset.ingestion.id]);
      await database.query(`DELETE FROM risk_recurrence_groups WHERE provenance_id IN (${provenanceForJob})`, [dataset.ingestion.id]);
      await database.query(`DELETE FROM risk_factors WHERE provenance_id IN (${provenanceForJob})`, [dataset.ingestion.id]);
      await database.query(`DELETE FROM subcontractor_risk_snapshots WHERE provenance_id IN (${provenanceForJob})`, [dataset.ingestion.id]);
      await database.query(`DELETE FROM risk_exposure_snapshots WHERE scope_id = $1 OR scope_id IN (${projectIdsForHub})`, [dataset.hub.id]);
      await database.query(`DELETE FROM project_risk_snapshots WHERE project_id IN (${projectIdsForHub})`, [dataset.hub.id]);
      await database.query(`DELETE FROM risk_snapshots WHERE scope_id = $1 OR scope_id IN (${projectIdsForHub})`, [dataset.hub.id]);
      await database.query(`DELETE FROM risk_relationships WHERE project_id IN (${projectIdsForHub})`, [dataset.hub.id]);
      await database.query("DELETE FROM column_report WHERE ingestion_job_id = $1", [dataset.ingestion.id]);
      await database.query("DELETE FROM data_provenance WHERE ingestion_job_id = $1", [dataset.ingestion.id]);

      for (const row of dataset.columnReport) {
        const rowsTotal = row.table === "issues_issues"
          ? dataset.records.filter((record) => record.kind === "issue").length
          : row.table === "iq_issues_quality_risks"
            ? dataset.records.filter((record) => record.kind === "issue" && (record.raw?.risk !== null || record.raw?.user_risk !== null)).length
            : row.table === "iq_issues_safety_risk"
              ? dataset.records.filter((record) => record.kind === "issue" && record.iqSafetyRiskCategory !== null).length
              : row.table === "iq_issues_safety_hazard"
                ? dataset.records.filter((record) => record.kind === "issue" && record.iqSafetyHazardCategory !== null).length
                : row.table === "iq_issues_safety_observations"
                  ? dataset.records.filter((record) => record.kind === "issue" && record.iqSafetyObservationCategory !== null).length
                  : row.table === "iq_design_issues_root_cause"
                    ? dataset.records.filter((record) => record.kind === "issue" && record.iqRootCauseModel !== null).length
                    : row.table === "iq_design_issues_building_components"
                      ? dataset.records.filter((record) => record.kind === "issue" && record.buildingComponentModel !== null).length
            : row.table === "locations_nodes"
              ? row.nonNullRows
              : row.table === "rfis_rfis"
                ? dataset.records.filter((record) => record.kind === "rfi").length
                : 0;
        const id = `column-demo-${fingerprint({ job: dataset.ingestion.id, table: row.table, column: row.column }).slice(0, 24)}`;
        await database.query(
          `INSERT INTO column_report (
            id, ingestion_job_id, hub_id, service_group, table_name, column_name,
            mapped_to, status, rows_total, non_null_rows, sample_values,
            parse_failures, note, observed_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, '[]'::jsonb,
            0, $11, $12
          )
          ON CONFLICT (ingestion_job_id, table_name, column_name) DO UPDATE SET
            hub_id = EXCLUDED.hub_id,
            service_group = EXCLUDED.service_group,
            mapped_to = EXCLUDED.mapped_to,
            status = EXCLUDED.status,
            rows_total = EXCLUDED.rows_total,
            non_null_rows = EXCLUDED.non_null_rows,
            sample_values = EXCLUDED.sample_values,
            parse_failures = EXCLUDED.parse_failures,
            note = EXCLUDED.note,
            observed_at = EXCLUDED.observed_at`,
          [
            id,
            dataset.ingestion.id,
            dataset.hub.id,
            row.table.split("_", 1)[0] ?? "demo",
            row.table,
            row.column,
            row.mappedTo,
            row.mappedTo ? "mapped" : "unmapped",
            rowsTotal,
            row.nonNullRows,
            row.note,
            dataset.asOf,
          ],
        );
      }

      const snapshotDate = dataset.asOf.slice(0, 10);
      for (const summary of dataset.projects) {
        const riskInputs = {
          asOf: dataset.asOf,
          projectId: summary.project.id,
          calculation: summary.calculation.risk,
          evidence: summary.risk.evidence?.map(({ kind, id, projectId }) => ({ kind, id, projectId })) ?? [],
        };
        const riskProvenanceId = await upsertProvenance(
          database,
          dataset.ingestion.id,
          summary.risk.provenance,
          riskInputs,
          summary.risk.value,
        );
        for (const [factorId, value] of Object.entries(summary.calculation.risk.inputs)) {
          if (factorId === "scope") continue;
          await database.query(
            `INSERT INTO risk_factors (
              snapshot_date, scope_type, scope_id, domain, factor_id,
              value, points, detail, algorithm_version, provenance_id
            ) VALUES ($1, 'project', $2, 'all', $3, $4, NULL, $5, $6, $7)`,
            [
              snapshotDate,
              summary.project.id,
              `risk.input.${factorId}`,
              typeof value === "number" ? value : null,
              value === null ? "Input unavailable; omitted and weights renormalized." : "Raw calculation input; normalization and weights are stored in the versioned definition.",
              RISK_CONFIGURATION_ID,
              riskProvenanceId,
            ],
          );
        }
        const coverage = summary.calculation.risk.coverage;
        const historyProvenance: MetricProvenance = {
          ...summary.momentum.provenance,
          definitionId: "risk.index.history.synthetic",
          projectId: summary.project.id,
        };
        const historyProvenanceId = await upsertProvenance(
          database,
          dataset.ingestion.id,
          historyProvenance,
          {
            asOf: dataset.asOf,
            coverageStart: dataset.coverageStart,
            projectId: summary.project.id,
            method: "deterministic synthetic observations with daily forward-fill",
            points: summary.trend,
          },
          summary.trend,
        );
        for (const point of summary.trend) {
          await database.query(
            `INSERT INTO risk_snapshots (
              snapshot_date, scope, scope_id, domain, metric_id, value,
              value_kind, coverage, algorithm_version, forward_filled,
              forward_filled_from, source_extracted_at, provenance_id, calculated_at
            ) VALUES ($1, 'project', $2, 'all', 'risk.index', $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (snapshot_date, scope, scope_id, domain, metric_id, algorithm_version) DO UPDATE SET
              value = EXCLUDED.value,
              value_kind = EXCLUDED.value_kind,
              coverage = EXCLUDED.coverage,
              forward_filled = EXCLUDED.forward_filled,
              forward_filled_from = EXCLUDED.forward_filled_from,
              source_extracted_at = EXCLUDED.source_extracted_at,
              provenance_id = EXCLUDED.provenance_id,
              calculated_at = EXCLUDED.calculated_at`,
            [
              point.date,
              summary.project.id,
              point.value,
              historyProvenance.valueKind,
              coverage,
              RISK_CONFIGURATION_ID,
              point.forwardFilled,
              point.forwardFilledFrom,
              dataset.ingestion.sourceExtractedAt,
              historyProvenanceId,
              historyProvenance.calculatedAt,
            ],
          );
        }
        await database.query(
          `INSERT INTO project_risk_snapshots (
            snapshot_date, project_id, domain, risk_index, severity,
            exposure_index, momentum_direction, ciq_not_applicable, coverage,
            algorithm_version, provenance_id
          ) VALUES ($1, $2, 'all', $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (snapshot_date, project_id, domain, algorithm_version) DO UPDATE SET
            risk_index = EXCLUDED.risk_index,
            severity = EXCLUDED.severity,
            exposure_index = EXCLUDED.exposure_index,
            momentum_direction = EXCLUDED.momentum_direction,
            ciq_not_applicable = EXCLUDED.ciq_not_applicable,
            coverage = EXCLUDED.coverage,
            provenance_id = EXCLUDED.provenance_id`,
          [
            snapshotDate,
            summary.project.id,
            summary.risk.value.index,
            summary.risk.value.severity,
            summary.exposure.value.index,
            summary.momentum.value.direction,
            summary.ciqObservedAt === null,
            coverage,
            RISK_CONFIGURATION_ID,
            riskProvenanceId,
          ],
        );
        await database.query(
          `INSERT INTO risk_snapshots (
            snapshot_date, scope, scope_id, domain, metric_id, value,
            value_kind, coverage, algorithm_version, provenance_id, calculated_at
          ) VALUES ($1, 'project', $2, 'all', 'risk.index', $3, $4, $5, $6, $7, $8)
          ON CONFLICT (snapshot_date, scope, scope_id, domain, metric_id, algorithm_version) DO UPDATE SET
            value = EXCLUDED.value,
            value_kind = EXCLUDED.value_kind,
            coverage = EXCLUDED.coverage,
            provenance_id = EXCLUDED.provenance_id,
            calculated_at = EXCLUDED.calculated_at`,
          [
            snapshotDate,
            summary.project.id,
            summary.risk.value.index,
            summary.risk.provenance.valueKind,
            coverage,
            RISK_CONFIGURATION_ID,
            riskProvenanceId,
            summary.risk.provenance.calculatedAt,
          ],
        );

        const exposureInputs = {
          asOf: dataset.asOf,
          projectId: summary.project.id,
          calculation: summary.calculation.exposure,
          evidence: summary.exposure.evidence?.map(({ kind, id, projectId }) => ({ kind, id, projectId })) ?? [],
        };
        const exposureProvenanceId = await upsertProvenance(
          database,
          dataset.ingestion.id,
          summary.exposure.provenance,
          exposureInputs,
          summary.exposure.value,
        );
        await database.query(
          `INSERT INTO risk_exposure_snapshots (
            snapshot_date, scope_type, scope_id, domain, exposure_index,
            locations_affected, companies_affected, projects_affected,
            confirmed_cost_impact, potential_cost_exposure,
            unquantified_cost_impact, schedule_linked_items,
            critical_path_linked_items, algorithm_version, provenance_id
          ) VALUES (
            $1, 'project', $2, 'all', $3,
            $4, $5, $6,
            $7, $8,
            $9, $10,
            $11, $12, $13
          )
          ON CONFLICT (snapshot_date, scope_type, scope_id, domain, algorithm_version) DO UPDATE SET
            exposure_index = EXCLUDED.exposure_index,
            locations_affected = EXCLUDED.locations_affected,
            companies_affected = EXCLUDED.companies_affected,
            projects_affected = EXCLUDED.projects_affected,
            confirmed_cost_impact = EXCLUDED.confirmed_cost_impact,
            potential_cost_exposure = EXCLUDED.potential_cost_exposure,
            unquantified_cost_impact = EXCLUDED.unquantified_cost_impact,
            schedule_linked_items = EXCLUDED.schedule_linked_items,
            critical_path_linked_items = EXCLUDED.critical_path_linked_items,
            provenance_id = EXCLUDED.provenance_id`,
          [
            snapshotDate,
            summary.project.id,
            summary.exposure.value.index,
            summary.exposure.value.locationsAffected,
            summary.exposure.value.companiesAffected,
            summary.exposure.value.projectsAffected,
            summary.exposure.value.confirmedCostImpact,
            summary.exposure.value.potentialCostExposure,
            summary.exposure.value.unquantifiedCostImpact,
            summary.exposure.value.scheduleLinkedItems,
            summary.exposure.value.criticalPathLinkedItems,
            RISK_CONFIGURATION_ID,
            exposureProvenanceId,
          ],
        );

        for (const domain of summary.domainSummaries) {
          const domainInputs = {
            asOf: dataset.asOf,
            projectId: summary.project.id,
            domain: domain.domain,
            source: domain.source,
            available: domain.available,
            calculation: domain.calculation,
            evidence: domain.evidence.map(({ kind, id, projectId }) => ({ kind, id, projectId })),
          };
          const domainProvenance: MetricProvenance = {
            ...summary.risk.provenance,
            definitionId: "risk.domain.condition",
            projectId: summary.project.id,
          };
          const domainProvenanceId = await upsertProvenance(
            database,
            dataset.ingestion.id,
            domainProvenance,
            domainInputs,
            domain,
          );
          await database.query(
            `INSERT INTO project_risk_snapshots (
              snapshot_date, project_id, domain, risk_index, severity,
              exposure_index, momentum_direction, ciq_not_applicable, coverage,
              algorithm_version, provenance_id
            ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10)
            ON CONFLICT (snapshot_date, project_id, domain, algorithm_version) DO UPDATE SET
              risk_index = EXCLUDED.risk_index,
              severity = EXCLUDED.severity,
              exposure_index = EXCLUDED.exposure_index,
              momentum_direction = EXCLUDED.momentum_direction,
              ciq_not_applicable = EXCLUDED.ciq_not_applicable,
              coverage = EXCLUDED.coverage,
              provenance_id = EXCLUDED.provenance_id`,
            [
              snapshotDate,
              summary.project.id,
              domain.domain,
              domain.index,
              domain.severity,
              summary.momentum.value.direction,
              !domain.available,
              domain.available ? 1 : 0,
              RISK_CONFIGURATION_ID,
              domainProvenanceId,
            ],
          );
        }
      }

      for (const edge of dataset.relationships) {
        const relationshipProvenanceId = await upsertProvenance(
          database,
          dataset.ingestion.id,
          edge.provenance,
          { method: edge.method, confidence: edge.confidence, endpoints: [edge.from, edge.to] },
          { evidence: edge.evidence, serviceOwned: edge.serviceOwned },
        );
        await database.query(
          `INSERT INTO risk_relationships (
            id, project_id, from_kind, from_id, to_kind, to_id,
            confidence, method, evidence, service_owned,
            endpoint_unresolvable, created_at, source_extracted_at,
            snapshot_date, deleted_at, algorithm_version, provenance_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12, $13, $14, $15, $16)`,
          [edge.id, edge.projectId, edge.from.kind, edge.from.id, edge.to.kind, edge.to.id, edge.confidence, edge.method, edge.evidence, edge.serviceOwned, edge.createdAt, dataset.ingestion.sourceExtractedAt, edge.snapshotDate, edge.deletedAt, edge.algorithmVersion, relationshipProvenanceId],
        );
      }

      for (const group of dataset.recurrence) {
        const recurrenceProvenance: MetricProvenance = {
          ...dataset.portfolio.risk.provenance,
          sourceDataset: "demo-source-records",
          definitionId: `recurrence.${group.dimension}`,
        };
        const recurrenceProvenanceId = await upsertProvenance(
          database,
          dataset.ingestion.id,
          recurrenceProvenance,
          {
            asOf: dataset.asOf,
            windowDays: 180,
            signature: group.signature,
            evidence: group.evidence,
          },
          group,
        );
        await database.query(
          `INSERT INTO risk_recurrence_groups (
            id, snapshot_date, signature, label, dimension, occurrences,
            project_ids, recurrence_rate, evidence, algorithm_version, provenance_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11)`,
          [group.id, snapshotDate, group.signature, group.label, group.dimension, group.occurrences, canonicalJson(group.projectsAffected), group.recurrenceRate, canonicalJson(group.evidence), RISK_CONFIGURATION_ID, recurrenceProvenanceId],
        );
      }

      for (const item of dataset.attention) {
        const sourceRecord = item.evidence[0];
        if (!sourceRecord) {
          throw new Error(`Attention item ${item.id} has no canonical source-record evidence.`);
        }
        const sourceRecordId = sourceRecord.id;
        const factorScopeId = recordIdentityKey(sourceRecord);
        const attentionProvenanceId = await upsertProvenance(
          database,
          dataset.ingestion.id,
          item.provenance,
          {
            asOf: dataset.asOf,
            recordIdentity: {
              projectId: sourceRecord.projectId,
              kind: sourceRecord.kind,
              id: sourceRecord.id,
            },
            reasons: item.reasons,
            evidence: item.evidence,
          },
          { score: item.score, rawScore: item.rawScore, priority: item.priority },
        );
        for (const reason of item.reasons) {
          await database.query(
            `INSERT INTO risk_factors (
              snapshot_date, scope_type, scope_id, domain, factor_id,
              value, points, detail, algorithm_version, provenance_id
            ) VALUES ($1, 'record', $2, $3, $4, NULL, $5, $6, $7, $8)`,
            [snapshotDate, factorScopeId, item.domain, reason.code, reason.points, reason.detail, RISK_CONFIGURATION_ID, attentionProvenanceId],
          );
        }
        for (const recommendation of item.recommendations) {
          await database.query(
            `INSERT INTO mitigation_recommendations (
              id, snapshot_date, project_id, source_record_kind, source_record_id,
              title, detail, origin, rule_id, confidence, evidence,
              provenance_id, created_at, algorithm_version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)`,
            [recommendation.id, snapshotDate, item.projectId, sourceRecord.kind, sourceRecordId, recommendation.title, recommendation.detail, recommendation.origin, recommendation.ruleId ?? null, recommendation.confidence ?? null, canonicalJson(recommendation.citedEvidence), attentionProvenanceId, dataset.asOf, RISK_CONFIGURATION_ID],
          );
        }
      }

      const companyProjectGroups = new Map<string, RiskRecord[]>();
      for (const record of dataset.records) {
        if (!record.companyId) continue;
        const key = `${record.projectId}:${record.companyId}`;
        companyProjectGroups.set(key, [...(companyProjectGroups.get(key) ?? []), record]);
      }
      for (const signal of dataset.companyCiqSignals) {
        const key = `${signal.projectId}:${signal.companyId}`;
        if (!companyProjectGroups.has(key)) companyProjectGroups.set(key, []);
      }
      for (const [key, records] of companyProjectGroups) {
        const [projectId, companyId] = key.split(":") as [string, string];
        const open = records.filter((record) => record.open);
        const high = open.filter((record) => record.constructionIqRisk === "critical" || record.constructionIqRisk === "high");
        const overdue = open.filter((record) => record.dueDate && new Date(record.dueDate).getTime() < new Date(dataset.asOf).getTime());
        const direct = records.filter((record) => record.companyAttribution === "direct").length;
        const inferred = records.length - direct;
        const company = dataset.companies.find((candidate) => candidate.id === companyId);
        const ciqSignal = dataset.companyCiqSignals.find((signal) => signal.projectId === projectId && signal.companyId === companyId);
        const projectSummary = dataset.projects.find((summary) => summary.project.id === projectId);
        if (!projectSummary) throw new Error(`Company snapshot references unknown project ${projectId}.`);
        const baseProvenance = projectSummary.risk.provenance;
        const companyProvenance: MetricProvenance = {
          ...baseProvenance,
          sourceDataset: "demo-source-records",
          projectId,
          definitionId: "subcontractor.contextual-counts",
        };
        const companyProvenanceId = await upsertProvenance(
          database,
          dataset.ingestion.id,
          companyProvenance,
          {
            asOf: dataset.asOf,
            projectId,
            companyId,
            formula: "contextual counts only; no cross-company score or ranking",
            records: records.map((record) => ({ kind: record.kind, id: record.id, open: record.open, severity: record.constructionIqRisk, attribution: record.companyAttribution })),
          },
          { open: open.length, overdue: overdue.length, high: high.length, direct, inferred },
        );
        const qualityProvenanceId = ciqSignal?.quality
          ? await upsertProvenance(
              database,
              dataset.ingestion.id,
              ciqSignal.quality.provenance,
              {
                projectId,
                companyId,
                snapshotDate: ciqSignal.snapshotDate,
                observedAt: ciqSignal.quality.observedAt,
                forwardFilled: ciqSignal.quality.forwardFilled,
              },
              {
                dailyRisk: ciqSignal.quality.dailyRisk,
                dailyIndicator: ciqSignal.quality.dailyIndicator,
              },
            )
          : null;
        const safetyProvenanceId = ciqSignal?.safety
          ? await upsertProvenance(
              database,
              dataset.ingestion.id,
              ciqSignal.safety.provenance,
              {
                projectId,
                companyId,
                snapshotDate: ciqSignal.snapshotDate,
                observedAt: ciqSignal.safety.observedAt,
                forwardFilled: ciqSignal.safety.forwardFilled,
              },
              {
                dailyRisk: ciqSignal.safety.dailyRisk,
                dailyIndicator: ciqSignal.safety.dailyIndicator,
              },
            )
          : null;
        const tradePrimary = company?.trade?.split("|", 1)[0]?.trim() || null;
        await database.query(
          `INSERT INTO subcontractor_risk_snapshots (
            snapshot_date, company_id, project_id,
            ciq_quality_daily_risk, ciq_quality_daily_indicator,
            ciq_quality_observed_at, ciq_quality_forward_filled, ciq_quality_provenance_id,
            ciq_safety_daily_risk, ciq_safety_daily_indicator,
            ciq_safety_observed_at, ciq_safety_forward_filled, ciq_safety_provenance_id,
            ciq_not_applicable, derived_risk_index,
            open_attributed, overdue_attributed, high_risk_attributed,
            attributed_direct, attributed_inferred, trade_primary,
            algorithm_version, calculated_at, source_extracted_at, provenance_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL,
            $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
          )`,
          [
            snapshotDate,
            companyId,
            projectId,
            ciqSignal?.quality?.dailyRisk ?? null,
            ciqSignal?.quality?.dailyIndicator ?? null,
            ciqSignal?.quality?.observedAt ?? null,
            ciqSignal?.quality?.forwardFilled ?? false,
            qualityProvenanceId,
            ciqSignal?.safety?.dailyRisk ?? null,
            ciqSignal?.safety?.dailyIndicator ?? null,
            ciqSignal?.safety?.observedAt ?? null,
            ciqSignal?.safety?.forwardFilled ?? false,
            safetyProvenanceId,
            projectSummary.ciqObservedAt === null,
            open.length,
            overdue.length,
            high.length,
            direct,
            inferred,
            tradePrimary,
            RISK_CONFIGURATION_ID,
            dataset.asOf,
            dataset.ingestion.sourceExtractedAt,
            companyProvenanceId,
          ],
        );
      }

      const portfolioInputs = {
        asOf: dataset.asOf,
        calculation: dataset.portfolioCalculation.risk,
        evidence: dataset.portfolio.risk.evidence?.map(({ kind, id, projectId }) => ({ kind, id, projectId })) ?? [],
      };
      const portfolioProvenanceId = await upsertProvenance(
        database,
        dataset.ingestion.id,
        dataset.portfolio.risk.provenance,
        portfolioInputs,
        dataset.portfolio.risk.value,
      );
      const portfolioHistoryProvenance: MetricProvenance = {
        ...dataset.portfolio.momentum.provenance,
        definitionId: "risk.portfolio.history.synthetic",
      };
      const portfolioHistoryProvenanceId = await upsertProvenance(
        database,
        dataset.ingestion.id,
        portfolioHistoryProvenance,
        {
          asOf: dataset.asOf,
          coverageStart: dataset.coverageStart,
          calculation: dataset.portfolioCalculation.momentum,
          points: dataset.portfolioTrend,
        },
        dataset.portfolioTrend,
      );
      for (const point of dataset.portfolioTrend) {
        await database.query(
          `INSERT INTO risk_snapshots (
            snapshot_date, scope, scope_id, domain, metric_id, value,
            value_kind, coverage, algorithm_version, forward_filled,
            forward_filled_from, source_extracted_at, provenance_id, calculated_at
          ) VALUES ($1, 'hub', $2, 'all', 'risk.index', $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (snapshot_date, scope, scope_id, domain, metric_id, algorithm_version) DO UPDATE SET
            value = EXCLUDED.value,
            value_kind = EXCLUDED.value_kind,
            coverage = EXCLUDED.coverage,
            forward_filled = EXCLUDED.forward_filled,
            forward_filled_from = EXCLUDED.forward_filled_from,
            source_extracted_at = EXCLUDED.source_extracted_at,
            provenance_id = EXCLUDED.provenance_id,
            calculated_at = EXCLUDED.calculated_at`,
          [
            point.date,
            dataset.hub.id,
            point.value,
            portfolioHistoryProvenance.valueKind,
            dataset.portfolioCalculation.risk.coverage,
            RISK_CONFIGURATION_ID,
            point.forwardFilled,
            point.forwardFilledFrom,
            dataset.ingestion.sourceExtractedAt,
            portfolioHistoryProvenanceId,
            portfolioHistoryProvenance.calculatedAt,
          ],
        );
      }
      await database.query(
        `INSERT INTO risk_snapshots (
          snapshot_date, scope, scope_id, domain, metric_id, value,
          value_kind, coverage, algorithm_version, provenance_id, calculated_at
        ) VALUES ($1, 'hub', $2, 'all', 'risk.index', $3, $4, $5, $6, $7, $8)
        ON CONFLICT (snapshot_date, scope, scope_id, domain, metric_id, algorithm_version) DO UPDATE SET
          value = EXCLUDED.value,
          value_kind = EXCLUDED.value_kind,
          coverage = EXCLUDED.coverage,
          provenance_id = EXCLUDED.provenance_id,
          calculated_at = EXCLUDED.calculated_at`,
        [
          snapshotDate,
          dataset.hub.id,
          dataset.portfolio.risk.value.index,
          dataset.portfolio.risk.provenance.valueKind,
          dataset.portfolioCalculation.risk.coverage,
          RISK_CONFIGURATION_ID,
          portfolioProvenanceId,
          dataset.portfolio.risk.provenance.calculatedAt,
        ],
      );

      const portfolioExposureProvenanceId = await upsertProvenance(
        database,
        dataset.ingestion.id,
        dataset.portfolio.exposure.provenance,
        {
          asOf: dataset.asOf,
          calculation: dataset.portfolioCalculation.exposure,
          evidence: dataset.portfolio.exposure.evidence ?? [],
        },
        dataset.portfolio.exposure.value,
      );
      await database.query(
        `INSERT INTO risk_exposure_snapshots (
          snapshot_date, scope_type, scope_id, domain, exposure_index,
          locations_affected, companies_affected, projects_affected,
          confirmed_cost_impact, potential_cost_exposure, unquantified_cost_impact,
          schedule_linked_items, critical_path_linked_items, algorithm_version, provenance_id
        ) VALUES (
          $1, 'hub', $2, 'all', $3,
          $4, $5, $6,
          $7, $8, $9,
          $10, $11, $12, $13
        )`,
        [
          snapshotDate,
          dataset.hub.id,
          dataset.portfolio.exposure.value.index,
          dataset.portfolio.exposure.value.locationsAffected,
          dataset.portfolio.exposure.value.companiesAffected,
          dataset.portfolio.exposure.value.projectsAffected,
          dataset.portfolio.exposure.value.confirmedCostImpact,
          dataset.portfolio.exposure.value.potentialCostExposure,
          dataset.portfolio.exposure.value.unquantifiedCostImpact,
          dataset.portfolio.exposure.value.scheduleLinkedItems,
          dataset.portfolio.exposure.value.criticalPathLinkedItems,
          RISK_CONFIGURATION_ID,
          portfolioExposureProvenanceId,
        ],
      );

      const portfolioMomentumProvenanceId = await upsertProvenance(
        database,
        dataset.ingestion.id,
        dataset.portfolio.momentum.provenance,
        {
          asOf: dataset.asOf,
          calculation: dataset.portfolioCalculation.momentum,
          evidence: dataset.portfolio.momentum.evidence ?? [],
        },
        dataset.portfolio.momentum.value,
      );
      await database.query(
        `INSERT INTO risk_snapshots (
          snapshot_date, scope, scope_id, domain, metric_id, value,
          value_kind, coverage, algorithm_version, provenance_id, calculated_at
        ) VALUES ($1, 'hub', $2, 'all', 'momentum.change7d', $3, $4, $5, $6, $7, $8)`,
        [
          snapshotDate,
          dataset.hub.id,
          dataset.portfolio.momentum.value.change7d,
          dataset.portfolio.momentum.provenance.valueKind,
          dataset.portfolioCalculation.risk.coverage,
          RISK_CONFIGURATION_ID,
          portfolioMomentumProvenanceId,
          dataset.portfolio.momentum.provenance.calculatedAt,
        ],
      );

      await pruneStaleDemoEntities(database, dataset);
      await database.exec("COMMIT");
    } catch (error) {
      await database.exec("ROLLBACK");
      throw error;
    }

    const counts = await database.query<{
      projects: number;
      companies: number;
      records: number;
      project_snapshots: number;
      company_snapshots: number;
      provenance: number;
      identity_collisions: number;
      invalid_attributions: number;
      trade_mismatches: number;
      invalid_record_factor_scopes: number;
    }>(`SELECT
      (SELECT count(*)::int FROM projects WHERE hub_id = $1) AS projects,
      (SELECT count(*)::int FROM companies WHERE hub_id = $1) AS companies,
      (SELECT count(*)::int FROM source_records WHERE project_id IN (SELECT id FROM projects WHERE hub_id = $1)) AS records,
      (SELECT count(*)::int FROM project_risk_snapshots WHERE project_id IN (SELECT id FROM projects WHERE hub_id = $1)) AS project_snapshots,
      (SELECT count(*)::int FROM subcontractor_risk_snapshots WHERE project_id IN (SELECT id FROM projects WHERE hub_id = $1)) AS company_snapshots,
      (SELECT count(*)::int FROM data_provenance WHERE ingestion_job_id = $2) AS provenance,
      (SELECT count(*)::int
         FROM users AS u
         JOIN companies AS c ON c.id = u.id AND c.hub_id = u.hub_id
        WHERE u.hub_id = $1) AS identity_collisions,
      (SELECT count(*)::int
         FROM source_records AS r
        WHERE r.project_id IN (SELECT id FROM projects WHERE hub_id = $1)
          AND (
            (r.company_attribution = 'unattributed' AND r.company_id IS NOT NULL)
            OR (r.company_attribution = 'direct' AND (
              r.company_id IS NULL OR (r.kind = 'issue' AND (r.assignee_type IS DISTINCT FROM 'company' OR r.assignee_id IS DISTINCT FROM r.company_id))
            ))
            OR (r.company_attribution = 'via-assignee-membership' AND (
              r.company_id IS NULL OR r.assignee_id IS NULL OR r.assignee_type IS DISTINCT FROM 'user'
              OR NOT EXISTS (
                SELECT 1 FROM project_users AS pu
                 WHERE pu.project_id = r.project_id AND pu.user_id = r.assignee_id AND pu.company_id = r.company_id
              )
            ))
            OR (r.company_attribution = 'via-owner-membership' AND (
              r.company_id IS NULL OR r.owner_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM project_users AS pu
                 WHERE pu.project_id = r.project_id AND pu.user_id = r.owner_id AND pu.company_id = r.company_id
              )
            ))
          )) AS invalid_attributions,
      (SELECT count(*)::int
         FROM subcontractor_risk_snapshots AS snapshot
         JOIN companies AS company
           ON company.id = snapshot.company_id
          AND company.hub_id = $1
        WHERE snapshot.project_id IN (SELECT id FROM projects WHERE hub_id = $1)
          AND snapshot.trade_primary IS DISTINCT FROM company.trade_primary) AS trade_mismatches,
      (SELECT count(*)::int
         FROM risk_factors AS factor
        WHERE factor.scope_type = 'record'
          AND factor.provenance_id IN (
            SELECT id FROM data_provenance WHERE ingestion_job_id = $2
          )
          AND NOT EXISTS (
            SELECT 1
              FROM source_records AS record
             WHERE factor.scope_id = record.project_id || chr(31) || record.kind || chr(31) || record.id
          )) AS invalid_record_factor_scopes`, [dataset.hub.id, dataset.ingestion.id]);
    const row = counts.rows[0];
    if (!row) throw new Error("Seed completed without count verification.");
    const expectedCompanySnapshots = new Set([
      ...dataset.records.filter((record) => record.companyId).map((record) => `${record.projectId}:${record.companyId}`),
      ...dataset.companyCiqSignals.map((signal) => `${signal.projectId}:${signal.companyId}`),
    ]).size;
    if (row.identity_collisions !== 0) throw new Error(`Seed verification found ${row.identity_collisions} user/company identity collision(s).`);
    if (row.invalid_attributions !== 0) throw new Error(`Seed verification found ${row.invalid_attributions} invalid company attribution row(s).`);
    if (row.trade_mismatches !== 0) throw new Error(`Seed verification found ${row.trade_mismatches} subcontractor trade mismatch(es).`);
    if (row.invalid_record_factor_scopes !== 0) throw new Error(`Seed verification found ${row.invalid_record_factor_scopes} ambiguous record factor scope(s).`);
    if (row.company_snapshots !== expectedCompanySnapshots) {
      throw new Error(`Seed verification expected ${expectedCompanySnapshots} company snapshots but found ${row.company_snapshots}.`);
    }
    console.log(
      `Seeded ${row.projects} projects, ${row.companies} companies, ${row.records} records, ` +
      `${row.project_snapshots} project snapshots, ${row.company_snapshots} company snapshots, ` +
      `and ${row.provenance} provenance rows into ${location}.`,
    );
  } finally {
    await database.close();
  }
}

seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Demo seed failed: ${message}`);
  process.exitCode = 1;
});
