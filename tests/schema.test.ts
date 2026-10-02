import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { appendAuditEvent } from "../src/lib/audit";
import { recordIdentityKey } from "../src/lib/canonical/types";
import { applyMigrationPlan } from "../src/lib/db/migration-plan";
import { SqlDataConnectorBudgetGate } from "../src/lib/providers/data-connector-budget-gate";
import type { Sql, SqlExecutor, SqlResult, SqlValue } from "../src/lib/db/sql";

function executor(database: Pick<PGlite, "query" | "exec">): SqlExecutor {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []): Promise<SqlResult<Row>> {
      const result = await database.query<Row>(text, [...values] as unknown[]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(text: string): Promise<void> {
      await database.exec(text);
    },
  };
}

test("canonical schema executes on PGlite and creates core tables", async () => {
  const database = new PGlite();
  const schema = await readFile(path.join(process.cwd(), "src/lib/db/schema.sql"), "utf8");
  await database.exec(schema);
  const result = await database.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const tables = new Set(result.rows.map((row) => row.tablename));
  for (const table of ["hubs", "aps_sessions", "projects", "source_records", "risk_snapshots", "data_provenance", "column_report"]) {
    assert.ok(tables.has(table), `expected ${table}`);
  }
  await database.close();
});

test("0013 reconstructs model risk for populated legacy classifications", async () => {
  const database = new PGlite();
  const schema = await readFile(path.join(process.cwd(), "src/lib/db/schema.sql"), "utf8");
  const run = () => applyMigrationPlan(
    executor(database),
    (work) => database.transaction((transaction) => work(executor(transaction))),
    schema,
  );
  await run();

  await database.exec(`
    DELETE FROM schema_migrations WHERE id = '0013_project_scoped_source_identity';
    ALTER TABLE rfi_transitions DROP CONSTRAINT rfi_transitions_project_rfi_fkey;
    ALTER TABLE form_answers DROP CONSTRAINT form_answers_project_form_fkey;
    ALTER TABLE form_answers DROP CONSTRAINT form_answers_project_native_form_fkey;
    ALTER TABLE review_tasks DROP CONSTRAINT review_tasks_project_review_fkey;
    ALTER TABLE locations DROP CONSTRAINT locations_project_parent_fkey;
    ALTER TABLE source_records DROP CONSTRAINT source_records_ciq_model_risk_check;
    ALTER TABLE source_records DROP COLUMN ciq_model_risk;

    INSERT INTO hubs (id, name, region) VALUES ('hub-risk-legacy', 'Legacy risk hub', 'US');
    INSERT INTO projects (id, hub_id, name, type)
      VALUES ('project-risk-legacy', 'hub-risk-legacy', 'Legacy risk project', 'production');
    INSERT INTO source_records (
      kind, id, project_id, title, status, status_normalized, open,
      domain, ciq_risk, ciq_risk_user_override, ciq_cost_impact,
      company_attribution, created_at, raw, fingerprint, first_seen_at, last_seen_at
    ) VALUES
      (
        'issue', 'legacy-model-effective', 'project-risk-legacy', 'Legacy effective model',
        'open', 'open', true, 'quality', 'high', false, 'none', 'unattributed',
        '2026-09-01T00:00:00Z', '{}'::jsonb, 'legacy-model-effective',
        '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
      ),
      (
        'issue', 'legacy-user-override', 'project-risk-legacy', 'Legacy human override',
        'open', 'open', true, 'quality', 'low', true, 'none', 'unattributed',
        '2026-09-01T00:00:00Z', '{"risk":"High","user_risk":"Low"}'::jsonb,
        'legacy-user-override', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
      ),
      (
        'rfi', 'legacy-unmapped-model', 'project-risk-legacy', 'Legacy unmapped model',
        'open', 'open', true, 'rfi', 'high', true, 'none', 'unattributed',
        '2026-09-01T00:00:00Z', '{"risk":"provider-new-band","user_risk":"high"}'::jsonb,
        'legacy-unmapped-model', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
      );
  `);

  await run();
  const rows = await database.query<{ id: string; model: string; effective: string; overridden: boolean }>(`
    SELECT id, ciq_model_risk AS model, ciq_risk AS effective,
      ciq_risk_user_override AS overridden
    FROM source_records
    WHERE project_id = 'project-risk-legacy'
    ORDER BY id
  `);
  assert.deepEqual(rows.rows, [
    { id: "legacy-model-effective", model: "high", effective: "high", overridden: false },
    { id: "legacy-unmapped-model", model: "unmapped", effective: "high", overridden: true },
    { id: "legacy-user-override", model: "high", effective: "low", overridden: true },
  ]);
  await database.close();
});

test("cause and discipline migration upgrades populated 0013 rows without inventing provenance", async () => {
  const database = new PGlite();
  const schema = await readFile(path.join(process.cwd(), "src/lib/db/schema.sql"), "utf8");
  const run = () => applyMigrationPlan(
    executor(database),
    (work) => database.transaction((transaction) => work(executor(transaction))),
    schema,
  );

  // Recreate the exact pre-0014 shape after bootstrapping the immutable plan.
  await run();
  await database.exec(`
    DELETE FROM schema_migrations WHERE id = '0014_cause_and_discipline_identity';
    ALTER TABLE source_records DROP CONSTRAINT source_records_discipline_origin_consistency_check;
    ALTER TABLE source_records DROP CONSTRAINT source_records_discipline_origin_check;
    ALTER TABLE source_records DROP COLUMN discipline_origin;
    ALTER TABLE source_records DROP COLUMN root_cause_id;
    ALTER TABLE rfis DROP COLUMN operational_discipline;

    INSERT INTO hubs (id, name, region) VALUES ('hub-legacy', 'Legacy hub', 'US');
    INSERT INTO projects (id, hub_id, name, type)
      VALUES ('project-legacy', 'hub-legacy', 'Legacy project', 'production');
    INSERT INTO source_records (
      kind, id, project_id, title, status, status_normalized, open,
      domain, discipline, ciq_risk, ciq_cost_impact, company_attribution,
      created_at, cost_impact, schedule_impact, raw, fingerprint, first_seen_at, last_seen_at
    ) VALUES
      (
        'issue', 'issue-with-discipline', 'project-legacy', 'Legacy discipline', 'open', 'open', true,
        'quality', 'Mechanical', 'unmapped', 'unmapped', 'unattributed',
        '2026-09-09T00:00:00Z', 'unknown', 'unknown', '{}'::jsonb, 'legacy-with-discipline',
        '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z'
      ),
      (
        'issue', 'issue-without-discipline', 'project-legacy', 'No discipline', 'open', 'open', true,
        'quality', NULL, 'unmapped', 'unmapped', 'unattributed',
        '2026-09-09T00:00:00Z', 'unknown', 'unknown', '{}'::jsonb, 'legacy-without-discipline',
        '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z'
      );
    INSERT INTO issues (issue_id, project_id, title, root_cause_id, fingerprint)
      VALUES (
        'issue-with-discipline', 'project-legacy', 'Legacy discipline',
        'project-legacy-root-cause-17', 'legacy-typed-issue'
      );
  `);

  await run();

  const rows = await database.query<{
    id: string;
    root_cause_id: string | null;
    discipline: string | null;
    discipline_origin: string | null;
  }>(
    `SELECT id, root_cause_id, discipline, discipline_origin
       FROM source_records
      WHERE project_id = 'project-legacy'
      ORDER BY id`,
  );
  assert.deepEqual(rows.rows, [
    {
      id: "issue-with-discipline",
      root_cause_id: "project-legacy-root-cause-17",
      discipline: "Mechanical",
      discipline_origin: "unmapped",
    },
    {
      id: "issue-without-discipline",
      root_cause_id: null,
      discipline: null,
      discipline_origin: null,
    },
  ]);
  await database.close();
});

test("relationship migration preserves a populated recommendation's provenance algorithm", async () => {
  const database = new PGlite();
  const schema = await readFile(path.join(process.cwd(), "src/lib/db/schema.sql"), "utf8");
  const run = () => applyMigrationPlan(
    executor(database),
    (work) => database.transaction((transaction) => work(executor(transaction))),
    schema,
  );

  await run();
  await database.exec(`
    DELETE FROM schema_migrations WHERE id = '0017_version_relationships_and_recommendations';
    DROP TRIGGER IF EXISTS mitigation_recommendations_provenance_consistency ON mitigation_recommendations;
    DROP TRIGGER IF EXISTS mitigation_recommendations_live_append_only ON mitigation_recommendations;
    DROP TRIGGER IF EXISTS mitigation_recommendations_no_truncate ON mitigation_recommendations;
    ALTER TABLE mitigation_recommendations DROP CONSTRAINT mitigation_recommendations_pkey;
    ALTER TABLE mitigation_recommendations DROP COLUMN algorithm_version;
    ALTER TABLE mitigation_recommendations ADD PRIMARY KEY (id);

    INSERT INTO hubs (id, name, region) VALUES ('hub-recommendation-legacy', 'Legacy hub', 'US');
    INSERT INTO projects (id, hub_id, name, type)
      VALUES ('project-recommendation-legacy', 'hub-recommendation-legacy', 'Legacy project', 'production');
    INSERT INTO data_provenance (
      id, source_system, source_dataset, source_record_id, project_id,
      extracted_at, calculated_at, definition_id, definition_version,
      algorithm_version, value_kind, input_digest, inputs, result
    ) VALUES (
      'provenance-recommendation-v7', 'forma-risk-radar', 'legacy-recommendations',
      'recommendation-populated', 'project-recommendation-legacy',
      '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z',
      'mitigation.legacy', '1.0.0', 'risk-model-v7', 'application-derived',
      'recommendation-populated-v7', '{"legacyMigration":true}'::jsonb, '{"state":"populated"}'::jsonb
    );
    INSERT INTO mitigation_recommendations (
      id, snapshot_date, project_id, title, detail, origin, evidence, provenance_id
    ) VALUES (
      'recommendation-populated', '2026-09-08', 'project-recommendation-legacy',
      'Legacy recommendation', 'Retain the provenance algorithm during migration.',
      'deterministic-rule', '[]'::jsonb, 'provenance-recommendation-v7'
    );
  `);

  await run();

  const migrated = await database.query<{ algorithm_version: string }>(
    `SELECT algorithm_version
       FROM mitigation_recommendations
      WHERE id = 'recommendation-populated' AND snapshot_date = '2026-09-08'`,
  );
  assert.deepEqual(migrated.rows, [{ algorithm_version: "risk-model-v7" }]);

  await database.exec(`
    INSERT INTO data_provenance (
      id, source_system, source_dataset, source_record_id, project_id,
      extracted_at, calculated_at, definition_id, definition_version,
      algorithm_version, value_kind, input_digest, inputs, result
    ) VALUES (
      'provenance-recommendation-v8', 'forma-risk-radar', 'legacy-recommendations',
      'recommendation-populated', 'project-recommendation-legacy',
      '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z',
      'mitigation.legacy', '1.0.0', 'risk-model-v8', 'application-derived',
      'recommendation-populated-v8', '{"legacyMigration":true}'::jsonb, '{"state":"versioned"}'::jsonb
    );
    INSERT INTO mitigation_recommendations (
      id, snapshot_date, project_id, title, detail, origin, evidence,
      provenance_id, algorithm_version
    ) VALUES (
      'recommendation-populated', '2026-09-08', 'project-recommendation-legacy',
      'Versioned recommendation', 'Composite history remains insertable.',
      'deterministic-rule', '[]'::jsonb, 'provenance-recommendation-v8', 'risk-model-v8'
    );
  `);

  await run();
  const versions = await database.query<{ algorithm_version: string }>(
    `SELECT algorithm_version
       FROM mitigation_recommendations
      WHERE id = 'recommendation-populated' AND snapshot_date = '2026-09-08'
      ORDER BY algorithm_version`,
  );
  assert.deepEqual(versions.rows.map((row) => row.algorithm_version), ["risk-model-v7", "risk-model-v8"]);
  await database.close();
});

test("versioned migrations upgrade the pre-enum-drift schema and remain idempotent", async () => {
  const database = new PGlite();
  const schema = await readFile(path.join(process.cwd(), "src/lib/db/schema.sql"), "utf8");
  const run = () => applyMigrationPlan(
    executor(database),
    (work) => database.transaction((transaction) => work(executor(transaction))),
    schema,
  );

  await run();
  await database.exec(`
    DELETE FROM schema_migrations WHERE id = '0002_retain_unmapped_ciq_enums';
    UPDATE schema_migrations
      SET checksum = 'deb2eab2fe16da8eff77dc2c50491668909ce4d19d39fb21670fd5f76f9a7da5'
      WHERE id = '0001_canonical_risk_model';
    ALTER TABLE source_records DROP CONSTRAINT source_records_ciq_risk_check;
    ALTER TABLE source_records
      ADD CONSTRAINT source_records_ciq_risk_check
      CHECK (ciq_risk IN ('high','medium','low','none'));
    ALTER TABLE source_records DROP CONSTRAINT source_records_ciq_cost_impact_check;
    ALTER TABLE source_records
      ADD CONSTRAINT source_records_ciq_cost_impact_check
      CHECK (ciq_cost_impact IN ('high','medium','low','none'));
  `);

  await run();
  await run();

  const migrations = await database.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
  assert.deepEqual(migrations.rows.map((row) => row.id), [
    "0001_canonical_risk_model",
    "0002_retain_unmapped_ciq_enums",
    "0003_append_only_audit_log",
    "0004_provenance_integrity_and_audit_truncate_guard",
    "0005_live_history_immutability",
    "0006_preserve_forms_source_identity",
    "0007_atomic_data_connector_budget_ledger",
    "0008_snapshot_forward_fill_metadata",
    "0009_source_record_attribution_integrity",
    "0010_company_ciq_change_log_contract",
    "0011_bounded_session_lifetimes",
    "0012_company_ciq_provenance_integrity",
    "0013_project_scoped_source_identity",
    "0014_cause_and_discipline_identity",
    "0015_retain_unmapped_rfi_impact_values",
    "0016_project_phase_and_business_units",
    "0017_version_relationships_and_recommendations",
    "0018_canonical_sidecars_and_actor_labels",
  ]);
  const sourceRecordColumns = await database.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'source_records'`,
  );
  const sourceRecordColumnNames = new Set(sourceRecordColumns.rows.map((row) => row.column_name));
  assert.ok(sourceRecordColumnNames.has("root_cause_id"));
  assert.ok(sourceRecordColumnNames.has("discipline_origin"));
  for (const column of [
    "rfi_category", "ciq_root_cause_model", "ciq_root_cause_user_override",
    "ciq_building_component_model", "ciq_building_component_user_override",
    "ciq_safety_risk_category", "ciq_safety_risk_predicted_at",
    "ciq_safety_hazard_category", "ciq_safety_hazard_predicted_at",
    "ciq_safety_observation_category", "ciq_safety_observation_predicted_at",
    "assignee_name", "owner_name",
  ]) assert.ok(sourceRecordColumnNames.has(column), `expected source record column ${column}`);
  const rfiColumns = await database.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'rfis'`,
  );
  for (const column of ["operational_discipline", "operational_category"]) {
    assert.ok(rfiColumns.rows.some((row) => row.column_name === column), `expected RFI column ${column}`);
  }
  const issueColumns = await database.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'issues'`,
  );
  for (const column of [
    "iq_design_user_root_cause", "iq_design_user_building_component",
    "iq_safety_risk_predicted_at", "iq_safety_hazard_predicted_at",
    "iq_safety_observation_predicted_at",
  ]) assert.ok(issueColumns.rows.some((row) => row.column_name === column), `expected Issue column ${column}`);
  const companySnapshotColumns = await database.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_name = 'subcontractor_risk_snapshots'`,
  );
  const companyColumnTypes = new Map(companySnapshotColumns.rows.map((row) => [row.column_name, row.data_type]));
  for (const column of [
    "ciq_quality_daily_risk", "ciq_quality_daily_indicator", "ciq_quality_observed_at",
    "ciq_quality_forward_filled", "ciq_safety_daily_risk", "ciq_safety_daily_indicator",
    "ciq_safety_observed_at", "ciq_safety_forward_filled", "ciq_not_applicable",
    "derived_risk_index", "open_attributed", "overdue_attributed", "high_risk_attributed",
    "trade_primary", "calculated_at", "source_extracted_at",
    "ciq_quality_provenance_id", "ciq_safety_provenance_id",
  ]) assert.ok(companyColumnTypes.has(column), `expected subcontractor snapshot column ${column}`);
  assert.equal(companyColumnTypes.get("ciq_safety_daily_risk"), "numeric");
  assert.equal(companyColumnTypes.has("ciq_quality_risk"), false);
  assert.equal(companyColumnTypes.has("ciq_safety_risk"), false);
  await database.exec(
    `INSERT INTO hubs (id, name, region) VALUES ('hub-test', 'Test', 'US');
     INSERT INTO projects (id, hub_id, name, type) VALUES ('project-test', 'hub-test', 'Test', 'production');
     INSERT INTO source_records (
       kind, id, project_id, title, status, status_normalized, open,
       domain, ciq_risk, ciq_cost_impact, company_attribution,
       created_at, cost_impact, schedule_impact, raw, fingerprint, first_seen_at, last_seen_at
     ) VALUES (
       'issue', 'issue-test', 'project-test', 'Test', 'open', 'open', true,
       'quality', 'unmapped', 'unmapped', 'unattributed',
       '2026-09-09T00:00:00Z', 'unknown', 'unknown', '{}'::jsonb, 'fingerprint-test',
       '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z'
     )`,
  );
  await assert.rejects(
    database.exec("UPDATE source_records SET discipline = 'Mechanical' WHERE project_id = 'project-test' AND id = 'issue-test'"),
    /source_records_discipline_origin_consistency_check/u,
  );
  await assert.rejects(
    database.exec("UPDATE source_records SET discipline = 'Mechanical', discipline_origin = 'invented' WHERE project_id = 'project-test' AND id = 'issue-test'"),
    /source_records_discipline_origin_check/u,
  );
  await database.exec("UPDATE source_records SET discipline = 'Mechanical', discipline_origin = 'construction-iq' WHERE project_id = 'project-test' AND id = 'issue-test'");
  await database.exec("INSERT INTO companies (id, hub_id, name) VALUES ('company-test', 'hub-test', 'Test company')");
  await assert.rejects(
    database.exec(
      "UPDATE source_records SET company_id = 'company-test', company_attribution = 'invented' WHERE id = 'issue-test'",
    ),
    /source_records_company_attribution_check/u,
  );
  await assert.rejects(
    database.exec(
      "UPDATE source_records SET company_id = 'company-test', company_attribution = 'via-assignee-membership' WHERE id = 'issue-test'",
    ),
    /source_records_company_attribution_consistency_check/u,
  );
  await assert.rejects(
    database.exec(
      "UPDATE source_records SET company_id = 'company-test', company_attribution = 'direct', assignee_id = 'user-test', assignee_type = 'user' WHERE id = 'issue-test'",
    ),
    /source_records_company_attribution_consistency_check/u,
  );
  const sql = executor(database);
  const auditId = await appendAuditEvent(sql, {
    actorId: "system",
    sessionId: "opaque-session-id",
    action: "test.schema-migration",
    scopeType: "project",
    scopeId: "project-test",
    outcome: "succeeded",
    correlationId: "00000000-0000-4000-8000-000000000001",
    occurredAt: "2026-09-09T00:00:00.000Z",
  });
  const audit = await database.query<{ action: string; scope_id: string }>(
    "SELECT action, scope_id FROM audit_log WHERE id = $1",
    [auditId],
  );
  assert.deepEqual(audit.rows[0], {
    action: "test.schema-migration",
    scope_id: "project-test",
  });
  await assert.rejects(
    database.query("UPDATE audit_log SET outcome = 'failed' WHERE id = $1", [auditId]),
    /append-only/u,
  );
  await assert.rejects(
    database.query("DELETE FROM audit_log WHERE id = $1", [auditId]),
    /append-only/u,
  );
  await assert.rejects(database.exec("TRUNCATE audit_log"), /append-only/u);
  await assert.rejects(
    database.query(
      `INSERT INTO data_provenance (
        id, source_system, source_dataset, extracted_at, calculated_at,
        definition_id, definition_version, algorithm_version, value_kind,
        autodesk_term, input_digest, inputs, result
      ) VALUES (
        'invalid-derived-attribution', 'forma-risk-radar', 'test', now(), now(),
        'test.invalid', '1', 'risk-model-v1', 'application-derived',
        'Autodesk Risk', 'digest-invalid', '{}'::jsonb, '{}'::jsonb
      )`,
    ),
    /data_provenance_autodesk_term_origin_check/u,
  );
  await database.exec(
    `INSERT INTO data_provenance (
        id, source_system, source_dataset, project_id, extracted_at, calculated_at,
        definition_id, definition_version, algorithm_version, value_kind,
        input_digest, inputs, result
      ) VALUES (
      'valid-provenance', 'forma-risk-radar', 'test', 'project-test', now(), now(),
      'subcontractor.contextual-counts', '1', 'risk-model-v1', 'application-derived',
      'digest-valid', '{}'::jsonb, '{}'::jsonb
    )`,
  );
  await database.exec(
    `INSERT INTO project_risk_snapshots (
       snapshot_date, project_id, domain, ciq_not_applicable, coverage,
       algorithm_version, provenance_id
     ) VALUES (
       '2026-09-09', 'project-test', 'all', false, 1,
       'risk-model-v1', 'valid-provenance'
     )`,
  );
  await database.exec(
    `INSERT INTO data_provenance (
       id, source_system, source_dataset, project_id, extracted_at, calculated_at,
       definition_id, definition_version, algorithm_version, value_kind,
       input_digest, inputs, result
     ) VALUES
       ('other-project-provenance', 'forma-risk-radar', 'test', NULL, now(), now(),
        'relationship.test', '1', 'risk-model-v1', 'application-derived',
        'digest-other-project', '{}'::jsonb, '{}'::jsonb),
       ('other-algorithm-provenance', 'forma-risk-radar', 'test', 'project-test', now(), now(),
        'relationship.test', '1', 'risk-model-v2', 'application-derived',
        'digest-other-algorithm', '{}'::jsonb, '{}'::jsonb)`,
  );
  await database.exec(
    `INSERT INTO data_provenance (
      id, source_system, source_dataset, source_record_id, project_id,
      extracted_at, calculated_at, definition_id, definition_version,
      algorithm_version, value_kind, autodesk_term, input_digest, inputs, result
    ) VALUES
      (
        'quality-provenance', 'acc-data-connector',
        'iq_company_daily_quality_risk_changes', 'quality-row', 'project-test',
        now(), now(), 'ciq.company.quality.daily-risk', '1',
        'risk-model-v1', 'autodesk-provided', 'Company Daily Risk',
        'digest-quality', '{}'::jsonb, '{}'::jsonb
      ),
      (
        'safety-provenance', 'acc-data-connector',
        'iq_company_daily_safety_risk_changes', 'safety-row', 'project-test',
        now(), now(), 'ciq.company.safety.daily-risk', '1',
        'risk-model-v1', 'autodesk-provided', 'Company Daily Safety Risk',
        'digest-safety', '{}'::jsonb, '{}'::jsonb
      ),
      (
        'wrong-quality-provenance', 'acc-data-connector',
        'iq_company_daily_safety_risk_changes', 'wrong-row', 'project-test',
        now(), now(), 'ciq.company.quality.wrong-dataset', '1',
        'risk-model-v1', 'autodesk-provided', 'Company Daily Safety Risk',
        'digest-wrong-quality', '{}'::jsonb, '{}'::jsonb
      )`,
  );
  await database.exec(
    `INSERT INTO subcontractor_risk_snapshots (
       snapshot_date, company_id, project_id,
       ciq_quality_daily_risk, ciq_quality_daily_indicator, ciq_quality_observed_at,
       ciq_quality_forward_filled, ciq_safety_daily_risk, ciq_safety_daily_indicator,
       ciq_safety_observed_at, ciq_safety_forward_filled, ciq_not_applicable,
       algorithm_version, calculated_at, provenance_id,
       ciq_quality_provenance_id, ciq_safety_provenance_id
     ) VALUES (
       '2026-09-09', 'company-test', 'project-test',
       'Low', 1, '2026-09-01', true, 1.25, 2,
       '2026-09-09', false, false,
       'risk-model-v1', now(), 'valid-provenance',
       'quality-provenance', 'safety-provenance'
     )`,
  );
  const companySnapshot = await database.query<{ quality: string; safety: string; carried: boolean }>(
    `SELECT ciq_quality_daily_risk AS quality,
            ciq_safety_daily_risk::text AS safety,
            ciq_quality_forward_filled AS carried
       FROM subcontractor_risk_snapshots
      WHERE company_id = 'company-test'`,
  );
  assert.deepEqual(companySnapshot.rows[0], { quality: "Low", safety: "1.25", carried: true });
  await database.exec(
    `INSERT INTO companies (id, hub_id, name) VALUES ('company-no-ciq-row', 'hub-test', 'No current company signal');
     INSERT INTO subcontractor_risk_snapshots (
       snapshot_date, company_id, project_id, ciq_not_applicable,
       algorithm_version, calculated_at, provenance_id
     ) VALUES (
       '2026-09-09', 'company-no-ciq-row', 'project-test', false,
       'risk-model-v1', now(), 'valid-provenance'
     )`,
  );
  await assert.rejects(
    database.exec(
      `INSERT INTO companies (id, hub_id, name) VALUES ('company-wrong-project-ciq', 'hub-test', 'Wrong project CIQ flag');
       INSERT INTO subcontractor_risk_snapshots (
         snapshot_date, company_id, project_id, ciq_not_applicable,
         algorithm_version, calculated_at, provenance_id
       ) VALUES (
         '2026-09-09', 'company-wrong-project-ciq', 'project-test', true,
         'risk-model-v1', now(), 'valid-provenance'
       )`,
    ),
    /must match project eligibility/u,
  );
  await assert.rejects(
    database.exec(
      `INSERT INTO subcontractor_risk_snapshots (
         snapshot_date, company_id, project_id, ciq_not_applicable,
         ciq_quality_daily_risk, ciq_quality_observed_at, algorithm_version, calculated_at,
         provenance_id, ciq_quality_provenance_id
       ) VALUES (
         '2026-09-07', 'company-test', 'project-test', false,
         'Low', '2026-09-07', 'risk-model-v1', now(),
         'valid-provenance', 'valid-provenance'
       )`,
    ),
    /Autodesk quality-change provenance/u,
  );
  await assert.rejects(
    database.exec(
      `INSERT INTO subcontractor_risk_snapshots (
         snapshot_date, company_id, project_id, ciq_not_applicable,
         ciq_quality_daily_risk, ciq_quality_observed_at, algorithm_version, calculated_at,
         provenance_id, ciq_quality_provenance_id
       ) VALUES (
         '2026-09-06', 'company-test', 'project-test', false,
         'Low', '2026-09-06', 'risk-model-v1', now(),
         'valid-provenance', 'wrong-quality-provenance'
       )`,
    ),
    /Autodesk quality-change provenance/u,
  );
  await assert.rejects(
    database.exec(
      `INSERT INTO subcontractor_risk_snapshots (
         snapshot_date, company_id, project_id, ciq_not_applicable,
         ciq_quality_daily_risk, algorithm_version, calculated_at, provenance_id
       ) VALUES (
         '2026-09-08', 'company-test', 'project-test', true,
         'Low', 'risk-model-v1', now(), 'valid-provenance'
       )`,
    ),
    /quality signal requires|not-applicable/u,
  );

  await database.exec(
    `INSERT INTO projects (id, hub_id, name, type)
       VALUES ('project-test-2', 'hub-test', 'Test 2', 'production');
     INSERT INTO source_records (
       kind, id, project_id, title, status, status_normalized, open,
       domain, ciq_model_risk, ciq_risk, ciq_cost_impact, company_attribution,
       created_at, raw, fingerprint, first_seen_at, last_seen_at
     ) VALUES (
       'issue', 'issue-test', 'project-test-2', 'Collision-safe', 'open', 'open', true,
       'quality', 'high', 'low', 'none', 'unattributed',
       '2026-09-09T00:00:00Z', '{}'::jsonb, 'fingerprint-test-2',
       '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z'
     );
     INSERT INTO issues (issue_id, project_id, title, fingerprint)
       VALUES ('shared-native-id', 'project-test', 'First', 'typed-1'),
              ('shared-native-id', 'project-test-2', 'Second', 'typed-2')`,
  );
  const identityCounts = await database.query<{ source_count: number; typed_count: number }>(
    `SELECT
       (SELECT count(*)::int FROM source_records WHERE kind = 'issue' AND id = 'issue-test') AS source_count,
       (SELECT count(*)::int FROM issues WHERE issue_id = 'shared-native-id') AS typed_count`,
  );
  assert.deepEqual(identityCounts.rows[0], { source_count: 2, typed_count: 2 });
  const collidingRecordFactorScopes = [
    recordIdentityKey({ projectId: "project-test", kind: "issue", id: "issue-test" }),
    recordIdentityKey({ projectId: "project-test-2", kind: "issue", id: "issue-test" }),
  ];
  await database.query(
    `INSERT INTO risk_factors (
       snapshot_date, scope_type, scope_id, domain, factor_id, points,
       detail, algorithm_version, provenance_id
     ) VALUES
       ('2026-09-09', 'record', $1, 'quality', 'COLLISION_REGRESSION', 1,
        'first project', 'risk-model-v1', 'valid-provenance'),
       ('2026-09-09', 'record', $2, 'quality', 'COLLISION_REGRESSION', 1,
        'second project', 'risk-model-v1', 'valid-provenance')`,
    collidingRecordFactorScopes,
  );
  const persistedFactorScopes = await database.query<{ scope_id: string }>(
    `SELECT scope_id
       FROM risk_factors
      WHERE scope_type = 'record' AND factor_id = 'COLLISION_REGRESSION'
      ORDER BY scope_id`,
  );
  assert.deepEqual(
    persistedFactorScopes.rows.map((row) => row.scope_id),
    [...collidingRecordFactorScopes].sort(),
  );
  await assert.rejects(
    database.exec(
      `INSERT INTO risk_snapshots (
        snapshot_date, scope, scope_id, domain, metric_id, value, value_kind,
        coverage, algorithm_version, provenance_id, calculated_at
      ) VALUES (
        '2026-09-09', 'hub', 'hub-test', 'all', 'test.coverage', 1,
        'application-derived', 1.1, 'risk-model-v1', 'valid-provenance', now()
      )`,
    ),
    /risk_snapshots_coverage_bounds_check/u,
  );
  await assert.rejects(
    database.exec(
      `INSERT INTO risk_snapshots (
        snapshot_date, scope, scope_id, domain, metric_id, value, value_kind,
        coverage, algorithm_version, provenance_id, calculated_at
      ) VALUES (
        '2026-09-09', 'hub', 'hub-test', 'all', 'test.kind', 1,
        'autodesk-provided', 1, 'risk-model-v1', 'valid-provenance', now()
      )`,
    ),
    /value_kind does not match provenance/u,
  );
  await database.exec(
    `INSERT INTO risk_factors (
      snapshot_date, scope_type, scope_id, domain, factor_id, value, points,
      detail, algorithm_version, provenance_id
    ) VALUES (
      '2026-09-09', 'project', 'project-test', 'all', 'test.factor', 1, 1,
      'trigger compatibility', 'risk-model-v1', 'valid-provenance'
    )`,
  );
  await assert.rejects(
    database.exec("UPDATE data_provenance SET algorithm_version = 'tampered' WHERE id = 'valid-provenance'"),
    /data_provenance is append-only/u,
  );
  await assert.rejects(
    database.exec("DELETE FROM risk_factors WHERE provenance_id = 'valid-provenance'"),
    /historical risk rows are append-only/u,
  );
  await database.exec(
    `INSERT INTO risk_relationships (
       id, project_id, from_kind, from_id, to_kind, to_id, confidence, method,
       evidence, snapshot_date, algorithm_version, provenance_id
     ) VALUES
       ('relationship-history', 'project-test', 'issue', 'issue-a', 'rfi', 'rfi-a',
        'confirmed', 'explicit-link', 'first snapshot', '2026-09-08', 'risk-model-v1', 'valid-provenance'),
       ('relationship-history', 'project-test', 'issue', 'issue-a', 'rfi', 'rfi-a',
        'confirmed', 'explicit-link', 'second snapshot', '2026-09-09', 'risk-model-v1', 'valid-provenance')`,
  );
  const relationshipHistory = await database.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM risk_relationships WHERE id = 'relationship-history'",
  );
  assert.equal(relationshipHistory.rows[0]?.count, 2);
  await assert.rejects(
    database.exec(
      `INSERT INTO risk_relationships (
         id, project_id, from_kind, from_id, to_kind, to_id, confidence, method,
         evidence, snapshot_date, algorithm_version, provenance_id
       ) VALUES ('bad-project', 'project-test', 'issue', 'a', 'rfi', 'b',
         'confirmed', 'explicit-link', 'bad project', '2026-09-09', 'risk-model-v1', 'other-project-provenance')`,
    ),
    /project_id does not match provenance/u,
  );
  await assert.rejects(
    database.exec(
      `INSERT INTO mitigation_recommendations (
         id, snapshot_date, project_id, title, detail, origin, evidence,
         provenance_id, algorithm_version
       ) VALUES ('bad-algorithm', '2026-09-09', 'project-test', 'Test', 'Test',
         'deterministic-rule', '[]'::jsonb, 'other-algorithm-provenance', 'risk-model-v1')`,
    ),
    /algorithm_version does not match provenance/u,
  );
  await database.exec(
    `INSERT INTO mitigation_recommendations (
       id, snapshot_date, project_id, title, detail, origin, evidence,
       provenance_id, algorithm_version
     ) VALUES ('recommendation-history', '2026-09-09', 'project-test', 'Test', 'Test',
       'deterministic-rule', '[]'::jsonb, 'valid-provenance', 'risk-model-v1')`,
  );
  await assert.rejects(
    database.exec("UPDATE risk_relationships SET evidence = 'tampered' WHERE id = 'relationship-history'"),
    /historical risk rows are append-only/u,
  );
  await assert.rejects(
    database.exec("DELETE FROM mitigation_recommendations WHERE id = 'recommendation-history'"),
    /historical risk rows are append-only/u,
  );
  await assert.rejects(database.exec("TRUNCATE risk_relationships"), /cannot be truncated/u);
  await assert.rejects(database.exec("TRUNCATE mitigation_recommendations"), /cannot be truncated/u);
  await assert.rejects(database.exec("TRUNCATE data_provenance CASCADE"), /cannot be truncated/u);

  await database.exec(`
    INSERT INTO forms (
      id, project_id, native_form_id, name, fingerprint
    ) VALUES ('form-test', 'project-test', 'native-form-test', 'Inspection', 'form-fingerprint');
    INSERT INTO form_answers (
      id, native_form_id, project_id, form_id, field_id, field_id_v2, toggle_val
    ) VALUES
      ('answer-a', 'native-form-test', 'project-test', 'form-test', 'legacy-field', 'field-v2', 0),
      ('answer-b', 'native-form-test', 'project-test', 'form-test', 'legacy-field', 'field-v2', 2);
  `);
  const formAnswers = await database.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM form_answers WHERE native_form_id = 'native-form-test'",
  );
  assert.equal(formAnswers.rows[0]?.count, 2);
  await assert.rejects(
    database.exec(`INSERT INTO form_answers (
      id, native_form_id, project_id, toggle_val
    ) VALUES ('answer-invalid', 'native-form-test', 'project-test', 3)`),
    /form_answers_toggle_val_check/u,
  );
  await database.close();
});

test("durable Data Connector gate serializes parallel rolling-budget reservations", async () => {
  const database = new PGlite();
  const schema = await readFile(path.join(process.cwd(), "src/lib/db/schema.sql"), "utf8");
  const adapter: Sql = {
    ...executor(database),
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      return database.transaction((transaction) => work(executor(transaction)));
    },
    async close(): Promise<void> {
      await database.close();
    },
  };
  await applyMigrationPlan(adapter, (work) => adapter.transaction(work), schema);
  let nextId = 0;
  const gate = new SqlDataConnectorBudgetGate(adapter, {
    accountId: "account-test",
    now: () => Date.parse("2026-09-09T12:00:00.000Z"),
    newId: () => `reservation-${++nextId}`,
  });
  const results = await Promise.allSettled(
    Array.from({ length: 17 }, () => gate.reserve("scheduled", 0)),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 16);
  await gate.markAccepted("reservation-1", "request-1");
  await gate.markTerminal("request-1");
  await gate.markAmbiguous("reservation-1");
  const second = await gate.reserve("scheduled", 0);
  await gate.markAmbiguous(second.id);
  const states = await database.query<{ state: string; request_id: string | null }>(
    "SELECT state, request_id FROM data_connector_budget_reservations WHERE id IN ('reservation-1', 'reservation-18') ORDER BY id",
  );
  assert.deepEqual(states.rows, [
    { state: "settled", request_id: "request-1" },
    { state: "ambiguous", request_id: null },
  ]);
  const quotaGate = new SqlDataConnectorBudgetGate(adapter, {
    accountId: "account-quota-test",
    now: () => Date.parse("2026-09-09T12:00:00.000Z"),
    newId: () => `quota-reservation-${++nextId}`,
  });
  for (let index = 0; index < 16; index += 1) {
    const reservation = await quotaGate.reserve("scheduled", 0);
    const requestId = `quota-request-${index + 1}`;
    await quotaGate.markAccepted(reservation.id, requestId);
    await quotaGate.markTerminal(requestId);
  }
  await assert.rejects(() => quotaGate.reserve("scheduled", 0), /retry reserve/u);
  await adapter.close();
});

test("concurrent startup serializes the complete migration plan", async () => {
  const database = new PGlite();
  const schema = await readFile(path.join(process.cwd(), "src/lib/db/schema.sql"), "utf8");
  const run = () => applyMigrationPlan(
    executor(database),
    (work) => database.transaction((transaction) => work(executor(transaction))),
    schema,
  );

  const results = await Promise.allSettled([run(), run(), run()]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "fulfilled"]);
  const migrations = await database.query<{ id: string; copies: number }>(
    "SELECT id, count(*)::int AS copies FROM schema_migrations GROUP BY id ORDER BY id",
  );
  assert.ok(migrations.rows.length >= 3);
  assert.ok(migrations.rows.every((row) => row.copies === 1));
  await database.close();
});
