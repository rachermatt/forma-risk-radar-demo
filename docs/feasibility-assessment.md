# Feasibility Assessment — Forma Risk Radar

The pre-implementation assessment required by the product specification before any application
code is written. It is grounded in current official Autodesk documentation and account-neutral
runtime validation requirements. Customer identifiers, portfolio counts, and extract fingerprints
are deliberately omitted from this public edition.

Detail: `docs/autodesk-data-map.md`, `docs/risk-definition-catalog.md`.

---

## 1. Feasibility assessment

**The product is buildable, and more of it is supported than a documentation-only review would
suggest** — because Construction IQ, schedule activities, RFI status transitions and the
cross-module relationship graph all ship through the Data Connector extract even though none of
them has a public REST API.

**But it is a daily snapshot-and-diff analytics application, not a real-time risk feed.** That is
not a design preference; it is forced by three hard constraints that compound:

1. Autodesk exposes genuine risk *values* only through Construction IQ.
2. Construction IQ has **no public REST API** — Data Connector is the only path.
3. Data Connector is capped at **24 extract jobs per hub per 24 hours** (rolling, and
   UI-initiated jobs consume the budget).

Everything in the specification's "Additional Enterprise Risk Intelligence" list — velocity,
persistence, concentration, recurrence, exposure, burn rate, the conversion funnel — is
**application-derived**. Autodesk supplies no rate-of-change, ageing, concentration or exposure
value anywhere, and there is no aggregate or rollup endpoint in any ACC module: every endpoint is
scoped to a single project.

### What is genuinely Autodesk-provided

A useful amount, all via the Data Connector `iq` service group:

- **Project daily quality risk** (`iq_project_daily_quality_risk_changes`) — a real Autodesk daily
  risk time series with a documented `Low/Medium/High` enum.
- **Company (subcontractor) daily quality risk and daily safety risk** — the one place Autodesk
  supplies both quality *and* safety risk at subcontractor level as first-class daily values.
- **Per-issue and per-RFI ML classifications**: quality risk, cost impact (`High/Medium/Low`),
  safety risk category, safety hazard, safety observation (`positive`/`negative`), inspection
  risk, design root cause, building components, RFI high-risk flag + score, RFI root cause, RFI
  discipline — each with a `user_*` override column distinguishing the ML prediction from a human
  correction.
- **RFI `cost_impact` and `schedule_impact`** as `Yes`/`No`/`Unknown` tri-state flags — Autodesk
  source-of-record, not CIQ. This directly satisfies the spec's requirement to separate confirmed
  impact from potential from unquantified.
- **RFI status transition history** (`rfis_rfi_transitions`) — a genuine change log, better than
  the REST layer offers.
- **Schedule activities** with `is_critical_path`, planned/actual dates and `total_slack_duration`.

### What cannot be built as specified

Three specification assumptions are factually wrong and must be corrected rather than implemented:

| Spec assumes | Reality | Supported alternative |
|---|---|---|
| Project-level "Safety Risk Today" is an Autodesk metric | `iq_project_daily_safety_risk_changes` **does not exist**. Only company-level daily safety risk exists. | Aggregate company→project, labelled application-derived. |
| Issues carry a monetary cost impact | No cost amount on an issue. CIQ is categorical only; RFIs give a flag only; change orders have **no foreign key** to an issue or RFI. | CIQ categorical impact, plus an optional per-project numeric custom attribute discovered by title at runtime. Never summed together. |
| Design issue → RFI → change order is causal | Relationship edges are untyped, undirected, binary and unattributed; Autodesk states entity order is ignored. | Undirected co-occurrence graph with creation-date ordering, captioned so causality is never implied. |

Further hard gaps, each with a documented alternative in `docs/autodesk-data-map.md` §7:
checklist pass/fail conformance (ACC Forms has **no conformance concept** — toggle answers are
normalised to True/False/NA regardless of Pass/Fail configuration); time-in-status for any module;
clash counts, severity and discipline; location hierarchy semantics; role name resolution;
account-wide queries; and real-time push for anything other than Issues, Reviews, Cost and
Data Management.

### Lessons for runtime validation

Documentation says what is possible; runtime validation establishes what is present for a given
hub. Use these account-neutral implementation requirements:

- Exclude Template, Training, and Demonstration projects from production portfolio rollups.
- Treat missing assignees as an explicit accountability signal and disclose attribution coverage.
- Treat CIQ daily tables as sparse change-logs and forward-fill them as a step function.
- Display relationship edge counts and suppress conclusions when the population is too small.
- Parse `admin_companies.trade` as tenant-configured text; never assume a universal taxonomy.

---

## 2. Autodesk data source matrix

Condensed. The full metric-by-metric matrix — every metric named in the specification, with
scopes, permissions, cadence, history and limitations — is `docs/autodesk-data-map.md`.

| Risk capability | Autodesk source | API / dataset | Direct or derived | Historical support | Confidence |
|---|---|---|---|---|---|
| Project quality risk (daily) | Construction IQ | DC `iq_project_daily_quality_risk_changes` | **Autodesk-provided** | Yes — sparse change-log, forward-fill | High |
| Subcontractor quality risk (daily) | Construction IQ | DC `iq_company_daily_quality_risk_changes` | **Autodesk-provided** | Yes — sparse | High |
| Subcontractor safety risk (daily) | Construction IQ | DC `iq_company_daily_safety_risk_changes` | **Autodesk-provided** | Documented; availability must be checked per tenant | Medium |
| Project safety risk | — | **none** | **Not available** → derived from company rollup | Via our snapshots | High (that it is absent) |
| High-risk quality issues | Construction IQ | DC `iq_issues_quality_risks` (`risk`, `user_risk`) | **Autodesk-provided** label; counts are ours | Prediction only, no version history | High |
| High-risk RFIs | Construction IQ | DC `iq_rfis_high_risk` (`risk`, `score`∈{0,1,2}) | **Autodesk-provided** | No history | High |
| Cost impact (categorical) | Construction IQ | DC `iq_cost_impact_issues` (`High/Medium/Low`) | **Autodesk-provided** | No history | High |
| Cost / schedule impact on RFIs | ACC RFIs | DC `rfis_rfis`; REST `construction/rfis/v3` | **Autodesk-provided** tri-state | Via `rfis_rfi_transitions` | High |
| Monetary cost exposure | — | **none on issues** | **Not available**; optional per-project custom attribute | n/a | High |
| Design / RFI root cause, discipline, components | Construction IQ | DC `iq_design_issues_*`, `iq_rfis_*` | **Autodesk-provided** labels | No history | High |
| Safety observation balance | Construction IQ | DC `iq_issues_safety_observations` (`positive`/`negative`) | Label Autodesk; **split and ratio derived** | Via our snapshots | High |
| Issues / RFIs / Submittals records | ACC | REST `construction/issues/v1`, `rfis/v3`, `submittals/v2`; DC equivalents | Autodesk source-of-record | Timestamps yes; transitions only via DC `activities` | High |
| Locations hierarchy | ACC | REST `construction/locations/v2`; DC `locations_nodes` | Autodesk; **tier semantics derived** | No timestamps in REST | High |
| Relationships / funnel | ACC | `bim360/relationship/v2`; DC `relationships_entity_relationship` | Autodesk edges; **direction & causality derived/never asserted** | `created_on`, `sync` feed | High |
| Clash → issue | Model Coordination | `bim360/clash/v3`; DC `clashes_assigned_clash_group.issue_id` | **Autodesk-provided** link | Clash IDs stable across versions | High |
| Schedule activities & critical path | ACC Schedule | DC `schedule_activities` only — **no REST API** | Autodesk (from the imported P6/MSP file) | Latest revision only — we must snapshot | High |
| Checklist conformance | — | ACC Forms has **no conformance concept** | **Application-defined** | Via our snapshots | High |
| Velocity / persistence / concentration / recurrence / exposure / burn rate | — | none | **Application-derived**, all of it | Our snapshots | High |

---

## 3. Proposed architecture

**Frontend / backend** — Next.js 16 App Router, React 19, TypeScript. Every APS call happens in a
server component or route handler, so the client secret cannot reach browser code by construction.

**Authentication** — APS OAuth 2.0 authorization-code flow with PKCE against
`authentication/v2`. Three-legged is mandatory: Data Connector and therefore Construction IQ
reject 2-legged tokens. Access tokens live 60 minutes, refresh tokens 15 days; refresh is rotated
and sessions are httpOnly/Secure/SameSite cookies signed with `SESSION_SECRET`. Secure Service
Accounts are the intended headless path for scheduled ingestion — **flagged as an open validation
item**, because Autodesk's own Data Connector samples say "3-legged only" and never mention SSA.

**Persistence** — PostgreSQL. Runs by default on **PGlite**, real Postgres compiled to WASM
in-process, so the app starts with no database server and no Docker; verified to support window
functions, `generate_series`, recursive CTEs, `jsonb` and `percentile_cont`, which the risk model
needs. Setting `DATABASE_URL` switches to a real Postgres server with identical schema and SQL.

**Ingestion** — a provider abstraction (`ApsAuthProvider`, `DataConnectorProvider`,
`IssuesProvider`, `RfiProvider`, `FormsProvider`, `ReviewsProvider`, `SubmittalsProvider`,
`ScheduleProvider`) so a provider can be replaced as Autodesk APIs evolve without the risk engine
or UI noticing. Data Connector supplies breadth (the only account-wide read); REST supplies
record-level timeliness for the hot subset. Nightly full snapshot job + nightly activities job
with a 3-day overlapping window, ≥8 of the 24 daily jobs reserved for retries. Idempotent by
natural key and UPSERT, so re-ingesting overlapping windows is safe.

**Snapshots** — the app owns the time dimension for everything Autodesk exposes only as current
state. Historical rows are **never** mutated when today's source state changes.

**Normalisation** — Autodesk payloads map onto the canonical model in
`src/lib/canonical/types.ts`; no UI component ever touches an Autodesk response shape. Unmapped or
malformed columns are recorded in a column report and surfaced, never silently dropped.

**Provenance** — every metric carries source system, dataset, record ID, project, extraction
timestamp, calculation timestamp, definition ID and version, and a `valueKind` of
`autodesk-provided` / `application-derived` / `ai-generated`. The type system makes this
structurally required rather than a convention.

---

## 4. Risk model — Risk × Exposure × Momentum

Deliberately **not** collapsed into one score. An executive reads three independent dimensions; an
optional composite exists but is off by default, and its weights are published wherever it appears.

**RISK — how severe is the current condition?**
Anchored on Autodesk values where they exist: Construction IQ project daily quality risk, CIQ
high-risk issue and RFI classifications, CIQ cost-impact category. Supplemented by an
application-derived 0–100 index over open high-risk counts, critical overdue counts and severity
mix. The CIQ level and the derived index are displayed **side by side and separately labelled** —
the derived index never overwrites or impersonates the Autodesk value. Where CIQ produces nothing,
the cell reads "Not Applicable", never "low".

**EXPOSURE — what could this affect?**
Locations affected, companies affected, projects affected, confirmed vs potential vs unquantified
cost impact (kept in three separate buckets, never summed), schedule-linked and critical-path-linked
items. Normalised against denominators — issues per 100 active issues, high-risk/total,
recurring/total relevant — because large complex projects naturally generate more records.
Published as the **Derived Risk Exposure Index**, labelled "not an Autodesk Construction IQ score",
with users able to switch between Autodesk risk, raw volume and normalised exposure.

**MOMENTUM — where is this going?**
1-day, 7-day and 28-day change, 7-day rolling average, acceleration (the second derivative),
consecutive elevated periods, and new-vs-resolved high-risk rates. Computed from our own daily
snapshots plus the three Autodesk CIQ daily series, forward-filled because those series are sparse
change-logs. This is what surfaces the project whose safety risk is still "Medium" but has risen
for four consecutive periods.

Every elevated item exposes **Why This Is Elevated** as an itemised list of scoring terms with the
points each contributed — no black-box ranking anywhere.

---

## 5. UX architecture

Designed for 1440×900 first. Progressive disclosure over a wall of KPI cards.

| Screen | Answers |
|---|---|
| **Portfolio Risk Command Center** | Where should I look first? Portfolio Risk/Exposure/Momentum summary, project risk matrix, risk movers (increases, improvements, **and emerging risk**), attention queue preview |
| **Attention Queue** | What should be acted on today? Ranked, with why-elevated and recommended next action per row |
| **Project Risk Detail** | Why is this project elevated? Domain breakdown, trend, contributing records, subcontractors, locations, recurring root causes, burn rate, persistence, exposure |
| **Risk Trends** | What changed? Daily/weekly/monthly, period comparison, domain filtering, new vs resolved overlay |
| **Risk Hotspots** | Where do domains overlap? Location hierarchy with multi-domain overlap scored above isolated counts |
| **Risk Concentration** | Where is risk concentrated? By company, trade, discipline, root cause, location, component |
| **Risk Burn-Down** | Are we resolving faster than we create? Created vs resolved by project, domain, subcontractor, period |
| **Subcontractor Risk** | Cross-project patterns per company — explicitly framed as a data signal requiring human review, with no permanent contractor grade |
| **Risk Conversion Funnel** | How do upstream risks propagate? Confirmed vs inferred vs no-relationship, **with edge counts shown** |
| **Risk Record Detail** | A side drawer, never a navigation away — full source record, provenance, related records, recurrence, deep link into ACC |
| **Provenance** | Where did every number come from? Source, dataset, extraction and calculation timestamps, definition version |

Global filters (hub, project, business unit, type, phase, domain, severity, company, trade,
discipline, location, root cause, status, date range, momentum, persistence, recurrence, cost and
schedule exposure) persist through drill-down. Severity is never colour-alone: every indicator
pairs colour with an icon and the words Critical/High/Medium/Low. Palette validated for
colour-vision deficiency and WCAG AA contrast.

---

## 6. V1 versus later

**V1 — build now.** Everything the acceptance criteria require: demo mode; APS auth; project
discovery; Data Connector ingestion of `admin`, `iq`, `issues`, `rfis`, `submittalsacc`, `forms`,
`locations`, `relationships`, `schedule`; the five risk domains independently; Risk/Exposure/
Momentum; today/7/30-day comparison; drill-through to records; subcontractor risk; recurrence;
persistence; concentration; location hotspots; burn rate; CIQ cost-impact and RFI cost/schedule
flags; checklist activity; the relationship graph with confidence labelling; provenance
everywhere; deterministic mitigation rules.

**V1.5 — after live validation.** Secure Service Account headless ingestion (pending open item 1);
intraday CDC deltas (pending open item 2); webhooks for Issues, Reviews and Cost; per-project
numeric cost custom attributes if portfolio coverage proves adequate; Model Coordination clash
ingestion, which requires downloading and joining three gzipped files per test.

**V2 — needs more than API access.** Checklist conformance (needs a per-template question
dictionary and customer-defined failure rules); schedule-to-risk correlation beyond adjacency;
cross-project normalisation dictionaries for issue types, RFI disciplines and LBS tiers; optional
AI suggested actions; and any controlled write-back, which needs separate approval and scope.

---

## 7. Technical risks and unknowns

Ranked by how much of the architecture collapses if the answer is unfavourable. Full list of 20 in
`docs/autodesk-data-map.md` §10.

| # | Unknown | Impact if unfavourable | Validation |
|---|---|---|---|
| 1 | Does SSA authentication work against Data Connector? | The entire headless ingestion design. Autodesk's DC samples say "3-legged only". | Mint a `jwt-bearer` token, `POST /data-connector/v1/accounts/:id/requests`. 401/403 → fall back to a stored refresh token for a service user. |
| 2 | Is `cdciq` an accepted `serviceGroup`? | Whether intraday CIQ deltas exist at all. It has a published schema but is absent from the documented delta enum. | `POST` with `serviceGroups:["cdciq"]`. |
| 3 | Does the hub qualify for CIQ across enough production projects? | CIQ excludes non-English data and several project types. | Count `iq_project_daily_quality_risk_changes` rows per eligible project. |
| 4 | Are Forms question `schema` UIDs stable across template edits? | "Same question failing repeatedly" fragments if not. | Edit a sandbox template and re-read `GET sections`. |
| 5 | Which relationship pairs are populated here? | Funnel usefulness depends on the tenant's actual edge population. | `GET relationships:writable`, then spot-check a reviewed sample of issues with UI References. |
| 6 | Data Connector job state machine semantics | Never treat `status == "complete"` as success without branching on `completionStatus`. | One `ONE_TIME` job settles it. |
| 7 | Region topology and per-module region headers | Header names differ per module; several endpoints document only US/EMEA. | 200/404 probe per region, cache per hub. |
| 8 | Any BIM 360 platform projects in the hub? | Issues v1, RFIs v3, Forms, Submittals v2 are **not compatible** with BIM 360 projects — a second code path. | `GET projects?filter[platform]=bim360`. |

**Recommended first live action:** a single `ONE_TIME` Data Connector job with
`serviceGroups: ["admin", "iq", "issues", "rfis"]` settles unknowns 2, 3 and 6 at once. The 24-job
daily budget makes each probe expensive — plan them together.
