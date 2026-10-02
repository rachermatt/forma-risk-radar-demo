-- Forma Risk Radar logical PostgreSQL schema.
-- Compatible with both PGlite and a PostgreSQL server; no extensions required.

CREATE TABLE IF NOT EXISTS hubs (
  id text PRIMARY KEY,
  name text NOT NULL,
  region text,
  integration_verified boolean NOT NULL DEFAULT false,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

-- APS credentials never enter the browser. Only the signed opaque `id` is
-- stored in the session cookie; this table contains the AES-GCM envelope.
CREATE TABLE IF NOT EXISTS aps_sessions (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  encrypted_tokens text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS aps_sessions_updated_idx ON aps_sessions (updated_at);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  hub_id text NOT NULL REFERENCES hubs(id),
  name text NOT NULL,
  status text,
  type text,
  classification text,
  business_unit_id text,
  start_date date,
  end_date date,
  city text,
  country text,
  value numeric(18,2),
  currency text,
  total_member_size integer,
  total_company_size integer,
  accessible boolean NOT NULL DEFAULT false,
  is_production boolean NOT NULL DEFAULT true,
  production_exclusion_reason text,
  available_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  ciq_eligible boolean NOT NULL DEFAULT false,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_hub_idx ON projects (hub_id, is_production);

CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  hub_id text NOT NULL REFERENCES hubs(id),
  name text NOT NULL,
  trade text,
  trade_primary text,
  trade_secondary text,
  category text,
  status text,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_trade_idx ON companies (trade_primary);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  hub_id text NOT NULL REFERENCES hubs(id),
  autodesk_id text,
  email text,
  name text,
  status text,
  default_company_id text REFERENCES companies(id),
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_users (
  project_id text NOT NULL REFERENCES projects(id),
  user_id text NOT NULL REFERENCES users(id),
  company_id text REFERENCES companies(id),
  access_level text,
  status text,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id text NOT NULL,
  hub_id text NOT NULL REFERENCES hubs(id),
  project_id text REFERENCES projects(id),
  role_oxygen_id text,
  name text,
  status text,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, hub_id)
);

CREATE TABLE IF NOT EXISTS locations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  tree_id text NOT NULL,
  parent_id text REFERENCES locations(id),
  name text NOT NULL,
  sort_order integer,
  depth integer NOT NULL,
  path text NOT NULL,
  derived_tier text CHECK (derived_tier IN ('building','level','zone','room','unmapped')),
  derived_tier_rule text,
  deleted_observed_at timestamptz,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS locations_project_idx ON locations (project_id);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id text PRIMARY KEY,
  hub_id text REFERENCES hubs(id),
  source text NOT NULL,
  job_type text,
  dc_job_id text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  project_id text REFERENCES projects(id),
  requested_start timestamptz,
  requested_end timestamptz,
  returned_start timestamptz,
  returned_end timestamptz,
  rows_processed integer NOT NULL DEFAULT 0,
  rows_inserted integer NOT NULL DEFAULT 0,
  rows_updated integer NOT NULL DEFAULT 0,
  rows_unchanged integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_extracted_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','complete','failed','partial')),
  dc_status text,
  dc_completion_status text,
  budget_consumed boolean NOT NULL DEFAULT false,
  error_code text,
  error_request_id text
);
CREATE INDEX IF NOT EXISTS ingestion_jobs_hub_started_idx ON ingestion_jobs (hub_id, started_at DESC);

CREATE TABLE IF NOT EXISTS data_provenance (
  id text PRIMARY KEY,
  ingestion_job_id text REFERENCES ingestion_jobs(id),
  source_system text NOT NULL,
  source_dataset text NOT NULL,
  source_record_id text,
  project_id text REFERENCES projects(id),
  extracted_at timestamptz NOT NULL,
  calculated_at timestamptz NOT NULL,
  definition_id text NOT NULL,
  definition_version text NOT NULL,
  algorithm_version text NOT NULL,
  value_kind text NOT NULL CHECK (value_kind IN ('autodesk-provided','application-derived','ai-generated')),
  autodesk_term text,
  input_digest text NOT NULL,
  inputs jsonb NOT NULL,
  result jsonb NOT NULL,
  UNIQUE (definition_id, definition_version, algorithm_version, input_digest)
);
CREATE INDEX IF NOT EXISTS data_provenance_project_idx ON data_provenance (project_id, calculated_at DESC);

CREATE TABLE IF NOT EXISTS column_report (
  id text PRIMARY KEY,
  ingestion_job_id text NOT NULL REFERENCES ingestion_jobs(id),
  hub_id text REFERENCES hubs(id),
  service_group text NOT NULL,
  table_name text NOT NULL,
  column_name text NOT NULL,
  mapped_to text,
  status text NOT NULL CHECK (status IN ('mapped','unmapped','unexpected','missing','malformed','enum-drift')),
  rows_total integer NOT NULL DEFAULT 0,
  non_null_rows integer NOT NULL DEFAULT 0,
  distinct_values integer,
  sample_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  parse_failures integer NOT NULL DEFAULT 0,
  note text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ingestion_job_id, table_name, column_name)
);

CREATE TABLE IF NOT EXISTS source_records (
  kind text NOT NULL CHECK (kind IN ('issue','rfi','submittal','form','review','clash-group','change-order','schedule-activity')),
  id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id),
  display_id text,
  title text NOT NULL,
  status text NOT NULL,
  status_normalized text NOT NULL,
  open boolean NOT NULL,
  domain text NOT NULL,
  ciq_risk text NOT NULL DEFAULT 'none' CHECK (ciq_risk IN ('high','medium','low','none','unmapped')),
  ciq_risk_user_override boolean NOT NULL DEFAULT false,
  ciq_cost_impact text NOT NULL DEFAULT 'none' CHECK (ciq_cost_impact IN ('high','medium','low','none','unmapped')),
  ciq_root_cause text,
  type_name text,
  subtype_name text,
  root_cause text,
  root_cause_category text,
  discipline text,
  building_component text,
  location_id text,
  location_path text,
  company_id text REFERENCES companies(id),
  company_attribution text NOT NULL,
  assignee_id text,
  assignee_type text,
  owner_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  due_date timestamptz,
  closed_at timestamptz,
  responded_at timestamptz,
  cost_impact text CHECK (cost_impact IN ('yes','no','unknown')),
  schedule_impact text CHECK (schedule_impact IN ('yes','no','unknown')),
  href text,
  raw jsonb NOT NULL,
  fingerprint text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS source_records_project_idx ON source_records (project_id, kind);
CREATE INDEX IF NOT EXISTS source_records_open_idx ON source_records (project_id, open, domain);

CREATE TABLE IF NOT EXISTS issues (
  issue_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  display_id text,
  title text,
  description text,
  type_id text,
  subtype_id text,
  status text,
  assignee_id text,
  assignee_type text,
  due_date timestamptz,
  location_id text,
  owner_id text,
  root_cause_id text,
  created_at timestamptz,
  updated_at timestamptz,
  closed_at timestamptz,
  deleted_at timestamptz,
  iq_quality_risk text,
  iq_quality_user_risk text,
  iq_cost_impact text,
  iq_safety_risk_category text,
  iq_safety_hazard_category text,
  iq_safety_observation_category text,
  iq_design_root_cause text,
  iq_design_building_component text,
  fingerprint text NOT NULL,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rfis (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  custom_identifier text,
  title text,
  question text,
  status text,
  priority text,
  cost_impact text,
  schedule_impact text,
  due_date timestamptz,
  location_id text,
  rfi_type text,
  manager_id text,
  opened_at timestamptz,
  responded_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  iq_risk text,
  iq_risk_score numeric(12,6),
  iq_root_cause text,
  iq_discipline text,
  iq_building_component text,
  fingerprint text NOT NULL,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rfi_transitions (
  id text PRIMARY KEY,
  rfi_id text NOT NULL REFERENCES rfis(id),
  project_id text NOT NULL REFERENCES projects(id),
  from_status text,
  to_status text,
  created_at timestamptz NOT NULL,
  created_by text,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forms (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  template_id text,
  name text,
  number text,
  status text,
  location_id text,
  created_at timestamptz,
  updated_at timestamptz,
  closed_at timestamptz,
  fingerprint text NOT NULL,
  source_extracted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS form_questions (
  project_id text NOT NULL REFERENCES projects(id),
  template_id text NOT NULL,
  field_id text NOT NULL,
  label text,
  modifier text,
  schema_uid text,
  source_extracted_at timestamptz,
  PRIMARY KEY (project_id, template_id, field_id)
);

CREATE TABLE IF NOT EXISTS form_answers (
  form_id text NOT NULL REFERENCES forms(id),
  field_id text NOT NULL,
  value jsonb,
  normalized_value text,
  normalization_rule text,
  source_extracted_at timestamptz,
  PRIMARY KEY (form_id, field_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  name text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text NOT NULL,
  source_extracted_at timestamptz
);

CREATE TABLE IF NOT EXISTS review_tasks (
  id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES reviews(id),
  project_id text NOT NULL REFERENCES projects(id),
  status text,
  assignee_id text,
  due_date timestamptz,
  completed_at timestamptz,
  source_extracted_at timestamptz
);

CREATE TABLE IF NOT EXISTS submittals (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  title text,
  status text,
  revision integer,
  spec_id text,
  submitter_due_date timestamptz,
  manager_due_date timestamptz,
  required_on_job_date timestamptz,
  lead_time numeric,
  responsible_company_id text REFERENCES companies(id),
  created_at timestamptz,
  updated_at timestamptz,
  closed_at timestamptz,
  fingerprint text NOT NULL,
  source_extracted_at timestamptz
);

CREATE TABLE IF NOT EXISTS schedule_activities (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  start_date timestamptz,
  finish_date timestamptz,
  is_critical_path boolean,
  activity_code text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text NOT NULL,
  source_extracted_at timestamptz
);

CREATE TABLE IF NOT EXISTS risk_snapshots (
  snapshot_date date NOT NULL,
  scope text NOT NULL,
  scope_id text NOT NULL,
  domain text NOT NULL,
  metric_id text NOT NULL,
  value numeric,
  value_kind text NOT NULL,
  coverage numeric,
  algorithm_version text NOT NULL,
  provenance_id text NOT NULL REFERENCES data_provenance(id),
  calculated_at timestamptz NOT NULL,
  PRIMARY KEY (snapshot_date, scope, scope_id, domain, metric_id, algorithm_version)
);

CREATE TABLE IF NOT EXISTS risk_factors (
  snapshot_date date NOT NULL,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  domain text NOT NULL,
  factor_id text NOT NULL,
  value numeric,
  points numeric,
  detail text,
  algorithm_version text NOT NULL,
  provenance_id text NOT NULL REFERENCES data_provenance(id),
  PRIMARY KEY (snapshot_date, scope_type, scope_id, domain, factor_id, algorithm_version)
);

CREATE TABLE IF NOT EXISTS project_risk_snapshots (
  snapshot_date date NOT NULL,
  project_id text NOT NULL REFERENCES projects(id),
  domain text NOT NULL,
  risk_index numeric,
  severity text,
  exposure_index numeric,
  momentum_direction text,
  ciq_not_applicable boolean NOT NULL DEFAULT false,
  coverage numeric NOT NULL,
  algorithm_version text NOT NULL,
  provenance_id text NOT NULL REFERENCES data_provenance(id),
  PRIMARY KEY (snapshot_date, project_id, domain, algorithm_version)
);

CREATE TABLE IF NOT EXISTS subcontractor_risk_snapshots (
  snapshot_date date NOT NULL,
  company_id text NOT NULL REFERENCES companies(id),
  project_id text NOT NULL REFERENCES projects(id),
  ciq_quality_risk text,
  ciq_safety_risk text,
  derived_index numeric,
  attributed_direct integer NOT NULL DEFAULT 0,
  attributed_inferred integer NOT NULL DEFAULT 0,
  algorithm_version text NOT NULL,
  provenance_id text NOT NULL REFERENCES data_provenance(id),
  PRIMARY KEY (snapshot_date, company_id, project_id, algorithm_version)
);

CREATE TABLE IF NOT EXISTS risk_exposure_snapshots (
  snapshot_date date NOT NULL,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  domain text NOT NULL,
  exposure_index numeric,
  locations_affected integer NOT NULL DEFAULT 0,
  companies_affected integer NOT NULL DEFAULT 0,
  projects_affected integer NOT NULL DEFAULT 0,
  confirmed_cost_impact integer NOT NULL DEFAULT 0,
  potential_cost_exposure integer NOT NULL DEFAULT 0,
  unquantified_cost_impact integer NOT NULL DEFAULT 0,
  schedule_linked_items integer NOT NULL DEFAULT 0,
  critical_path_linked_items integer NOT NULL DEFAULT 0,
  algorithm_version text NOT NULL,
  provenance_id text NOT NULL REFERENCES data_provenance(id),
  PRIMARY KEY (snapshot_date, scope_type, scope_id, domain, algorithm_version)
);

CREATE TABLE IF NOT EXISTS risk_relationships (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  from_kind text NOT NULL,
  from_id text NOT NULL,
  to_kind text NOT NULL,
  to_id text NOT NULL,
  confidence text NOT NULL,
  method text NOT NULL,
  evidence text NOT NULL,
  service_owned boolean NOT NULL DEFAULT false,
  endpoint_unresolvable boolean NOT NULL DEFAULT false,
  created_at timestamptz,
  source_extracted_at timestamptz
);

CREATE TABLE IF NOT EXISTS risk_recurrence_groups (
  id text NOT NULL,
  snapshot_date date NOT NULL,
  signature text NOT NULL,
  label text NOT NULL,
  dimension text NOT NULL,
  occurrences integer NOT NULL,
  project_ids jsonb NOT NULL,
  recurrence_rate numeric NOT NULL,
  evidence jsonb NOT NULL,
  algorithm_version text NOT NULL,
  provenance_id text NOT NULL REFERENCES data_provenance(id),
  PRIMARY KEY (id, snapshot_date, algorithm_version)
);

CREATE TABLE IF NOT EXISTS mitigation_recommendations (
  id text PRIMARY KEY,
  snapshot_date date NOT NULL,
  project_id text REFERENCES projects(id),
  source_record_kind text,
  source_record_id text,
  title text NOT NULL,
  detail text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('deterministic-rule','ai-suggested')),
  rule_id text,
  confidence text,
  evidence jsonb NOT NULL,
  provenance_id text NOT NULL REFERENCES data_provenance(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
