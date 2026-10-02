import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrationPlan } from "../src/lib/db/migration-plan";
import type { SqlExecutor, SqlResult, SqlValue } from "../src/lib/db/sql";

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

test("0018 upgrades populated canonical sidecars without losing overrides or inventing actor labels", async () => {
  const database = new PGlite();
  const schema = await readFile(path.join(process.cwd(), "src/lib/db/schema.sql"), "utf8");
  const run = () => applyMigrationPlan(
    executor(database),
    (work) => database.transaction((transaction) => work(executor(transaction))),
    schema,
  );
  await run();

  // Recreate the populated pre-0018 shape while retaining every older migration.
  await database.exec(`
    DELETE FROM schema_migrations WHERE id = '0018_canonical_sidecars_and_actor_labels';
    ALTER TABLE source_records DROP CONSTRAINT source_records_rfi_category_consistency_check;
    ALTER TABLE source_records DROP CONSTRAINT source_records_ciq_cause_override_check;
    ALTER TABLE source_records DROP CONSTRAINT source_records_ciq_component_override_check;
    ALTER TABLE source_records DROP CONSTRAINT source_records_ciq_safety_sidecars_check;
    ALTER TABLE source_records DROP CONSTRAINT source_records_actor_label_consistency_check;
    ALTER TABLE source_records DROP COLUMN rfi_category;
    ALTER TABLE source_records DROP COLUMN ciq_root_cause_model;
    ALTER TABLE source_records DROP COLUMN ciq_root_cause_user_override;
    ALTER TABLE source_records DROP COLUMN ciq_building_component_model;
    ALTER TABLE source_records DROP COLUMN ciq_building_component_user_override;
    ALTER TABLE source_records DROP COLUMN ciq_safety_risk_category;
    ALTER TABLE source_records DROP COLUMN ciq_safety_risk_predicted_at;
    ALTER TABLE source_records DROP COLUMN ciq_safety_hazard_category;
    ALTER TABLE source_records DROP COLUMN ciq_safety_hazard_predicted_at;
    ALTER TABLE source_records DROP COLUMN ciq_safety_observation_category;
    ALTER TABLE source_records DROP COLUMN ciq_safety_observation_predicted_at;
    ALTER TABLE source_records DROP COLUMN assignee_name;
    ALTER TABLE source_records DROP COLUMN owner_name;
    ALTER TABLE issues DROP COLUMN iq_design_user_root_cause;
    ALTER TABLE issues DROP COLUMN iq_design_user_building_component;
    ALTER TABLE issues DROP COLUMN iq_safety_risk_predicted_at;
    ALTER TABLE issues DROP COLUMN iq_safety_hazard_predicted_at;
    ALTER TABLE issues DROP COLUMN iq_safety_observation_predicted_at;
    ALTER TABLE rfis DROP CONSTRAINT rfis_operational_category_check;
    ALTER TABLE rfis DROP COLUMN operational_category;

    INSERT INTO hubs (id, name, region) VALUES ('hub-sidecar', 'Sidecar hub', 'US');
    INSERT INTO business_units (hub_id, id, name, path)
      VALUES ('hub-sidecar', 'bu-unresolved', 'bu-unresolved', 'bu-unresolved');
    INSERT INTO projects (id, hub_id, name, type, business_unit_id)
      VALUES ('project-sidecar', 'hub-sidecar', 'Sidecar project', 'production', 'bu-unresolved');
    INSERT INTO companies (id, hub_id, name)
      VALUES ('company-sidecar', 'hub-sidecar', 'Legacy Trade Partner');
    INSERT INTO users (id, hub_id, name)
      VALUES ('user-assignee', 'hub-sidecar', 'Legacy Assignee'),
             ('user-owner', 'hub-sidecar', 'Legacy Owner');
    INSERT INTO roles (id, hub_id, name)
      VALUES ('role-reviewer', 'hub-sidecar', 'Legacy reviewer role');

    INSERT INTO source_records (
      kind, id, project_id, title, status, status_normalized, open, domain,
      ciq_model_risk, ciq_risk, ciq_cost_impact, ciq_root_cause,
      building_component, company_attribution, assignee_id, assignee_type, owner_id,
      created_at, raw, fingerprint, first_seen_at, last_seen_at
    ) VALUES
      (
        'issue', 'issue-sidecar', 'project-sidecar', 'Legacy Issue', 'open', 'open', true, 'safety',
        'high', 'high', 'medium', 'Legacy effective cause', 'Legacy component', 'unattributed',
        'user-assignee', 'user', 'user-owner', '2026-09-01T00:00:00.000Z',
        '{
          "root_cause":" Documentation Incomplete ",
          "user_root_cause":" Code Compliance ",
          "building_component":" Interior Construction ",
          "user_building_component":" Building Envelope ",
          "safety_risk_category":" Caught in between ",
          "safety_risk_predicted_at":"2026-09-01T12:00:00.000Z",
          "safety_hazard_category":" ladder ",
          "safety_hazard_predicted_at":"2026-09-01T12:00:00Z",
          "safety_observation_category":" provider drift ",
          "safety_observation_predicted_at":"2026-09-01T13:00:00.000Z"
        }'::jsonb,
        'issue-sidecar-fingerprint', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      ),
      (
        'rfi', 'rfi-sidecar', 'project-sidecar', 'Legacy RFI', 'open', 'open', true, 'rfi',
        'medium', 'medium', 'none', 'Documentation Incomplete', 'Mechanical Systems', 'unattributed',
        'role-reviewer', 'role', NULL, '2026-09-01T00:00:00.000Z',
        '{"category_name":" Design Coordination ","root_cause":" Documentation Incomplete ","building_component":" Mechanical Systems "}'::jsonb,
        'rfi-sidecar-fingerprint', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      ),
      (
        'form', 'form-sidecar', 'project-sidecar', 'Legacy Form', 'submitted', 'closed', false, 'quality',
        'none', 'none', 'none', NULL, 'Legacy impossible CIQ component', 'unattributed',
        NULL, NULL, NULL, '2026-09-01T00:00:00.000Z',
        '{"safety_risk_category":"fall"}'::jsonb,
        'form-sidecar-fingerprint', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      ),
      (
        'issue', 'issue-user-without-model', 'project-sidecar', 'Legacy user-only cause',
        'open', 'open', true, 'quality', 'none', 'none', 'none',
        'User-only cause', 'User-only component', 'unattributed', NULL, NULL, NULL,
        '2026-09-01T00:00:00.000Z',
        '{"user_root_cause":" User-only cause ","user_building_component":" User-only component "}'::jsonb,
        'issue-user-without-model-fingerprint', '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z'
      ),
      (
        'issue', 'issue-user-equals-model', 'project-sidecar', 'Legacy equal user/model cause',
        'open', 'open', true, 'quality', 'none', 'none', 'none',
        'Same cause', 'Same component', 'unattributed', NULL, NULL, NULL,
        '2026-09-01T00:00:00.000Z',
        '{"root_cause":" Same cause ","user_root_cause":" Same cause ","building_component":" Same component ","user_building_component":" Same component "}'::jsonb,
        'issue-user-equals-model-fingerprint', '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z'
      );

    INSERT INTO issues (
      issue_id, project_id, title, iq_safety_risk_category,
      iq_safety_hazard_category, iq_safety_observation_category, fingerprint
    ) VALUES (
      'issue-sidecar', 'project-sidecar', 'Legacy Issue', ' Caught in between ',
      ' ladder ', ' provider drift ', 'typed-issue-sidecar'
    );
    INSERT INTO rfis (id, project_id, title, fingerprint)
      VALUES ('rfi-sidecar', 'project-sidecar', 'Legacy RFI', 'typed-rfi-sidecar');
  `);

  await run();

  const source = await database.query<{
    kind: string;
    rfi_category: string | null;
    ciq_root_cause_model: string | null;
    ciq_root_cause: string | null;
    ciq_root_cause_user_override: boolean;
    ciq_building_component_model: string | null;
    building_component: string | null;
    ciq_building_component_user_override: boolean;
    ciq_safety_risk_category: string | null;
    ciq_safety_risk_predicted_at: string | null;
    ciq_safety_hazard_category: string | null;
    ciq_safety_hazard_predicted_at: string | null;
    ciq_safety_observation_category: string | null;
    ciq_safety_observation_predicted_at: string | null;
    assignee_name: string | null;
    owner_name: string | null;
  }>(`
    SELECT kind, rfi_category, ciq_root_cause_model, ciq_root_cause,
      ciq_root_cause_user_override, ciq_building_component_model, building_component,
      ciq_building_component_user_override, ciq_safety_risk_category,
      ciq_safety_risk_predicted_at::text, ciq_safety_hazard_category,
      ciq_safety_hazard_predicted_at::text, ciq_safety_observation_category,
      ciq_safety_observation_predicted_at::text, assignee_name, owner_name
    FROM source_records
    WHERE project_id = 'project-sidecar'
      AND id IN ('issue-sidecar', 'rfi-sidecar', 'form-sidecar')
    ORDER BY kind
  `);
  const byKind = new Map(source.rows.map((row) => [row.kind, row]));
  assert.deepEqual(byKind.get("issue"), {
    kind: "issue",
    rfi_category: null,
    ciq_root_cause_model: "Documentation Incomplete",
    ciq_root_cause: "Code Compliance",
    ciq_root_cause_user_override: true,
    ciq_building_component_model: "Interior Construction",
    building_component: "Building Envelope",
    ciq_building_component_user_override: true,
    ciq_safety_risk_category: "caught_inbetween",
    ciq_safety_risk_predicted_at: "2026-09-01 12:00:00+00",
    ciq_safety_hazard_category: "ladder",
    ciq_safety_hazard_predicted_at: null,
    ciq_safety_observation_category: "unmapped",
    ciq_safety_observation_predicted_at: "2026-09-01 13:00:00+00",
    assignee_name: "Legacy Assignee",
    owner_name: "Legacy Owner",
  });
  assert.equal(byKind.get("rfi")?.rfi_category, "Design Coordination");
  assert.equal(byKind.get("rfi")?.ciq_root_cause_model, "Documentation Incomplete");
  assert.equal(byKind.get("rfi")?.ciq_root_cause_user_override, false);
  assert.equal(byKind.get("rfi")?.assignee_name, "Legacy reviewer role");
  assert.equal(byKind.get("form")?.building_component, null);
  assert.equal(byKind.get("form")?.ciq_building_component_model, null);
  assert.equal(byKind.get("form")?.ciq_safety_risk_category, null);

  const overrideEdges = await database.query<{
    id: string;
    cause_model: string | null;
    cause_effective: string | null;
    cause_overridden: boolean;
    component_model: string | null;
    component_effective: string | null;
    component_overridden: boolean;
  }>(`
    SELECT id, ciq_root_cause_model AS cause_model, ciq_root_cause AS cause_effective,
      ciq_root_cause_user_override AS cause_overridden,
      ciq_building_component_model AS component_model,
      building_component AS component_effective,
      ciq_building_component_user_override AS component_overridden
    FROM source_records
    WHERE project_id = 'project-sidecar'
      AND id IN ('issue-user-without-model', 'issue-user-equals-model')
    ORDER BY id
  `);
  assert.deepEqual(overrideEdges.rows, [
    {
      id: "issue-user-equals-model",
      cause_model: "Same cause",
      cause_effective: "Same cause",
      cause_overridden: false,
      component_model: "Same component",
      component_effective: "Same component",
      component_overridden: false,
    },
    {
      id: "issue-user-without-model",
      cause_model: null,
      cause_effective: "User-only cause",
      cause_overridden: true,
      component_model: null,
      component_effective: "User-only component",
      component_overridden: true,
    },
  ]);

  const typed = await database.query<{
    user_root: string | null;
    user_component: string | null;
    category: string | null;
  }>(`
    SELECT iq_design_user_root_cause AS user_root,
      iq_design_user_building_component AS user_component,
      iq_safety_observation_category AS category
    FROM issues
    WHERE project_id = 'project-sidecar' AND issue_id = 'issue-sidecar'
  `);
  assert.deepEqual(typed.rows[0], {
    user_root: "Code Compliance",
    user_component: "Building Envelope",
    category: "unmapped",
  });
  const rfi = await database.query<{ category: string | null }>(`
    SELECT operational_category AS category FROM rfis
    WHERE project_id = 'project-sidecar' AND id = 'rfi-sidecar'
  `);
  assert.equal(rfi.rows[0]?.category, "Design Coordination");
  const businessUnit = await database.query<{ name: string; path: string }>(`
    SELECT name, path FROM business_units
    WHERE hub_id = 'hub-sidecar' AND id = 'bu-unresolved'
  `);
  assert.deepEqual(businessUnit.rows[0], {
    name: "Unresolved business unit (bu-unresolved)",
    path: "Unresolved business unit (bu-unresolved)",
  });

  await assert.rejects(
    database.exec("UPDATE source_records SET rfi_category = '  ' WHERE project_id = 'project-sidecar' AND kind = 'rfi'"),
    /source_records_rfi_category_consistency_check/u,
  );
  await assert.rejects(
    database.exec("UPDATE source_records SET assignee_name = ' user id ' WHERE project_id = 'project-sidecar' AND kind = 'issue'"),
    /source_records_actor_label_consistency_check/u,
  );
  await assert.rejects(
    database.exec("UPDATE source_records SET ciq_safety_risk_category = 'new-provider-enum' WHERE project_id = 'project-sidecar' AND kind = 'issue'"),
    /source_records_ciq_safety_sidecars_check/u,
  );
  await assert.rejects(
    database.exec("UPDATE source_records SET ciq_root_cause_user_override = false WHERE project_id = 'project-sidecar' AND kind = 'issue'"),
    /source_records_ciq_cause_override_check/u,
  );
  const helper = await database.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM pg_proc
    WHERE proname = 'migration_0018_canonical_utc_timestamp'
  `);
  assert.equal(helper.rows[0]?.count, 0);
  await database.close();
});
