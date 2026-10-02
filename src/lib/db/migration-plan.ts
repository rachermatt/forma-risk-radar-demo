import { createHash } from "node:crypto";
import type { SqlExecutor } from "./sql";

const BASELINE_ID = "0001_canonical_risk_model";
const BASELINE_SCHEMA_CHECKSUM = "6da1355aee0f4969aee90813c5cb804797bc054b530beb94cff37048453f7f46";
const ACCEPTED_BASELINE_CHECKSUMS = new Set([
  BASELINE_SCHEMA_CHECKSUM,
  // Pre-release databases created before unknown CIQ enum values were retained explicitly.
  "deb2eab2fe16da8eff77dc2c50491668909ce4d19d39fb21670fd5f76f9a7da5",
]);

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: "0002_retain_unmapped_ciq_enums",
    sql: `
      ALTER TABLE source_records DROP CONSTRAINT IF EXISTS source_records_ciq_risk_check;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_ciq_risk_check
        CHECK (ciq_risk IN ('high','medium','low','none','unmapped'));
      ALTER TABLE source_records DROP CONSTRAINT IF EXISTS source_records_ciq_cost_impact_check;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_ciq_cost_impact_check
        CHECK (ciq_cost_impact IN ('high','medium','low','none','unmapped'));
    `,
  },
  {
    id: "0003_append_only_audit_log",
    sql: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id text PRIMARY KEY,
        occurred_at timestamptz NOT NULL,
        actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 256),
        session_id text,
        action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 128),
        scope_type text NOT NULL CHECK (scope_type IN ('hub','project','record','session','system')),
        scope_id text,
        outcome text NOT NULL CHECK (outcome IN ('succeeded','denied','failed')),
        correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128)
      );
      CREATE INDEX IF NOT EXISTS audit_log_scope_idx
        ON audit_log (scope_type, scope_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS audit_log_correlation_idx
        ON audit_log (correlation_id);

      CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only';
      END;
      $$;
      DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
      CREATE TRIGGER audit_log_append_only
        BEFORE UPDATE OR DELETE ON audit_log
        FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
    `,
  },
  {
    id: "0004_provenance_integrity_and_audit_truncate_guard",
    sql: `
      ALTER TABLE data_provenance
        ADD CONSTRAINT data_provenance_autodesk_term_origin_check
        CHECK (value_kind = 'autodesk-provided' OR autodesk_term IS NULL);
      ALTER TABLE risk_snapshots
        ADD CONSTRAINT risk_snapshots_coverage_bounds_check
        CHECK (coverage IS NULL OR coverage BETWEEN 0 AND 1);
      ALTER TABLE project_risk_snapshots
        ADD CONSTRAINT project_risk_snapshots_coverage_bounds_check
        CHECK (coverage BETWEEN 0 AND 1);

      CREATE OR REPLACE FUNCTION enforce_provenance_consistency()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        stored_algorithm text;
        stored_value_kind text;
      BEGIN
        SELECT algorithm_version, value_kind
          INTO stored_algorithm, stored_value_kind
          FROM data_provenance
          WHERE id = NEW.provenance_id;
        IF stored_algorithm IS DISTINCT FROM NEW.algorithm_version THEN
          RAISE EXCEPTION 'algorithm_version does not match provenance';
        END IF;
        IF TG_TABLE_NAME = 'risk_snapshots'
           AND stored_value_kind IS DISTINCT FROM (to_jsonb(NEW)->>'value_kind') THEN
          RAISE EXCEPTION 'value_kind does not match provenance';
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS risk_snapshots_provenance_consistency ON risk_snapshots;
      CREATE TRIGGER risk_snapshots_provenance_consistency
        BEFORE INSERT OR UPDATE ON risk_snapshots
        FOR EACH ROW EXECUTE FUNCTION enforce_provenance_consistency();
      DROP TRIGGER IF EXISTS risk_factors_provenance_consistency ON risk_factors;
      CREATE TRIGGER risk_factors_provenance_consistency
        BEFORE INSERT OR UPDATE ON risk_factors
        FOR EACH ROW EXECUTE FUNCTION enforce_provenance_consistency();
      DROP TRIGGER IF EXISTS project_risk_snapshots_provenance_consistency ON project_risk_snapshots;
      CREATE TRIGGER project_risk_snapshots_provenance_consistency
        BEFORE INSERT OR UPDATE ON project_risk_snapshots
        FOR EACH ROW EXECUTE FUNCTION enforce_provenance_consistency();
      DROP TRIGGER IF EXISTS subcontractor_risk_snapshots_provenance_consistency ON subcontractor_risk_snapshots;
      CREATE TRIGGER subcontractor_risk_snapshots_provenance_consistency
        BEFORE INSERT OR UPDATE ON subcontractor_risk_snapshots
        FOR EACH ROW EXECUTE FUNCTION enforce_provenance_consistency();
      DROP TRIGGER IF EXISTS risk_exposure_snapshots_provenance_consistency ON risk_exposure_snapshots;
      CREATE TRIGGER risk_exposure_snapshots_provenance_consistency
        BEFORE INSERT OR UPDATE ON risk_exposure_snapshots
        FOR EACH ROW EXECUTE FUNCTION enforce_provenance_consistency();
      DROP TRIGGER IF EXISTS risk_recurrence_groups_provenance_consistency ON risk_recurrence_groups;
      CREATE TRIGGER risk_recurrence_groups_provenance_consistency
        BEFORE INSERT OR UPDATE ON risk_recurrence_groups
        FOR EACH ROW EXECUTE FUNCTION enforce_provenance_consistency();

      DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
      CREATE TRIGGER audit_log_no_truncate
        BEFORE TRUNCATE ON audit_log
        FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();
    `,
  },
  {
    id: "0005_live_history_immutability",
    sql: `
      CREATE OR REPLACE FUNCTION protect_live_provenance_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD.source_system <> 'demo-generator' THEN
          RAISE EXCEPTION 'live data_provenance is append-only';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$;
      DROP TRIGGER IF EXISTS data_provenance_live_append_only ON data_provenance;
      CREATE TRIGGER data_provenance_live_append_only
        BEFORE UPDATE OR DELETE ON data_provenance
        FOR EACH ROW EXECUTE FUNCTION protect_live_provenance_mutation();

      CREATE OR REPLACE FUNCTION protect_live_history_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        provenance_source text;
      BEGIN
        SELECT source_system INTO provenance_source
          FROM data_provenance WHERE id = OLD.provenance_id;
        IF provenance_source IS DISTINCT FROM 'demo-generator' THEN
          RAISE EXCEPTION 'live historical risk rows are append-only';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS risk_snapshots_live_append_only ON risk_snapshots;
      CREATE TRIGGER risk_snapshots_live_append_only BEFORE UPDATE OR DELETE ON risk_snapshots
        FOR EACH ROW EXECUTE FUNCTION protect_live_history_mutation();
      DROP TRIGGER IF EXISTS risk_factors_live_append_only ON risk_factors;
      CREATE TRIGGER risk_factors_live_append_only BEFORE UPDATE OR DELETE ON risk_factors
        FOR EACH ROW EXECUTE FUNCTION protect_live_history_mutation();
      DROP TRIGGER IF EXISTS project_risk_snapshots_live_append_only ON project_risk_snapshots;
      CREATE TRIGGER project_risk_snapshots_live_append_only BEFORE UPDATE OR DELETE ON project_risk_snapshots
        FOR EACH ROW EXECUTE FUNCTION protect_live_history_mutation();
      DROP TRIGGER IF EXISTS subcontractor_risk_snapshots_live_append_only ON subcontractor_risk_snapshots;
      CREATE TRIGGER subcontractor_risk_snapshots_live_append_only BEFORE UPDATE OR DELETE ON subcontractor_risk_snapshots
        FOR EACH ROW EXECUTE FUNCTION protect_live_history_mutation();
      DROP TRIGGER IF EXISTS risk_exposure_snapshots_live_append_only ON risk_exposure_snapshots;
      CREATE TRIGGER risk_exposure_snapshots_live_append_only BEFORE UPDATE OR DELETE ON risk_exposure_snapshots
        FOR EACH ROW EXECUTE FUNCTION protect_live_history_mutation();
      DROP TRIGGER IF EXISTS risk_recurrence_groups_live_append_only ON risk_recurrence_groups;
      CREATE TRIGGER risk_recurrence_groups_live_append_only BEFORE UPDATE OR DELETE ON risk_recurrence_groups
        FOR EACH ROW EXECUTE FUNCTION protect_live_history_mutation();

      CREATE OR REPLACE FUNCTION reject_live_history_truncate()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'provenance and historical risk tables cannot be truncated';
      END;
      $$;
      DROP TRIGGER IF EXISTS data_provenance_no_truncate ON data_provenance;
      CREATE TRIGGER data_provenance_no_truncate BEFORE TRUNCATE ON data_provenance
        FOR EACH STATEMENT EXECUTE FUNCTION reject_live_history_truncate();
      DROP TRIGGER IF EXISTS risk_snapshots_no_truncate ON risk_snapshots;
      CREATE TRIGGER risk_snapshots_no_truncate BEFORE TRUNCATE ON risk_snapshots
        FOR EACH STATEMENT EXECUTE FUNCTION reject_live_history_truncate();
      DROP TRIGGER IF EXISTS risk_factors_no_truncate ON risk_factors;
      CREATE TRIGGER risk_factors_no_truncate BEFORE TRUNCATE ON risk_factors
        FOR EACH STATEMENT EXECUTE FUNCTION reject_live_history_truncate();
      DROP TRIGGER IF EXISTS project_risk_snapshots_no_truncate ON project_risk_snapshots;
      CREATE TRIGGER project_risk_snapshots_no_truncate BEFORE TRUNCATE ON project_risk_snapshots
        FOR EACH STATEMENT EXECUTE FUNCTION reject_live_history_truncate();
      DROP TRIGGER IF EXISTS subcontractor_risk_snapshots_no_truncate ON subcontractor_risk_snapshots;
      CREATE TRIGGER subcontractor_risk_snapshots_no_truncate BEFORE TRUNCATE ON subcontractor_risk_snapshots
        FOR EACH STATEMENT EXECUTE FUNCTION reject_live_history_truncate();
      DROP TRIGGER IF EXISTS risk_exposure_snapshots_no_truncate ON risk_exposure_snapshots;
      CREATE TRIGGER risk_exposure_snapshots_no_truncate BEFORE TRUNCATE ON risk_exposure_snapshots
        FOR EACH STATEMENT EXECUTE FUNCTION reject_live_history_truncate();
      DROP TRIGGER IF EXISTS risk_recurrence_groups_no_truncate ON risk_recurrence_groups;
      CREATE TRIGGER risk_recurrence_groups_no_truncate BEFORE TRUNCATE ON risk_recurrence_groups
        FOR EACH STATEMENT EXECUTE FUNCTION reject_live_history_truncate();
    `,
  },
  {
    id: "0006_preserve_forms_source_identity",
    sql: `
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS native_form_id text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS file_id text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS description text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS notes text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS assignee_id text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS assignee_type text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS assignee_type_id text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS weather_id text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS form_date date;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS due_date timestamptz;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS created_by text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS last_submitted_at timestamptz;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS last_submitted_by text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS last_reopened_by text;
      ALTER TABLE forms ADD COLUMN IF NOT EXISTS last_submitter_signature text;
      UPDATE forms SET native_form_id = id WHERE native_form_id IS NULL;

      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS uid text;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS layout_uid text;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS section_uid text;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS field_id_v2 text;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS description text;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS type text;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS value_name text;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS is_required boolean;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS sort_index integer;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS display_index integer;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS presets jsonb;
      ALTER TABLE form_questions ADD COLUMN IF NOT EXISTS ingested_at timestamptz NOT NULL DEFAULT now();
      UPDATE form_questions
        SET uid = project_id || ':' || field_id,
            layout_uid = project_id || ':' || template_id
        WHERE uid IS NULL OR layout_uid IS NULL;
      ALTER TABLE form_questions ALTER COLUMN uid SET NOT NULL;
      ALTER TABLE form_questions ALTER COLUMN layout_uid SET NOT NULL;
      ALTER TABLE form_questions DROP CONSTRAINT IF EXISTS form_questions_pkey;
      ALTER TABLE form_questions ADD CONSTRAINT form_questions_pkey PRIMARY KEY (uid, layout_uid);
      ALTER TABLE form_questions ALTER COLUMN template_id DROP NOT NULL;
      ALTER TABLE form_questions ALTER COLUMN field_id DROP NOT NULL;

      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS id text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS native_form_id text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id);
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS field_id_v2 text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS rank integer;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS name text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS toggle_val smallint;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS text_val text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS number_val numeric;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS choice_val text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS date_val date;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS array_val jsonb;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS notes text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS company_id text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS role_id text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS role_name text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS trade text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS headcount integer;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS updated_at timestamptz;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS updated_by text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS derived_nonconforming boolean;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS derived_rule_id text;
      ALTER TABLE form_answers ADD COLUMN IF NOT EXISTS ingested_at timestamptz NOT NULL DEFAULT now();
      UPDATE form_answers AS answer
        SET id = 'legacy:' || answer.form_id || ':' || answer.field_id,
            native_form_id = form.native_form_id,
            project_id = form.project_id
        FROM forms AS form
        WHERE form.id = answer.form_id
          AND (answer.id IS NULL OR answer.native_form_id IS NULL OR answer.project_id IS NULL);
      ALTER TABLE form_answers ALTER COLUMN id SET NOT NULL;
      ALTER TABLE form_answers ALTER COLUMN native_form_id SET NOT NULL;
      ALTER TABLE form_answers ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE form_answers DROP CONSTRAINT IF EXISTS form_answers_pkey;
      ALTER TABLE form_answers ADD CONSTRAINT form_answers_pkey PRIMARY KEY (id);
      ALTER TABLE form_answers ALTER COLUMN form_id DROP NOT NULL;
      ALTER TABLE form_answers ALTER COLUMN field_id DROP NOT NULL;
      ALTER TABLE form_answers DROP CONSTRAINT IF EXISTS form_answers_toggle_val_check;
      ALTER TABLE form_answers ADD CONSTRAINT form_answers_toggle_val_check
        CHECK (toggle_val IS NULL OR toggle_val IN (0, 1, 2));
      CREATE INDEX IF NOT EXISTS form_answers_form_idx ON form_answers (native_form_id);
      CREATE INDEX IF NOT EXISTS form_answers_field_idx ON form_answers (field_id_v2);
    `,
  },
  {
    id: "0007_atomic_data_connector_budget_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS data_connector_budget_reservations (
        id text PRIMARY KEY,
        account_id text NOT NULL,
        purpose text NOT NULL CHECK (purpose IN ('scheduled','retry')),
        observed_consumed integer NOT NULL CHECK (observed_consumed >= 0),
        reserved_at timestamptz NOT NULL,
        state text NOT NULL CHECK (state IN ('reserved','accepted','ambiguous','settled')),
        request_id text,
        updated_at timestamptz NOT NULL,
        CHECK (state NOT IN ('accepted','settled') OR request_id IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS data_connector_budget_window_idx
        ON data_connector_budget_reservations (account_id, reserved_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS data_connector_budget_request_idx
        ON data_connector_budget_reservations (account_id, request_id)
        WHERE request_id IS NOT NULL;
    `,
  },
  {
    id: "0008_snapshot_forward_fill_metadata",
    sql: `
      ALTER TABLE risk_snapshots
        ADD COLUMN IF NOT EXISTS forward_filled boolean NOT NULL DEFAULT false;
      ALTER TABLE risk_snapshots
        ADD COLUMN IF NOT EXISTS forward_filled_from date;
      ALTER TABLE risk_snapshots
        ADD COLUMN IF NOT EXISTS source_extracted_at timestamptz;
      ALTER TABLE risk_snapshots
        DROP CONSTRAINT IF EXISTS risk_snapshots_forward_fill_origin_check;
      ALTER TABLE risk_snapshots
        ADD CONSTRAINT risk_snapshots_forward_fill_origin_check CHECK (
          (forward_filled = true AND forward_filled_from IS NOT NULL)
          OR (forward_filled = false AND forward_filled_from IS NULL)
      );
    `,
  },
  {
    id: "0009_source_record_attribution_integrity",
    sql: `
      UPDATE source_records
        SET assignee_type = NULL
        WHERE assignee_type IS NOT NULL
          AND assignee_type NOT IN ('user','company','role');

      UPDATE source_records
        SET company_id = NULL,
            company_attribution = 'unattributed'
        WHERE company_attribution NOT IN (
                'direct','via-assignee-membership','via-owner-membership','unattributed'
              )
           OR (company_attribution = 'unattributed' AND company_id IS NOT NULL)
           OR (company_attribution = 'via-assignee-membership' AND (
                company_id IS NULL OR assignee_id IS NULL OR assignee_type IS DISTINCT FROM 'user'
              ))
           OR (company_attribution = 'via-owner-membership' AND (
                company_id IS NULL OR owner_id IS NULL
              ))
           OR (company_attribution = 'direct' AND (
                company_id IS NULL OR (
                  kind = 'issue' AND (
                    assignee_type IS DISTINCT FROM 'company'
                    OR assignee_id IS DISTINCT FROM company_id
                  )
                )
              ));

      ALTER TABLE source_records
        DROP CONSTRAINT IF EXISTS source_records_company_attribution_check;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_company_attribution_check
        CHECK (company_attribution IN (
          'direct','via-assignee-membership','via-owner-membership','unattributed'
        ));
      ALTER TABLE source_records
        DROP CONSTRAINT IF EXISTS source_records_assignee_type_check;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_assignee_type_check
        CHECK (assignee_type IS NULL OR assignee_type IN ('user','company','role'));
      ALTER TABLE source_records
        DROP CONSTRAINT IF EXISTS source_records_company_attribution_consistency_check;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_company_attribution_consistency_check CHECK (
          CASE company_attribution
            WHEN 'unattributed' THEN company_id IS NULL
            WHEN 'via-assignee-membership' THEN
              company_id IS NOT NULL AND assignee_id IS NOT NULL AND assignee_type = 'user'
            WHEN 'via-owner-membership' THEN company_id IS NOT NULL AND owner_id IS NOT NULL
            WHEN 'direct' THEN
              company_id IS NOT NULL AND (
                kind <> 'issue' OR (assignee_type = 'company' AND assignee_id = company_id)
              )
            ELSE false
          END
        );
    `,
  },
  {
    id: "0010_company_ciq_change_log_contract",
    sql: `
      ALTER TABLE subcontractor_risk_snapshots
        RENAME COLUMN ciq_quality_risk TO ciq_quality_daily_risk;
      ALTER TABLE subcontractor_risk_snapshots
        ALTER COLUMN ciq_safety_risk TYPE numeric USING (
          CASE
            WHEN ciq_safety_risk IS NULL THEN NULL
            WHEN trim(ciq_safety_risk) ~ '^[+-]?[0-9]+([.][0-9]+)?$'
              THEN trim(ciq_safety_risk)::numeric
            ELSE NULL
          END
        );
      ALTER TABLE subcontractor_risk_snapshots
        RENAME COLUMN ciq_safety_risk TO ciq_safety_daily_risk;
      ALTER TABLE subcontractor_risk_snapshots
        RENAME COLUMN derived_index TO derived_risk_index;

      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN ciq_quality_daily_indicator numeric;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN ciq_quality_observed_at date;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN ciq_quality_forward_filled boolean NOT NULL DEFAULT false;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN ciq_safety_daily_indicator numeric;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN ciq_safety_observed_at date;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN ciq_safety_forward_filled boolean NOT NULL DEFAULT false;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN ciq_not_applicable boolean NOT NULL DEFAULT false;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN open_attributed integer NOT NULL DEFAULT 0;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN overdue_attributed integer NOT NULL DEFAULT 0;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN high_risk_attributed integer NOT NULL DEFAULT 0;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN trade_primary text;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN calculated_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE subcontractor_risk_snapshots
        ALTER COLUMN calculated_at DROP DEFAULT;
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN source_extracted_at timestamptz;

      ALTER TABLE subcontractor_risk_snapshots
        ADD CONSTRAINT subcontractor_risk_snapshots_counts_check CHECK (
          open_attributed >= 0 AND overdue_attributed >= 0 AND
          high_risk_attributed >= 0 AND attributed_direct >= 0 AND attributed_inferred >= 0
        );
      ALTER TABLE subcontractor_risk_snapshots
        ADD CONSTRAINT subcontractor_risk_snapshots_quality_fill_check CHECK (
          ciq_quality_forward_filled = false OR ciq_quality_observed_at IS NOT NULL
        );
      ALTER TABLE subcontractor_risk_snapshots
        ADD CONSTRAINT subcontractor_risk_snapshots_safety_fill_check CHECK (
          ciq_safety_forward_filled = false OR ciq_safety_observed_at IS NOT NULL
        );
      ALTER TABLE subcontractor_risk_snapshots
        ADD CONSTRAINT subcontractor_risk_snapshots_not_applicable_check CHECK (
          ciq_not_applicable = false OR (
            ciq_quality_daily_risk IS NULL AND ciq_quality_daily_indicator IS NULL AND
            ciq_safety_daily_risk IS NULL AND ciq_safety_daily_indicator IS NULL AND
            ciq_quality_forward_filled = false AND ciq_safety_forward_filled = false
          )
      );
    `,
  },
  {
    id: "0011_bounded_session_lifetimes",
    sql: `
      ALTER TABLE aps_sessions
        ADD COLUMN IF NOT EXISTS last_seen_at bigint;
      UPDATE aps_sessions
        SET last_seen_at = updated_at
        WHERE last_seen_at IS NULL;
      ALTER TABLE aps_sessions
        ALTER COLUMN last_seen_at SET NOT NULL;
      ALTER TABLE aps_sessions
        ADD CONSTRAINT aps_sessions_timestamp_order_check CHECK (
          updated_at >= created_at AND last_seen_at >= created_at
        );
      CREATE INDEX IF NOT EXISTS aps_sessions_created_idx
        ON aps_sessions (created_at);
      CREATE INDEX IF NOT EXISTS aps_sessions_last_seen_idx
        ON aps_sessions (last_seen_at);
    `,
  },
  {
    id: "0012_company_ciq_provenance_integrity",
    sql: `
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN IF NOT EXISTS ciq_quality_provenance_id text REFERENCES data_provenance(id);
      ALTER TABLE subcontractor_risk_snapshots
        ADD COLUMN IF NOT EXISTS ciq_safety_provenance_id text REFERENCES data_provenance(id);

      DROP TRIGGER IF EXISTS subcontractor_risk_snapshots_live_append_only
        ON subcontractor_risk_snapshots;

      -- Rows written before split provenance cannot prove which Autodesk
      -- change-log supplied a CIQ value. Suppress those source fields until
      -- the next extract/seed rewrites them with independently verified refs.
      UPDATE subcontractor_risk_snapshots
        SET ciq_quality_daily_risk = NULL,
            ciq_quality_daily_indicator = NULL,
            ciq_quality_observed_at = NULL,
            ciq_quality_forward_filled = false,
            ciq_quality_provenance_id = NULL,
            ciq_safety_daily_risk = NULL,
            ciq_safety_daily_indicator = NULL,
            ciq_safety_observed_at = NULL,
            ciq_safety_forward_filled = false,
            ciq_safety_provenance_id = NULL,
            ciq_not_applicable = true
        WHERE ciq_quality_provenance_id IS NULL
           OR ciq_safety_provenance_id IS NULL;

      CREATE OR REPLACE FUNCTION enforce_company_ciq_provenance()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        context_kind text;
        context_source text;
        context_project text;
        context_definition text;
        context_algorithm text;
        quality_kind text;
        quality_source text;
        quality_dataset text;
        quality_project text;
        quality_definition text;
        quality_algorithm text;
        safety_kind text;
        safety_source text;
        safety_dataset text;
        safety_project text;
        safety_definition text;
        safety_algorithm text;
        quality_present boolean;
        safety_present boolean;
      BEGIN
        SELECT value_kind, source_system, project_id, definition_id, algorithm_version
          INTO context_kind, context_source, context_project, context_definition, context_algorithm
          FROM data_provenance
          WHERE id = NEW.provenance_id;
        IF context_kind IS DISTINCT FROM 'application-derived'
           OR context_project IS DISTINCT FROM NEW.project_id
           OR context_definition IS DISTINCT FROM 'subcontractor.contextual-counts'
           OR context_algorithm IS DISTINCT FROM NEW.algorithm_version THEN
          RAISE EXCEPTION 'company snapshot context requires project-matched application-derived provenance';
        END IF;

        quality_present := NEW.ciq_quality_daily_risk IS NOT NULL
          OR NEW.ciq_quality_daily_indicator IS NOT NULL
          OR NEW.ciq_quality_observed_at IS NOT NULL
          OR NEW.ciq_quality_forward_filled;
        safety_present := NEW.ciq_safety_daily_risk IS NOT NULL
          OR NEW.ciq_safety_daily_indicator IS NOT NULL
          OR NEW.ciq_safety_observed_at IS NOT NULL
          OR NEW.ciq_safety_forward_filled;

        IF quality_present THEN
          IF NEW.ciq_quality_observed_at IS NULL THEN
            RAISE EXCEPTION 'company quality signal requires its Autodesk observation date';
          END IF;
          SELECT value_kind, source_system, source_dataset, project_id, definition_id, algorithm_version
            INTO quality_kind, quality_source, quality_dataset, quality_project, quality_definition, quality_algorithm
            FROM data_provenance
            WHERE id = NEW.ciq_quality_provenance_id;
          IF quality_kind IS DISTINCT FROM 'autodesk-provided'
             OR quality_dataset IS DISTINCT FROM 'iq_company_daily_quality_risk_changes'
             OR quality_project IS DISTINCT FROM NEW.project_id
             OR quality_definition IS DISTINCT FROM 'ciq.company.quality.daily-risk'
             OR quality_algorithm IS DISTINCT FROM NEW.algorithm_version
             OR (context_source = 'demo-generator' AND quality_source IS DISTINCT FROM 'demo-generator')
             OR (context_source <> 'demo-generator' AND quality_source IS DISTINCT FROM 'acc-data-connector') THEN
            RAISE EXCEPTION 'company quality signal requires project-matched Autodesk quality-change provenance';
          END IF;
        ELSIF NEW.ciq_quality_provenance_id IS NOT NULL THEN
          RAISE EXCEPTION 'company quality provenance cannot exist without a quality signal';
        END IF;

        IF safety_present THEN
          IF NEW.ciq_safety_observed_at IS NULL THEN
            RAISE EXCEPTION 'company safety signal requires its Autodesk observation date';
          END IF;
          SELECT value_kind, source_system, source_dataset, project_id, definition_id, algorithm_version
            INTO safety_kind, safety_source, safety_dataset, safety_project, safety_definition, safety_algorithm
            FROM data_provenance
            WHERE id = NEW.ciq_safety_provenance_id;
          IF safety_kind IS DISTINCT FROM 'autodesk-provided'
             OR safety_dataset IS DISTINCT FROM 'iq_company_daily_safety_risk_changes'
             OR safety_project IS DISTINCT FROM NEW.project_id
             OR safety_definition IS DISTINCT FROM 'ciq.company.safety.daily-risk'
             OR safety_algorithm IS DISTINCT FROM NEW.algorithm_version
             OR (context_source = 'demo-generator' AND safety_source IS DISTINCT FROM 'demo-generator')
             OR (context_source <> 'demo-generator' AND safety_source IS DISTINCT FROM 'acc-data-connector') THEN
            RAISE EXCEPTION 'company safety signal requires project-matched Autodesk safety-change provenance';
          END IF;
        ELSIF NEW.ciq_safety_provenance_id IS NOT NULL THEN
          RAISE EXCEPTION 'company safety provenance cannot exist without a safety signal';
        END IF;

        IF NEW.ciq_not_applicable IS DISTINCT FROM (NOT quality_present AND NOT safety_present) THEN
          RAISE EXCEPTION 'company CIQ not-applicable flag must match signal availability';
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS subcontractor_risk_snapshots_ciq_provenance
        ON subcontractor_risk_snapshots;
      CREATE TRIGGER subcontractor_risk_snapshots_ciq_provenance
        BEFORE INSERT OR UPDATE ON subcontractor_risk_snapshots
        FOR EACH ROW EXECUTE FUNCTION enforce_company_ciq_provenance();

      CREATE OR REPLACE FUNCTION protect_company_snapshot_live_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM data_provenance
           WHERE id IN (
             OLD.provenance_id,
             OLD.ciq_quality_provenance_id,
             OLD.ciq_safety_provenance_id
           )
             AND source_system <> 'demo-generator'
        ) THEN
          RAISE EXCEPTION 'live historical risk rows are append-only';
        END IF;
        IF TG_OP = 'UPDATE' AND EXISTS (
          SELECT 1
            FROM data_provenance
           WHERE id IN (
             NEW.provenance_id,
             NEW.ciq_quality_provenance_id,
             NEW.ciq_safety_provenance_id
           )
             AND source_system <> 'demo-generator'
        ) THEN
          RAISE EXCEPTION 'live historical risk rows are append-only';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER subcontractor_risk_snapshots_live_append_only
        BEFORE UPDATE OR DELETE ON subcontractor_risk_snapshots
        FOR EACH ROW EXECUTE FUNCTION protect_company_snapshot_live_mutation();
    `,
  },
  {
    id: "0013_project_scoped_source_identity",
    sql: `
      ALTER TABLE source_records
        ADD COLUMN IF NOT EXISTS ciq_model_risk text NOT NULL DEFAULT 'none';
      UPDATE source_records
        SET ciq_model_risk = CASE
          WHEN ciq_risk_user_override = false THEN ciq_risk
          WHEN lower(btrim(raw->>'risk')) IN ('high','medium','low','none')
            THEN lower(btrim(raw->>'risk'))
          WHEN NULLIF(btrim(raw->>'risk'), '') IS NOT NULL THEN 'unmapped'
          ELSE 'none'
        END;
      ALTER TABLE source_records
        DROP CONSTRAINT IF EXISTS source_records_ciq_model_risk_check;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_ciq_model_risk_check
        CHECK (ciq_model_risk IN ('high','medium','low','none','unmapped'));

      ALTER TABLE rfi_transitions DROP CONSTRAINT IF EXISTS rfi_transitions_rfi_id_fkey;
      ALTER TABLE form_answers DROP CONSTRAINT IF EXISTS form_answers_form_id_fkey;
      ALTER TABLE form_answers DROP CONSTRAINT IF EXISTS form_answers_project_native_form_fkey;
      ALTER TABLE review_tasks DROP CONSTRAINT IF EXISTS review_tasks_review_id_fkey;
      ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_parent_id_fkey;

      ALTER TABLE source_records DROP CONSTRAINT IF EXISTS source_records_pkey;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_pkey PRIMARY KEY (project_id, kind, id);
      ALTER TABLE risk_relationships DROP CONSTRAINT IF EXISTS risk_relationships_pkey;
      ALTER TABLE risk_relationships
        ADD CONSTRAINT risk_relationships_pkey PRIMARY KEY (project_id, id);

      ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_pkey;
      ALTER TABLE issues ADD CONSTRAINT issues_pkey PRIMARY KEY (project_id, issue_id);
      ALTER TABLE rfis DROP CONSTRAINT IF EXISTS rfis_pkey;
      ALTER TABLE rfis ADD CONSTRAINT rfis_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE forms DROP CONSTRAINT IF EXISTS forms_pkey;
      ALTER TABLE forms ADD CONSTRAINT forms_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE forms ALTER COLUMN native_form_id SET NOT NULL;
      ALTER TABLE forms DROP CONSTRAINT IF EXISTS forms_project_native_form_key;
      ALTER TABLE forms
        ADD CONSTRAINT forms_project_native_form_key UNIQUE (project_id, native_form_id);
      ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_pkey;
      ALTER TABLE reviews ADD CONSTRAINT reviews_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE submittals DROP CONSTRAINT IF EXISTS submittals_pkey;
      ALTER TABLE submittals ADD CONSTRAINT submittals_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE schedule_activities DROP CONSTRAINT IF EXISTS schedule_activities_pkey;
      ALTER TABLE schedule_activities ADD CONSTRAINT schedule_activities_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_pkey;
      ALTER TABLE locations ADD CONSTRAINT locations_pkey PRIMARY KEY (project_id, id);

      ALTER TABLE form_questions DROP CONSTRAINT IF EXISTS form_questions_pkey;
      ALTER TABLE form_questions
        ADD CONSTRAINT form_questions_pkey PRIMARY KEY (project_id, uid, layout_uid);

      ALTER TABLE rfi_transitions DROP CONSTRAINT IF EXISTS rfi_transitions_pkey;
      ALTER TABLE rfi_transitions ADD CONSTRAINT rfi_transitions_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE form_answers DROP CONSTRAINT IF EXISTS form_answers_pkey;
      ALTER TABLE form_answers ADD CONSTRAINT form_answers_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE review_tasks DROP CONSTRAINT IF EXISTS review_tasks_pkey;
      ALTER TABLE review_tasks ADD CONSTRAINT review_tasks_pkey PRIMARY KEY (project_id, id);

      ALTER TABLE rfi_transitions
        ADD CONSTRAINT rfi_transitions_project_rfi_fkey
        FOREIGN KEY (project_id, rfi_id) REFERENCES rfis(project_id, id);
      ALTER TABLE form_answers
        ADD CONSTRAINT form_answers_project_form_fkey
        FOREIGN KEY (project_id, form_id) REFERENCES forms(project_id, id);
      ALTER TABLE form_answers
        ADD CONSTRAINT form_answers_project_native_form_fkey
        FOREIGN KEY (project_id, native_form_id) REFERENCES forms(project_id, native_form_id);
      ALTER TABLE review_tasks
        ADD CONSTRAINT review_tasks_project_review_fkey
        FOREIGN KEY (project_id, review_id) REFERENCES reviews(project_id, id);
      ALTER TABLE locations
        ADD CONSTRAINT locations_project_parent_fkey
        FOREIGN KEY (project_id, parent_id) REFERENCES locations(project_id, id);
    `,
  },
  {
    id: "0014_cause_and_discipline_identity",
    sql: `
      ALTER TABLE source_records
        ADD COLUMN IF NOT EXISTS root_cause_id text;
      UPDATE source_records AS source
        SET root_cause_id = issue.root_cause_id
        FROM issues AS issue
        WHERE source.project_id = issue.project_id
          AND source.kind = 'issue'
          AND source.id = issue.issue_id
          AND source.root_cause_id IS NULL
          AND issue.root_cause_id IS NOT NULL;
      ALTER TABLE source_records
        ADD COLUMN IF NOT EXISTS discipline_origin text;

      -- Rows written before discipline provenance was modeled cannot be
      -- attributed safely to either the operational or Construction IQ source.
      -- Preserve the value while making that uncertainty explicit.
      UPDATE source_records
        SET discipline_origin = 'unmapped'
        WHERE discipline IS NOT NULL
          AND discipline_origin IS NULL;
      ALTER TABLE source_records
        DROP CONSTRAINT IF EXISTS source_records_discipline_origin_check;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_discipline_origin_check
        CHECK (discipline_origin IS NULL OR discipline_origin IN ('operational','construction-iq','unmapped'));
      ALTER TABLE source_records
        DROP CONSTRAINT IF EXISTS source_records_discipline_origin_consistency_check;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_discipline_origin_consistency_check
        CHECK (
          (discipline IS NULL AND discipline_origin IS NULL)
          OR (discipline IS NOT NULL AND discipline_origin IS NOT NULL)
        );

      ALTER TABLE rfis
        ADD COLUMN IF NOT EXISTS operational_discipline text;
    `,
  },
  {
    id: "0015_retain_unmapped_rfi_impact_values",
    sql: `
      ALTER TABLE source_records DROP CONSTRAINT IF EXISTS source_records_cost_impact_check;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_cost_impact_check
        CHECK (cost_impact IS NULL OR cost_impact IN ('yes','no','unknown','unmapped'));
      ALTER TABLE source_records DROP CONSTRAINT IF EXISTS source_records_schedule_impact_check;
      ALTER TABLE source_records
        ADD CONSTRAINT source_records_schedule_impact_check
        CHECK (schedule_impact IS NULL OR schedule_impact IN ('yes','no','unknown','unmapped'));
    `,
  },
  {
    id: "0016_project_phase_and_business_units",
    sql: `
      CREATE TABLE IF NOT EXISTS business_units (
        hub_id text NOT NULL REFERENCES hubs(id),
        id text NOT NULL,
        parent_id text,
        name text NOT NULL,
        path text NOT NULL,
        source_extracted_at timestamptz,
        ingested_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (hub_id, id),
        FOREIGN KEY (hub_id, parent_id) REFERENCES business_units(hub_id, id)
      );
      INSERT INTO business_units (hub_id, id, parent_id, name, path)
        SELECT DISTINCT hub_id, business_unit_id, NULL, business_unit_id, business_unit_id
        FROM projects
        WHERE business_unit_id IS NOT NULL
        ON CONFLICT (hub_id, id) DO NOTHING;
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_phase text;
      ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_business_unit_fkey;
      ALTER TABLE projects
        ADD CONSTRAINT projects_business_unit_fkey
        FOREIGN KEY (hub_id, business_unit_id) REFERENCES business_units(hub_id, id);
    `,
  },
  {
    id: "0017_version_relationships_and_recommendations",
    sql: `
      ALTER TABLE risk_relationships ADD COLUMN IF NOT EXISTS snapshot_date date;
      UPDATE risk_relationships SET snapshot_date = COALESCE(source_extracted_at::date, created_at::date, CURRENT_DATE) WHERE snapshot_date IS NULL;
      ALTER TABLE risk_relationships ALTER COLUMN snapshot_date SET NOT NULL;
      ALTER TABLE risk_relationships ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
      ALTER TABLE risk_relationships ADD COLUMN IF NOT EXISTS algorithm_version text NOT NULL DEFAULT 'pre-versioned';
      ALTER TABLE risk_relationships ADD COLUMN IF NOT EXISTS provenance_id text REFERENCES data_provenance(id);
      INSERT INTO data_provenance (
        id, source_system, source_dataset, source_record_id, project_id,
        extracted_at, calculated_at, definition_id, definition_version,
        algorithm_version, value_kind, input_digest, inputs, result
      )
      SELECT
        'legacy-relationship-provenance-' || md5(project_id || ':' || id),
        'forma-risk-radar', 'legacy-risk-relationships', id, project_id,
        COALESCE(source_extracted_at, created_at, CURRENT_TIMESTAMP),
        COALESCE(source_extracted_at, created_at, CURRENT_TIMESTAMP),
        'relationship.legacy-unmapped', '1.0.0', 'pre-versioned',
        'application-derived', md5(project_id || ':' || id),
        jsonb_build_object('legacyMigration', true, 'projectId', project_id, 'relationshipId', id),
        jsonb_build_object('provenanceState', 'unmapped-legacy')
      FROM risk_relationships
      WHERE provenance_id IS NULL
      ON CONFLICT DO NOTHING;
      UPDATE risk_relationships
        SET provenance_id = 'legacy-relationship-provenance-' || md5(project_id || ':' || id)
        WHERE provenance_id IS NULL;
      ALTER TABLE risk_relationships ALTER COLUMN provenance_id SET NOT NULL;
      ALTER TABLE risk_relationships DROP CONSTRAINT IF EXISTS risk_relationships_pkey;
      ALTER TABLE risk_relationships ADD PRIMARY KEY (project_id, id, snapshot_date, algorithm_version);

      ALTER TABLE mitigation_recommendations ADD COLUMN IF NOT EXISTS algorithm_version text NOT NULL DEFAULT 'pre-versioned';
      UPDATE mitigation_recommendations AS recommendation
        SET algorithm_version = provenance.algorithm_version
        FROM data_provenance AS provenance
        WHERE provenance.id = recommendation.provenance_id
          AND recommendation.algorithm_version IS DISTINCT FROM provenance.algorithm_version;
      ALTER TABLE mitigation_recommendations DROP CONSTRAINT IF EXISTS mitigation_recommendations_pkey;
      ALTER TABLE mitigation_recommendations ADD PRIMARY KEY (id, snapshot_date, algorithm_version);

      CREATE OR REPLACE FUNCTION enforce_provenance_consistency()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        stored_algorithm text;
        stored_value_kind text;
        stored_project text;
      BEGIN
        SELECT algorithm_version, value_kind, project_id
          INTO stored_algorithm, stored_value_kind, stored_project
          FROM data_provenance
          WHERE id = NEW.provenance_id;
        IF stored_algorithm IS DISTINCT FROM NEW.algorithm_version THEN
          RAISE EXCEPTION 'algorithm_version does not match provenance';
        END IF;
        IF (to_jsonb(NEW) ? 'project_id')
           AND stored_project IS DISTINCT FROM (to_jsonb(NEW)->>'project_id') THEN
          RAISE EXCEPTION 'project_id does not match provenance';
        END IF;
        IF TG_TABLE_NAME = 'risk_snapshots'
           AND stored_value_kind IS DISTINCT FROM (to_jsonb(NEW)->>'value_kind') THEN
          RAISE EXCEPTION 'value_kind does not match provenance';
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS risk_relationships_provenance_consistency ON risk_relationships;
      CREATE TRIGGER risk_relationships_provenance_consistency
        BEFORE INSERT OR UPDATE ON risk_relationships
        FOR EACH ROW EXECUTE FUNCTION enforce_provenance_consistency();
      DROP TRIGGER IF EXISTS mitigation_recommendations_provenance_consistency ON mitigation_recommendations;
      CREATE TRIGGER mitigation_recommendations_provenance_consistency
        BEFORE INSERT OR UPDATE ON mitigation_recommendations
        FOR EACH ROW EXECUTE FUNCTION enforce_provenance_consistency();

      DROP TRIGGER IF EXISTS risk_relationships_live_append_only ON risk_relationships;
      CREATE TRIGGER risk_relationships_live_append_only BEFORE UPDATE OR DELETE ON risk_relationships
        FOR EACH ROW EXECUTE FUNCTION protect_live_history_mutation();
      DROP TRIGGER IF EXISTS mitigation_recommendations_live_append_only ON mitigation_recommendations;
      CREATE TRIGGER mitigation_recommendations_live_append_only BEFORE UPDATE OR DELETE ON mitigation_recommendations
        FOR EACH ROW EXECUTE FUNCTION protect_live_history_mutation();

      DROP TRIGGER IF EXISTS risk_relationships_no_truncate ON risk_relationships;
      CREATE TRIGGER risk_relationships_no_truncate BEFORE TRUNCATE ON risk_relationships
        FOR EACH STATEMENT EXECUTE FUNCTION reject_live_history_truncate();
      DROP TRIGGER IF EXISTS mitigation_recommendations_no_truncate ON mitigation_recommendations;
      CREATE TRIGGER mitigation_recommendations_no_truncate BEFORE TRUNCATE ON mitigation_recommendations
        FOR EACH STATEMENT EXECUTE FUNCTION reject_live_history_truncate();
    `,
  },
  {
    id: "0018_canonical_sidecars_and_actor_labels",
    sql: `
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS rfi_category text;
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS ciq_root_cause_model text;
      ALTER TABLE source_records
        ADD COLUMN IF NOT EXISTS ciq_root_cause_user_override boolean NOT NULL DEFAULT false;
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS ciq_building_component_model text;
      ALTER TABLE source_records
        ADD COLUMN IF NOT EXISTS ciq_building_component_user_override boolean NOT NULL DEFAULT false;
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS ciq_safety_risk_category text;
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS ciq_safety_risk_predicted_at timestamptz;
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS ciq_safety_hazard_category text;
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS ciq_safety_hazard_predicted_at timestamptz;
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS ciq_safety_observation_category text;
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS ciq_safety_observation_predicted_at timestamptz;
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS assignee_name text;
      ALTER TABLE source_records ADD COLUMN IF NOT EXISTS owner_name text;

      UPDATE business_units
        SET name = 'Unresolved business unit (' || id || ')',
            path = 'Unresolved business unit (' || id || ')'
        WHERE source_extracted_at IS NULL
          AND name = id
          AND path = id;

      CREATE OR REPLACE FUNCTION migration_0018_canonical_utc_timestamp(value text)
      RETURNS timestamptz
      LANGUAGE plpgsql
      AS $$
      DECLARE
        parsed timestamptz;
      BEGIN
        IF value IS NULL
           OR value <> btrim(value)
           OR value !~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' THEN
          RETURN NULL;
        END IF;
        BEGIN
          parsed := value::timestamptz;
        EXCEPTION WHEN OTHERS THEN
          RETURN NULL;
        END;
        IF to_char(parsed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> value THEN
          RETURN NULL;
        END IF;
        RETURN parsed;
      END;
      $$;

      WITH inputs AS (
        SELECT project_id, kind, id,
          NULLIF(btrim(COALESCE(raw->>'category_name', raw->>'category')), '') AS rfi_category,
          NULLIF(btrim(raw->>'root_cause'), '') AS raw_root_cause,
          NULLIF(btrim(raw->>'user_root_cause'), '') AS raw_user_root_cause,
          NULLIF(btrim(ciq_root_cause), '') AS legacy_root_cause,
          NULLIF(btrim(raw->>'building_component'), '') AS raw_component,
          NULLIF(btrim(raw->>'user_building_component'), '') AS raw_user_component,
          NULLIF(btrim(building_component), '') AS legacy_component
        FROM source_records
      ), normalized AS (
        SELECT *,
          COALESCE(
            raw_root_cause,
            CASE
              WHEN raw_user_root_cause IS NULL
                OR legacy_root_cause IS DISTINCT FROM raw_user_root_cause
                THEN legacy_root_cause
              ELSE NULL
            END
          ) AS root_cause_model,
          COALESCE(
            raw_component,
            CASE
              WHEN raw_user_component IS NULL
                OR legacy_component IS DISTINCT FROM raw_user_component
                THEN legacy_component
              ELSE NULL
            END
          ) AS component_model
        FROM inputs
      )
      UPDATE source_records AS source
        SET rfi_category = CASE WHEN source.kind = 'rfi' THEN normalized.rfi_category ELSE NULL END,
            ciq_root_cause_model = CASE WHEN source.kind IN ('issue','rfi')
              THEN normalized.root_cause_model ELSE NULL END,
            ciq_root_cause_user_override = source.kind = 'issue'
              AND normalized.raw_user_root_cause IS NOT NULL
              AND normalized.raw_user_root_cause IS DISTINCT FROM normalized.root_cause_model,
            ciq_root_cause = CASE
              WHEN source.kind = 'issue'
                AND normalized.raw_user_root_cause IS NOT NULL
                THEN normalized.raw_user_root_cause
              WHEN source.kind IN ('issue','rfi') THEN normalized.root_cause_model
              ELSE NULL
            END,
            ciq_building_component_model = CASE WHEN source.kind IN ('issue','rfi')
              THEN normalized.component_model ELSE NULL END,
            ciq_building_component_user_override = source.kind = 'issue'
              AND normalized.raw_user_component IS NOT NULL
              AND normalized.raw_user_component IS DISTINCT FROM normalized.component_model,
            building_component = CASE
              WHEN source.kind = 'issue'
                AND normalized.raw_user_component IS NOT NULL
                THEN normalized.raw_user_component
              WHEN source.kind IN ('issue','rfi') THEN normalized.component_model
              ELSE NULL
            END
        FROM normalized
        WHERE source.project_id = normalized.project_id
          AND source.kind = normalized.kind
          AND source.id = normalized.id;

      WITH inputs AS (
        SELECT source.project_id, source.kind, source.id,
          NULLIF(btrim(COALESCE(issue.iq_safety_risk_category, source.raw->>'safety_risk_category')), '') AS risk_category,
          NULLIF(btrim(COALESCE(issue.iq_safety_hazard_category, source.raw->>'safety_hazard_category')), '') AS hazard_category,
          NULLIF(btrim(COALESCE(issue.iq_safety_observation_category, source.raw->>'safety_observation_category')), '') AS observation_category,
          source.raw->>'safety_risk_predicted_at' AS risk_predicted_at,
          source.raw->>'safety_hazard_predicted_at' AS hazard_predicted_at,
          source.raw->>'safety_observation_predicted_at' AS observation_predicted_at
        FROM source_records AS source
        LEFT JOIN issues AS issue
          ON source.project_id = issue.project_id
         AND source.id = issue.issue_id
        WHERE source.kind = 'issue'
      ), normalized AS (
        SELECT *,
          lower(regexp_replace(risk_category, '[^a-zA-Z0-9]+', '_', 'g')) AS risk_key,
          lower(observation_category) AS observation_key
        FROM inputs
      )
      UPDATE source_records AS source
        SET ciq_safety_risk_category = CASE
              WHEN normalized.risk_category IS NULL THEN NULL
              WHEN normalized.risk_key IN ('fall','electrocution','fire','other') THEN normalized.risk_key
              WHEN normalized.risk_key IN ('struck_by','struckby') THEN 'struck_by'
              WHEN normalized.risk_key IN ('caught_in_between','caught_inbetween') THEN 'caught_inbetween'
              ELSE 'unmapped'
            END,
            ciq_safety_risk_predicted_at = migration_0018_canonical_utc_timestamp(normalized.risk_predicted_at),
            ciq_safety_hazard_category = normalized.hazard_category,
            ciq_safety_hazard_predicted_at = migration_0018_canonical_utc_timestamp(normalized.hazard_predicted_at),
            ciq_safety_observation_category = CASE
              WHEN normalized.observation_category IS NULL THEN NULL
              WHEN normalized.observation_key IN ('positive','negative') THEN normalized.observation_key
              ELSE 'unmapped'
            END,
            ciq_safety_observation_predicted_at = migration_0018_canonical_utc_timestamp(normalized.observation_predicted_at)
        FROM normalized
        WHERE source.project_id = normalized.project_id
          AND source.kind = normalized.kind
          AND source.id = normalized.id;

      UPDATE source_records AS source
        SET assignee_name = NULLIF(btrim(company.name), '')
        FROM companies AS company
        WHERE source.assignee_type = 'company'
          AND source.assignee_id = company.id
          AND source.assignee_name IS NULL;
      UPDATE source_records AS source
        SET assignee_name = NULLIF(btrim(app_user.name), '')
        FROM users AS app_user
        WHERE source.assignee_type = 'user'
          AND source.assignee_id = app_user.id
          AND source.assignee_name IS NULL;
      UPDATE source_records AS source
        SET assignee_name = NULLIF(btrim(role.name), '')
        FROM roles AS role
        JOIN projects AS project ON project.hub_id = role.hub_id
        WHERE source.project_id = project.id
          AND source.assignee_type = 'role'
          AND source.assignee_id = role.id
          AND source.assignee_name IS NULL;
      UPDATE source_records AS source
        SET owner_name = NULLIF(btrim(app_user.name), '')
        FROM users AS app_user
        WHERE source.owner_id = app_user.id
          AND source.owner_name IS NULL;

      ALTER TABLE source_records DROP CONSTRAINT IF EXISTS source_records_rfi_category_consistency_check;
      ALTER TABLE source_records ADD CONSTRAINT source_records_rfi_category_consistency_check CHECK (
        (kind = 'rfi' AND (rfi_category IS NULL OR (rfi_category = btrim(rfi_category) AND char_length(rfi_category) > 0)))
        OR (kind <> 'rfi' AND rfi_category IS NULL)
      );
      ALTER TABLE source_records DROP CONSTRAINT IF EXISTS source_records_ciq_cause_override_check;
      ALTER TABLE source_records ADD CONSTRAINT source_records_ciq_cause_override_check CHECK (
        (ciq_root_cause IS NULL OR (ciq_root_cause = btrim(ciq_root_cause) AND char_length(ciq_root_cause) > 0))
        AND (ciq_root_cause_model IS NULL OR (ciq_root_cause_model = btrim(ciq_root_cause_model) AND char_length(ciq_root_cause_model) > 0))
        AND (
          (kind IN ('issue','rfi') AND (
            (ciq_root_cause_user_override = false AND ciq_root_cause IS NOT DISTINCT FROM ciq_root_cause_model)
            OR (ciq_root_cause_user_override = true AND kind = 'issue'
                AND ciq_root_cause IS NOT NULL
                AND ciq_root_cause IS DISTINCT FROM ciq_root_cause_model)
          ))
          OR (kind NOT IN ('issue','rfi') AND ciq_root_cause IS NULL
              AND ciq_root_cause_model IS NULL AND ciq_root_cause_user_override = false)
        )
      );
      ALTER TABLE source_records DROP CONSTRAINT IF EXISTS source_records_ciq_component_override_check;
      ALTER TABLE source_records ADD CONSTRAINT source_records_ciq_component_override_check CHECK (
        (building_component IS NULL OR (building_component = btrim(building_component) AND char_length(building_component) > 0))
        AND (ciq_building_component_model IS NULL OR (ciq_building_component_model = btrim(ciq_building_component_model) AND char_length(ciq_building_component_model) > 0))
        AND (
          (kind IN ('issue','rfi') AND (
            (ciq_building_component_user_override = false
              AND building_component IS NOT DISTINCT FROM ciq_building_component_model)
            OR (ciq_building_component_user_override = true AND kind = 'issue'
                AND building_component IS NOT NULL
                AND building_component IS DISTINCT FROM ciq_building_component_model)
          ))
          OR (kind NOT IN ('issue','rfi') AND building_component IS NULL
              AND ciq_building_component_model IS NULL AND ciq_building_component_user_override = false)
        )
      );
      ALTER TABLE source_records DROP CONSTRAINT IF EXISTS source_records_ciq_safety_sidecars_check;
      ALTER TABLE source_records ADD CONSTRAINT source_records_ciq_safety_sidecars_check CHECK (
        (
          (ciq_safety_risk_category IS NULL OR ciq_safety_risk_category IN
            ('fall','electrocution','struck_by','caught_inbetween','fire','other','unmapped'))
          AND (ciq_safety_hazard_category IS NULL OR
            (ciq_safety_hazard_category = btrim(ciq_safety_hazard_category)
              AND char_length(ciq_safety_hazard_category) > 0))
          AND (ciq_safety_observation_category IS NULL
            OR ciq_safety_observation_category IN ('positive','negative','unmapped'))
          AND (ciq_safety_risk_predicted_at IS NULL OR ciq_safety_risk_category IS NOT NULL)
          AND (ciq_safety_hazard_predicted_at IS NULL OR ciq_safety_hazard_category IS NOT NULL)
          AND (ciq_safety_observation_predicted_at IS NULL OR ciq_safety_observation_category IS NOT NULL)
        )
        AND (
          kind = 'issue'
          OR (
            ciq_safety_risk_category IS NULL AND ciq_safety_risk_predicted_at IS NULL
            AND ciq_safety_hazard_category IS NULL AND ciq_safety_hazard_predicted_at IS NULL
            AND ciq_safety_observation_category IS NULL AND ciq_safety_observation_predicted_at IS NULL
          )
        )
      );
      ALTER TABLE source_records DROP CONSTRAINT IF EXISTS source_records_actor_label_consistency_check;
      ALTER TABLE source_records ADD CONSTRAINT source_records_actor_label_consistency_check CHECK (
        (assignee_name IS NULL OR (assignee_id IS NOT NULL
          AND assignee_name = btrim(assignee_name) AND char_length(assignee_name) > 0))
        AND (owner_name IS NULL OR (owner_id IS NOT NULL
          AND owner_name = btrim(owner_name) AND char_length(owner_name) > 0))
      );

      -- Company CIQ availability is inherited from the project. A company on
      -- a covered project can legitimately have no current quality/safety row.
      CREATE OR REPLACE FUNCTION enforce_company_ciq_provenance()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        context_kind text;
        context_source text;
        context_project text;
        context_definition text;
        context_algorithm text;
        quality_kind text;
        quality_source text;
        quality_dataset text;
        quality_project text;
        quality_definition text;
        quality_algorithm text;
        safety_kind text;
        safety_source text;
        safety_dataset text;
        safety_project text;
        safety_definition text;
        safety_algorithm text;
        quality_present boolean;
        safety_present boolean;
        project_ciq_not_applicable boolean;
      BEGIN
        SELECT value_kind, source_system, project_id, definition_id, algorithm_version
          INTO context_kind, context_source, context_project, context_definition, context_algorithm
          FROM data_provenance
          WHERE id = NEW.provenance_id;
        IF context_kind IS DISTINCT FROM 'application-derived'
           OR context_project IS DISTINCT FROM NEW.project_id
           OR context_definition IS DISTINCT FROM 'subcontractor.contextual-counts'
           OR context_algorithm IS DISTINCT FROM NEW.algorithm_version THEN
          RAISE EXCEPTION 'company snapshot context requires project-matched application-derived provenance';
        END IF;

        quality_present := NEW.ciq_quality_daily_risk IS NOT NULL
          OR NEW.ciq_quality_daily_indicator IS NOT NULL
          OR NEW.ciq_quality_observed_at IS NOT NULL
          OR NEW.ciq_quality_forward_filled;
        safety_present := NEW.ciq_safety_daily_risk IS NOT NULL
          OR NEW.ciq_safety_daily_indicator IS NOT NULL
          OR NEW.ciq_safety_observed_at IS NOT NULL
          OR NEW.ciq_safety_forward_filled;

        IF quality_present THEN
          IF NEW.ciq_quality_observed_at IS NULL THEN
            RAISE EXCEPTION 'company quality signal requires its Autodesk observation date';
          END IF;
          SELECT value_kind, source_system, source_dataset, project_id, definition_id, algorithm_version
            INTO quality_kind, quality_source, quality_dataset, quality_project, quality_definition, quality_algorithm
            FROM data_provenance
            WHERE id = NEW.ciq_quality_provenance_id;
          IF quality_kind IS DISTINCT FROM 'autodesk-provided'
             OR quality_dataset IS DISTINCT FROM 'iq_company_daily_quality_risk_changes'
             OR quality_project IS DISTINCT FROM NEW.project_id
             OR quality_definition IS DISTINCT FROM 'ciq.company.quality.daily-risk'
             OR quality_algorithm IS DISTINCT FROM NEW.algorithm_version
             OR (context_source = 'demo-generator' AND quality_source IS DISTINCT FROM 'demo-generator')
             OR (context_source <> 'demo-generator' AND quality_source IS DISTINCT FROM 'acc-data-connector') THEN
            RAISE EXCEPTION 'company quality signal requires project-matched Autodesk quality-change provenance';
          END IF;
        ELSIF NEW.ciq_quality_provenance_id IS NOT NULL THEN
          RAISE EXCEPTION 'company quality provenance cannot exist without a quality signal';
        END IF;

        IF safety_present THEN
          IF NEW.ciq_safety_observed_at IS NULL THEN
            RAISE EXCEPTION 'company safety signal requires its Autodesk observation date';
          END IF;
          SELECT value_kind, source_system, source_dataset, project_id, definition_id, algorithm_version
            INTO safety_kind, safety_source, safety_dataset, safety_project, safety_definition, safety_algorithm
            FROM data_provenance
            WHERE id = NEW.ciq_safety_provenance_id;
          IF safety_kind IS DISTINCT FROM 'autodesk-provided'
             OR safety_dataset IS DISTINCT FROM 'iq_company_daily_safety_risk_changes'
             OR safety_project IS DISTINCT FROM NEW.project_id
             OR safety_definition IS DISTINCT FROM 'ciq.company.safety.daily-risk'
             OR safety_algorithm IS DISTINCT FROM NEW.algorithm_version
             OR (context_source = 'demo-generator' AND safety_source IS DISTINCT FROM 'demo-generator')
             OR (context_source <> 'demo-generator' AND safety_source IS DISTINCT FROM 'acc-data-connector') THEN
            RAISE EXCEPTION 'company safety signal requires project-matched Autodesk safety-change provenance';
          END IF;
        ELSIF NEW.ciq_safety_provenance_id IS NOT NULL THEN
          RAISE EXCEPTION 'company safety provenance cannot exist without a safety signal';
        END IF;

        SELECT snapshot.ciq_not_applicable
          INTO project_ciq_not_applicable
          FROM project_risk_snapshots AS snapshot
          WHERE snapshot.snapshot_date = NEW.snapshot_date
            AND snapshot.project_id = NEW.project_id
            AND snapshot.domain = 'all'
            AND snapshot.algorithm_version = NEW.algorithm_version;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'company CIQ applicability requires the matching project snapshot';
        END IF;
        IF NEW.ciq_not_applicable IS DISTINCT FROM project_ciq_not_applicable THEN
          RAISE EXCEPTION 'company CIQ not-applicable flag must match project eligibility';
        END IF;
        RETURN NEW;
      END;
      $$;

      ALTER TABLE issues ADD COLUMN IF NOT EXISTS iq_design_user_root_cause text;
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS iq_design_user_building_component text;
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS iq_safety_risk_predicted_at timestamptz;
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS iq_safety_hazard_predicted_at timestamptz;
      ALTER TABLE issues ADD COLUMN IF NOT EXISTS iq_safety_observation_predicted_at timestamptz;
      UPDATE issues AS issue
        SET iq_design_root_cause = source.ciq_root_cause_model,
            iq_design_user_root_cause = CASE
              WHEN source.ciq_root_cause_user_override THEN source.ciq_root_cause ELSE NULL END,
            iq_design_building_component = source.ciq_building_component_model,
            iq_design_user_building_component = CASE
              WHEN source.ciq_building_component_user_override THEN source.building_component ELSE NULL END,
            iq_safety_risk_category = source.ciq_safety_risk_category,
            iq_safety_risk_predicted_at = source.ciq_safety_risk_predicted_at,
            iq_safety_hazard_category = source.ciq_safety_hazard_category,
            iq_safety_hazard_predicted_at = source.ciq_safety_hazard_predicted_at,
            iq_safety_observation_category = source.ciq_safety_observation_category,
            iq_safety_observation_predicted_at = source.ciq_safety_observation_predicted_at
        FROM source_records AS source
        WHERE issue.project_id = source.project_id
          AND issue.issue_id = source.id
          AND source.kind = 'issue';

      ALTER TABLE rfis ADD COLUMN IF NOT EXISTS operational_category text;
      UPDATE rfis AS rfi
        SET operational_category = source.rfi_category
        FROM source_records AS source
        WHERE rfi.project_id = source.project_id
          AND rfi.id = source.id
          AND source.kind = 'rfi';

      ALTER TABLE rfis DROP CONSTRAINT IF EXISTS rfis_operational_category_check;
      ALTER TABLE rfis ADD CONSTRAINT rfis_operational_category_check CHECK (
        operational_category IS NULL OR
        (operational_category = btrim(operational_category) AND char_length(operational_category) > 0)
      );

      DROP FUNCTION migration_0018_canonical_utc_timestamp(text);
    `,
  },
];

type TransactionRunner = (work: (transaction: SqlExecutor) => Promise<void>) => Promise<void>;

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function baselineChecksum(baselineSchema: string): string {
  const baselineDigest = checksum(baselineSchema);
  if (baselineDigest !== BASELINE_SCHEMA_CHECKSUM) {
    throw new Error("The baseline schema changed. Add a new immutable migration instead of editing migration 0001.");
  }
  return baselineDigest;
}

async function applyVersionedMigration(
  sql: SqlExecutor,
  migration: Migration,
): Promise<void> {
  const digest = checksum(migration.sql);
  const existing = await sql.query<{ checksum: string }>(
    "SELECT checksum FROM schema_migrations WHERE id = $1",
    [migration.id],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].checksum !== digest) {
      throw new Error(`Migration ${migration.id} changed after it was applied.`);
    }
    return;
  }
  await sql.exec(migration.sql);
  await sql.query(
    "INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)",
    [migration.id, digest],
  );
}

export async function applyMigrationPlan(
  sql: SqlExecutor,
  transaction: TransactionRunner,
  baselineSchema: string,
): Promise<void> {
  const baselineDigest = baselineChecksum(baselineSchema);

  // Serialize the complete plan across concurrent processes/replicas. The
  // transaction-scoped advisory lock is implemented by PostgreSQL and PGlite,
  // requires no pre-existing lock table, and is released on commit/rollback.
  await transaction(async (executor) => {
    await executor.query("SELECT pg_advisory_xact_lock($1)", [2088642301]);
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const baseline = await executor.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE id = $1",
      [BASELINE_ID],
    );
    if (baseline.rows[0]) {
      if (!ACCEPTED_BASELINE_CHECKSUMS.has(baseline.rows[0].checksum)) {
        throw new Error(`Migration ${BASELINE_ID} has an unrecognized checksum.`);
      }
    } else {
      await executor.exec(baselineSchema);
      await executor.query(
        "INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)",
        [BASELINE_ID, baselineDigest],
      );
    }

    for (const migration of MIGRATIONS) {
      await applyVersionedMigration(executor, migration);
    }
  });
}

export async function verifyMigrationPlan(
  sql: SqlExecutor,
  baselineSchema: string,
): Promise<void> {
  baselineChecksum(baselineSchema);

  let result: Awaited<ReturnType<SqlExecutor["query"]>>;
  try {
    result = await sql.query<{ id: string; checksum: string }>(
      "SELECT id, checksum FROM schema_migrations",
    );
  } catch (cause) {
    throw new Error(
      "Unable to verify database migrations. Run `npm run db:migrate` before starting the web runtime.",
      { cause },
    );
  }

  const applied = new Map(
    result.rows.map((row) => [String(row.id), String(row.checksum)]),
  );
  const baseline = applied.get(BASELINE_ID);
  if (!baseline) {
    throw new Error(`Database migration ${BASELINE_ID} is not applied. Run \`npm run db:migrate\`.`);
  }
  if (!ACCEPTED_BASELINE_CHECKSUMS.has(baseline)) {
    throw new Error(`Migration ${BASELINE_ID} has an unrecognized checksum.`);
  }

  for (const migration of MIGRATIONS) {
    const appliedChecksum = applied.get(migration.id);
    if (!appliedChecksum) {
      throw new Error(`Database migration ${migration.id} is not applied. Run \`npm run db:migrate\`.`);
    }
    if (appliedChecksum !== checksum(migration.sql)) {
      throw new Error(`Migration ${migration.id} changed after it was applied.`);
    }
  }
}
