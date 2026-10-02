# Forma Risk Radar — Risk Definition Catalog

**Status:** normative. Every number the product renders MUST trace to exactly one definition ID in
this catalog, carried on `MetricProvenance.definitionId` / `.definitionVersion`
(`src/lib/canonical/types.ts`). A value with no definition ID is a bug, not a metric.

**Catalog version:** 1.1.0 · **Scope:** reusable across configured ACC/Forma accounts

---

## 0. Naming and scope

Autodesk renamed **Autodesk Construction Cloud to "Forma"** effective **2026-03-24**. The developer
documentation set is now titled **"Forma APIs"** and lives at `/en/docs/acc/v1/`, while the runtime
base paths are unchanged: `/construction/…`, `/cost/v1/…`, `/bim360/…`, `/data-connector/v1/…`.

This is **not** Forma Site Design (ex-Spacemaker) at `/en/docs/forma/v1/`. Forma Site Design has no
Issues, RFIs, Submittals, Forms, Construction IQ or Data Connector, and is entirely out of scope.
A configured ACC/Forma account uses a bare GUID; Forma Site Design uses `pro_…` identifiers.

Where this catalog says "Forma" in a product sense it means the ACC-lineage platform. Where it names
a dataset it uses the expected **Data Connector extract table name** (underscore form, e.g.
`iq_issues_quality_risks`). The Data Connector schema service may use a dotted service-group form
for the same tables (`iq.issues_quality_risks`). Validate table names and aliases against each
account's first controlled extract before ingestion is enabled.

---

## 1. How to read a definition block

Every definition below uses the same fields.

| Field | Meaning |
|---|---|
| **Definition ID** | Stable dotted identifier. Never reused, never repurposed. Written to `MetricProvenance.definitionId`. |
| **Version** | Semver. **Patch** = wording/doc only. **Minor** = new optional input, no change to an existing value. **Major** = the number can change for unchanged input data. Old snapshots keep the version they were computed under; the UI must render the version next to any historical series that spans a major bump. |
| **Question** | The plain-English question a non-technical executive is actually asking. |
| **Formula** | Precise enough to reimplement. SQL-ish against the Data Connector extract tables, or algebraic. |
| **Inputs** | Exact table and column. If a column is not listed here and not in `docs`-referenced source files, it does not exist. |
| **Normalisation** | The denominator, stated explicitly. `n/a` means the value is a raw count and must be labelled as one. |
| **Interpretation** | What it means, and — mandatory — **how it can mislead**. |
| **Provenance** | `Autodesk-provided` (Autodesk computed the value; `valueKind: "autodesk-provided"`, `autodeskTerm` set) or **`Application-derived`** (Forma Risk Radar computed it; `valueKind: "application-derived"`, `autodeskTerm` MUST be absent). |
| **Confidence / caveats** | Expected coverage, known failure modes, and account-specific validation items. |

### 1.1 The evidence labels used throughout

Every factual claim in this catalog is tagged with one of:

- **[DOC]** — documented behaviour of the Autodesk API/dataset.
- **[VALIDATE]** — a source shape or value domain that must be confirmed against the configured
  account before the dependent metric is enabled.
- **[OURS]** — a Forma Risk Radar derivation, threshold, weight or naming decision. Not Autodesk's.

An **[OURS]** value may never be rendered with Autodesk's name attached.
"Construction IQ Quality Risk" is an Autodesk value. "Derived Risk Exposure Index" is ours.

---

## 2. Global conventions

### 2.1 Reference time

`AS_OF` is the validated timestamp of the Data Connector extract being read, **not** wall-clock
now. Confirm the metadata timestamp field during schema acceptance. Every age, overdue and window
computation uses `AS_OF`.
The UI must show `AS_OF` on every screen that renders a risk number, because the product is a
snapshot-and-diff analytics application, not a real-time feed.

Refresh cadence is hard-capped by Data Connector: *"Accounts have a limit of 24 jobs a day and
individual Users have a limit of 24 jobs a day"* **[DOC]**, rolling window, UI-initiated jobs
included. Design target is 1–3 extracts per hub per day.

### 2.2 Eligible project population — `pop.projects.eligible` (v1.0.0)

Portfolio metrics are meaningless without this filter. Accounts can contain template, training,
demonstration, component, or sample projects that must not enter production-portfolio measures.

```sql
ELIGIBLE_PROJECT :=
      admin_projects.status = <active status literal>            -- validate from the extract
  AND admin_projects.classification NOT IN ('template','component','sample')   -- [DOC]
  AND admin_projects.type NOT IN (:NON_PRODUCTION_TYPES)                        -- [OURS], configurable
```

`NON_PRODUCTION_TYPES` may be seeded with common labels such as
`{'Template Project','Training Project','Demonstration Project'}` **[OURS]**. The list is
account-configurable and the count of excluded projects is
displayed next to every portfolio figure. Hub Admin `type`, `currentPhase`, `constructionType`,
`deliveryMethod` and `contractType` are all documented as *"Any value is accepted"* **[DOC]** — they
are free text, so the `type` leg of this filter is an account-specific dictionary, not an enum.
`classification` is the exception: it is a documented, fixed set (template / component / sample) and
is the only leg of the filter that is safe to hard-code.

### 2.3 Record lifecycle states — `pop.issue.state`, `pop.rfi.state`, `pop.submittal.state` (v1.0.0)

**Issues.** The Data Connector enum is documented as **13** values
(`open, work_completed, ready_to_inspect, not_approved, in_dispute, closed, void, answered, draft,
pending, in_progress, completed, in_review`) against the REST API's **9** **[DOC]** — never union the two
sources without normalising. Validate emitted literals for the configured account and route unknown
values to an explicit ingestion warning.

```sql
ISSUE_EXCLUDED := deleted_at IS NOT NULL OR status IN ('draft','void')      -- [OURS]
ISSUE_CLOSED   := NOT ISSUE_EXCLUDED AND status IN ('closed','completed')   -- [OURS]
ISSUE_OPEN     := NOT ISSUE_EXCLUDED AND NOT ISSUE_CLOSED                   -- [OURS]
```

This partition is **[OURS]**. Autodesk publishes no open/closed grouping over the 13 statuses. The
literal membership of each bucket is configuration, is published in the UI's "How this is
calculated" panel, and a status literal that appears in an extract but not in the partition raises
an ingestion warning (`ColumnReportRow.note`) rather than being silently dropped.

**RFIs.** `RFI_OPEN := rfis_rfis.closed_at IS NULL` **[OURS]**, using the Autodesk-recorded
timestamp rather than the status string. When present, `rfis_rfi_transitions`
(`rfi_id, from_status, to_status, created_at, created_by`) provides bulk status-transition history;
validate its availability and columns per account. The REST layer documents RFI activity logs as
unsupported **[DOC]**.

**Submittals.** `SUBMITTAL_OPEN := submittalsacc_items.responded_at IS NULL` **[OURS]**.
`state_id` and `status_id` are opaque identifiers in the extract; `status_value` and `response_value`
are per-project configurable strings. Autodesk publishes **no** server-side overdue flag for any
module **[DOC]**.

### 2.4 Overdue — `risk.overdue.*` (v1.0.0)

**Every overdue value in this product is application-derived.** There is no server-side overdue
flag anywhere in ACC/Forma **[DOC]**.

```sql
ISSUE_OVERDUE     := ISSUE_OPEN     AND due_date IS NOT NULL AND due_date < AS_OF
RFI_OVERDUE       := RFI_OPEN       AND rfis_rfis.due_date IS NOT NULL AND due_date < AS_OF
SUBMITTAL_OVERDUE := SUBMITTAL_OPEN AND COALESCE(submitter_due_date, manager_due_date,
                                                 submittalsacc_steps.due_date, due_date) < AS_OF
```

**[DOC]** the correct due-date column depends on the submittal workflow state (`submitterDueDate`
for state `sbc-1`, `managerDueDate` for `mgr-1`, step `dueDate` for `rev`; `sbc-2` and void are
excluded). In the Data Connector extract `state_id` is opaque, so the state→due-date mapping is an
**open item** (§21, OI-6) and the `COALESCE` above is the interim **[OURS]** approximation. Until
OI-6 closes, submittal overdue is labelled "approximate" in the UI.

### 2.5 The "Not Applicable" rule (non-negotiable)

Absence of Construction IQ data is **never** rendered as low risk.

**[DOC]** CIQ produces no data at all for non-English project data, or for project types outside
Commercial / Healthcare / Institutional / Residential / Infrastructure→Transportation Building.
Construction IQ table availability varies by account and project. Establish coverage explicitly
from each extracted source rather than inferring it from another CIQ dataset.

```
if ciq_rows_for_scope == 0:
    render "Not Applicable — Construction IQ produced no data for this project"
    severity = null            # NOT "low", NOT "none", NOT 0
    exclude scope from any CIQ-based ranking, average or denominator
```

Documented tables such as `iq_company_daily_safety_risk_changes` and
`iq_issues_quality_categories` may be absent or empty for a configured account. Any feature
depending on an unavailable source renders Not Applicable. A separate
`iq_project_daily_safety_risk_changes` dataset is **confirmed
absent from Autodesk's documentation entirely** — see §7.4.

### 2.6 Coverage-aware weighting

Wherever a weighted index is defined below, missing inputs are handled by **renormalisation over the
available inputs**, never by substituting zero:

```
index = 100 * ( Σ_{i ∈ available} w_i * n_i ) / ( Σ_{i ∈ available} w_i )
coverage = ( Σ_{i ∈ available} w_i ) / ( Σ_{i ∈ all} w_i )
```

`coverage` is rendered as a percentage next to every index. Below `coverage < 0.60` **[OURS]** the
index is suppressed and the constituent counts are shown instead.

---

## 3. Normalisation

**This section is load-bearing. Ranking by raw volume is invalid and the product must never do it.**

### 3.1 Why raw volume is invalid

1. **Large, complex, well-instrumented projects generate more records.** A 900-issue project with a
   disciplined QA team will outrank a 40-issue project with no QA process on any raw count. The
   ranking then measures *record-keeping intensity*, not risk.
2. **Autodesk says so explicitly.** Reproduced verbatim **[DOC]**:
   > *"A project's risk level doesn't indicate whether it's well managed; instead it indicates that
   > the project has a higher than normal risk level for that day."*

   A cross-project leaderboard built on raw Construction IQ values therefore asserts something
   Autodesk explicitly declines to assert.
3. **Coverage is not uniform.** CIQ coverage can differ by source and project. A project outside
   CIQ eligibility contributes no classified issues regardless of its actual condition. Raw counts
   can therefore reward ineligibility unless source coverage is explicit.
4. **Population size is not exposure.** Two open high-risk issues in a 12-issue project is a
   materially worse condition than two in a 900-issue project.

### 3.2 The four normalisation forms this product uses

| Form | Definition ID | Numerator | Denominator | Where used |
|---|---|---|---|---|
| **Per 100 active** | `normalisation.per-100-active` | Count of records matching the risk predicate | Count of **active** records of the same kind in the same scope | Issue/RFI/submittal densities, overdue density, safety signal density |
| **Share of population** | `normalisation.share` | Count matching predicate | Count of the whole relevant population | high-risk / total, unassigned / total, share-of-total in Concentration |
| **Rate over attempts** | `normalisation.rate-over-attempts` | Failed / non-conforming events | Events actually performed | Checklist non-conformance: non-conforming answers ÷ answers given on submitted forms |
| **Recurrence rate** | `normalisation.recurrence` | Repeated similar risk events | Total **relevant** risk events (those eligible to recur under that dimension's similarity rule) | Risk Recurrence |

#### `normalisation.per-100-active` — v1.0.0

- **Question:** "How dense is this risk relative to the amount of work being tracked?"
- **Formula:** `per100 = 100 * numerator / NULLIF(active_denominator, 0)`
- **Denominator definitions [OURS]:**
  - Issues: `COUNT(*) FROM issues_issues WHERE ISSUE_OPEN` — *active* means open, not
    ever-created. Using ever-created rewards projects that never close anything.
  - RFIs: `COUNT(*) FROM rfis_rfis WHERE RFI_OPEN`
  - Submittals: `COUNT(*) FROM submittalsacc_items WHERE SUBMITTAL_OPEN`
- **Small-denominator guard [OURS]:** if `active_denominator < 20`, the normalised value is computed
  but flagged `low-sample` and excluded from cross-project ranking. A single high-risk issue in a
  3-issue project is `33.3 per 100` and would otherwise top every league table.
- **Wilson interval [OURS]:** for ranking, the product ranks on the **lower bound of a 95% Wilson
  score interval** on the proportion, not the point estimate. This is what actually stops small
  projects dominating. The point estimate is still what is displayed; the ranking key is shown on
  hover.

#### `normalisation.share` — v1.0.0

`share = numerator / NULLIF(population, 0)`, always rendered as a percentage with the absolute
numerator and denominator adjacent (`N of M`). A share with no visible denominator is
prohibited in this UI.

#### `normalisation.rate-over-attempts` — v1.0.0

`rate = failed_attempts / NULLIF(attempts_performed, 0)`. Critically, **unattempted is not failed**.
**[DOC]** the Forms values endpoint omits unanswered questions entirely. Treating missing answer
rows as failures would conflate unattempted questions with failed attempts. See §16.

#### `normalisation.recurrence` — v1.0.0

`recurrence_rate = repeated_similar_events / NULLIF(total_relevant_events, 0)`. "Relevant" excludes
events whose similarity key is null — an issue with no root cause cannot be counted as
non-recurring, because it was never eligible. See §14.

### 3.3 Denominator disclosure rule

Every normalised figure in the UI must expose, on hover or in the drill-down:
the numerator count, the denominator count, the denominator's definition ID, and `AS_OF`.

---

## 4. Forward-fill rule for Construction IQ daily tables

### `ciq.daily.forward-fill` — v1.0.0

- **Question:** "What was the Construction IQ risk level on a day with no row?"
- **Provenance:** the *values* are Autodesk-provided; the *carry-forward* and every interpolated
  point on a chart is **Application-derived**.

Treat the `_changes` tables as potentially sparse change logs. Autodesk does not document a
guaranteed row for every calendar day **[DOC]**. Measure cadence independently for each source in
the configured account; never interpret a missing daily row as a low or zero value.

**Rule:**

```sql
-- one row per (scope, calendar_day) over the requested window
WITH d AS (SELECT generate_series(:window_start, :window_end, '1 day') AS day)
SELECT d.day,
       LAST_VALUE(c.daily_risk) OVER (
         PARTITION BY c.bim360_project_id
         ORDER BY c.start_time
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS carried_daily_risk
FROM d LEFT JOIN iq_project_daily_quality_risk_changes c
  ON c.start_time::date <= d.day
```

Equivalently: **the value for day *D* is the value of the most recent row with
`start_time <= D`.** Validate the quality-table timestamp column during schema acceptance;
`iq_company_daily_safety_risk_changes` documents `start_date` **[DOC]** — note the asymmetry.

**Rendering rules [OURS]:**

1. Every CIQ trend line is a **step function**. Straight-line interpolation between change points is
   prohibited — it invents intermediate risk levels Autodesk never emitted.
2. Carried-forward points are drawn with a distinct (dashed / lighter) stroke and the tooltip reads
   *"carried forward from <date of last change>"*.
3. **Before the first row** there is no value. Render `Not Applicable`, never a back-filled level.
4. **Zero rows for the scope** → `Not Applicable` for the whole series (§2.5). A flat line at "low"
   is prohibited.
5. **Staleness badge:** if `AS_OF − last_change_date > 90 days` **[OURS]**, the tile shows
   *"last Construction IQ change N days ago"*. A project can look calm because CIQ stopped emitting,
   not because risk fell.

**Type asymmetry [DOC]:** project and company *quality* `daily_risk` are both **strings**; company
*safety* `daily_safety_risk` is a **number**. Do not share a parser. The Low / Medium / High enum is
documented **only** for `iq_project_daily_quality_risk_changes` **[DOC]**; the value set of
`iq_company_daily_quality_risk_changes.daily_risk` is **undocumented** **[DOC]** and must be censused
per extract rather than assumed identical.

**Indicator columns.** `daily_risk_indicator` is numeric with **undocumented scale** **[DOC]**.
It must not be treated as a probability, percentage, gauge, or normalised score without an
account-independent Autodesk definition. The product uses only the validated ordinal string
`daily_risk`; the indicator is shown as a raw labelled number in drill-down and nowhere else. Open
item OI-3.

---

## 5. Ordinal encodings

### `enc.severity.ordinal` — v1.0.0

`none = 0, low = 1, medium = 2, high = 3, critical = 4`. **[OURS]**

`critical` is **reserved for application-derived escalation** and is never produced by mapping an
Autodesk value — `severityFromConstructionIq()` in `types.ts` deliberately cannot return it. **[DOC]**
CIQ emits Low/Medium/High only.

Normalised form used inside indices: `sev_n = ordinal / 3` for Autodesk-sourced levels
(so `high → 1.0`), and `ordinal / 4` only where an application-derived `critical` is possible.

### `enc.ciq.case-normalisation` — v1.0.0

CIQ source tables can differ in case, separators, and serialised scalar types. Normalise on read,
never at display, while retaining the raw value for evidence. Validate each table's emitted domain
before activation. **[DOC]** the documented safety-risk enum is *Fall, Electrocution, Struck by,
caught in between, fire, other*. Match documented values on a canonical form (lowercase,
non-alphanumerics → `_`), and route every unsupported literal to `unmapped` with an ingestion
warning rather than silently bucketing it into `other`. Parse database boolean text explicitly;
never rely on JavaScript truthiness for source strings.

### `enc.ciq.user-override` — v1.0.0

**[DOC]** `user_*` columns are **human overrides** and can disagree with the ML value in the same
row. Rule **[OURS]**:

```sql
effective_risk := COALESCE(NULLIF(user_risk,''), risk)
overridden     := NULLIF(user_risk,'') IS NOT NULL
                  AND NULLIF(user_risk,'') IS DISTINCT FROM NULLIF(risk,'')
```

`RiskRecord.riskUserOverridden` is set from `overridden`, and the UI must state which of the two it
rendered. Override coverage and disagreement rates must be measured from the configured account,
not assumed.

### `enc.rfi.score` — v1.0.0

`iq_rfis_high_risk.score` is **[DOC]** a per-record numeric ML score with **undocumented range and
direction**.

**It is not a probability and must never be rendered as a percentage, a 0–100 score or a gauge.**
The product renders only the raw labelled value in drill-down and uses the validated `risk` string
as the primary signal. Open item OI-4.

---

## 6. Dimension: Risk

`RiskDimension` in `types.ts`. "How severe is the current condition?"

### 6.1 `risk.index` — v1.0.0 · **Application-derived**

- **Question:** "On a 0–100 scale, how bad is this scope's current risk condition relative to its
  own size?"
- **Formula:**

  ```
  risk.index = 100 * Σ w_i * n_i        (renormalised per §2.6 over available inputs)
  ```

| # | Input (all normalised to [0,1]) | Definition ID of input | Weight `w` **[OURS]** |
|---|---|---|---|
| r1 | Construction IQ project quality level, forward-filled, ordinal ÷ 3 | `risk.ciq.project-quality-level` | **0.25** |
| r2 | High-risk open density, per 100 active issues, capped at 25 then ÷ 25 | `risk.quality.high-open-per-100` | **0.20** |
| r3 | Overdue density, per 100 active (issues ∪ RFIs ∪ submittals), capped at 40 then ÷ 40 | `risk.overdue.density` | **0.15** |
| r4 | Safety signal density, per 100 active issues, capped at 10 then ÷ 10 | `risk.safety.signal-density` | **0.15** |
| r5 | RFI high-risk share (high ÷ classified) | `risk.rfi.high-share` | **0.10** |
| r6 | Persistence share: high-risk open older than 30 days ÷ high-risk open | `persistence.share-over-30d` | **0.15** |
| | | **Total** | **1.00** |

- **Inputs:** see each sub-definition below.
- **Normalisation:** every term is a rate or a share, never a count. Caps (25/40/10 per 100) are
  **[OURS]** and configurable; they exist so that one pathological project cannot saturate the
  index and flatten everything else.
- **Interpretation / how it misleads:**
  - r1 is zero-weighted by renormalisation for any project with no CIQ data. That project's index is
    then built from 0.75 of the weight and its `coverage` reads 75%. It is **not** comparable to a
    CIQ-eligible project's index. The UI groups CIQ-eligible and CIQ-ineligible projects separately
    in any ranking.
  - A project that closes nothing shrinks its own denominator's growth and can appear to improve.
    Always read `risk.index` alongside `burn.ratio` (§15).
  - The index is a **condition** measure, not a management-quality measure (§3.1 item 2).
- **Provenance:** **Application-derived.** `valueKind: "application-derived"`, `autodeskTerm`
  absent. Displayed as "Risk Index (Forma Risk Radar)".
- **Caveats:** validate the RFI-risk value distribution and source coverage per account. A sparse or
  degenerate distribution can make r5 weakly discriminating even when the formula is correct.

### 6.2 `risk.severity` — v1.0.0 · **Application-derived**

- **Question:** "One word: how bad is this?"
- **Formula [OURS]:**

  ```
  if ciq_rows == 0 and derived_signals == 0 : "none" with Not-Applicable annotation
  critical := risk.index >= 75  OR  risk.critical-overdue >= 1
  high     := risk.index >= 55  OR  ciq_project_quality_level = high
  medium   := risk.index >= 30  OR  ciq_project_quality_level = medium
  low      := otherwise
  ```

  Thresholds 75/55/30 are **[OURS]** and configurable.
- **Interpretation:** the `OR ciq_…` clauses guarantee that an Autodesk "High" is never displayed
  below "high", regardless of what the derived index says. The reverse escalation (`critical`) is
  ours and is labelled as such in the tooltip.
- **Caveats:** `Severity` is never communicated by colour alone (`types.ts` contract) — colour is
  always paired with the label and an icon.

### 6.3 `risk.quality.high-open` — v1.0.0 · **Application-derived count of Autodesk-provided classifications**

- **Question:** "How many currently-open issues did Construction IQ classify as high quality risk?"
- **Formula:**

  ```sql
  SELECT COUNT(*)
  FROM iq_issues_quality_risks q
  JOIN issues_issues i ON i.issue_id = q.id          -- see join note
  WHERE COALESCE(NULLIF(q.user_risk,''), q.risk) = 'high'
    AND ISSUE_OPEN(i)
    AND i.bim360_project_id = :scope
  ```

- **Inputs:** `iq_issues_quality_risks.id`, `.risk`, `.user_risk`; `issues_issues.issue_id`,
  `.status`, `.deleted_at`, `.bim360_project_id`.
- **Join note [VALIDATE]:** expected `iq_*` issue tables join on
  `iq_<table>.id → issues_issues.issue_id`. **`issues_issues` has no column named `id`** — joining
  on `id` would return an empty set. Verify these keys against the account's runtime schema before
  enabling the metric.
- **Normalisation:** none — this is a raw count. It is **never** used for cross-project ranking on
  its own; `risk.quality.high-open-per-100` (below) is.
- **Interpretation / how it misleads:** source coverage and the High/Medium/Low distribution vary
  by account. Do not widen the predicate to manufacture volume, and always treat unclassified
  Issues as **unknown**, not Low.
- **Provenance:** the classification is **Autodesk-provided** (`autodeskTerm:
  "Construction IQ Quality Risk"`); the *filter to open* and the *count* are Application-derived.
  The tile is labelled "Open issues Construction IQ rates High".
- **Caveats:** the expected `issues_issues` source has no supported severity, priority, or risk
  field. High-risk classification comes only from the validated `iq_*` sidecar. An unclassified
  Issue has no CIQ risk value.

### 6.4 `risk.quality.high-open-per-100` — v1.0.0 · **Application-derived**

`100 * risk.quality.high-open / COUNT(issues_issues WHERE ISSUE_OPEN)`, subject to
`normalisation.per-100-active` including the `low-sample` guard and Wilson lower-bound ranking.

### 6.5 `risk.critical-overdue` — v1.0.0 · **Application-derived**

- **Question:** "How many high-risk items are also past their due date?"
- **Formula:**

  ```sql
  COUNT(*) WHERE (
        issue  IS high-risk (per risk.quality.high-open predicate) AND ISSUE_OVERDUE
     OR rfi    IS high-risk (iq_rfis_high_risk.risk='high')        AND RFI_OVERDUE
     OR submittal SUBMITTAL_OVERDUE AND submittalsacc_items.revision >= 2
  )
  ```

- **Inputs:** as above plus `issues_issues.due_date`, `rfis_rfis.due_date`,
  `submittalsacc_items.submitter_due_date` / `.manager_due_date` / `.due_date` / `.revision`.
- **Normalisation:** raw count; the ranked form is `risk.critical-overdue` ÷ high-risk open.
- **Interpretation / how it misleads:** overdue is only meaningful where due dates are used. A team
  that never sets a due date scores zero here and looks safe — which is why
  `actionability.no-due-date` (§18) exists and why the Attention Queue penalises a missing due date
  rather than ignoring it.
- **Provenance:** **Application-derived** — Autodesk publishes no overdue flag **[DOC]**.
- **Caveats:** submittal leg is approximate pending OI-6.

### 6.6 `risk.ciq.project-quality-level` — v1.0.0 · **Autodesk-provided** (forward-filled by us)

- **Question:** "What did Construction IQ say this project's quality risk was, as of today?"
- **Formula:** `ciq.daily.forward-fill` applied to
  `iq_project_daily_quality_risk_changes.daily_risk` partitioned by `bim360_project_id`,
  ordered by `start_time`, evaluated at `AS_OF`.
- **Inputs:** `iq_project_daily_quality_risk_changes.bim360_project_id`, `.start_time`,
  `.daily_risk`, `.daily_risk_indicator`.
- **Normalisation:** none. Ordinal ÷ 3 when consumed by `risk.index`.
- **Interpretation / how it misleads:** **[DOC]** *"A project's risk level doesn't indicate whether
  it's well managed; instead it indicates that the project has a higher than normal risk level for
  that day."* The comparison baseline is Autodesk's, is not published, and is **not** this
  portfolio. Two projects both reading "Medium" are not thereby equivalent.
- **Provenance:** **Autodesk-provided.** `autodeskTerm: "Construction IQ Quality Risk"`,
  `sourceDataset: "iq_project_daily_quality_risk_changes"`. The *carry-forward* is ours and is
  disclosed in the tooltip.
- **Caveats:** coverage varies by project and account; a missing or empty source renders Not
  Applicable. The documented enum is Low/Medium/High **[DOC]**.

### 6.7 `risk.ciq.company-quality-level` — v1.0.0 · **Autodesk-provided** (forward-filled by us)

Same construction against `iq_company_daily_quality_risk_changes`, partitioned by
`company_id` **and** `bim360_project_id` (the table is keyed on `company_id + bim360_project_id +
bim360_account_id` **[DOC]**), ordered by `start_time`. Join `company_id → admin_companies.id`.

This is the **subcontractor risk** surface and it is the one capability where Autodesk supplies a
first-class per-company daily risk value **[DOC]**.

### 6.8 `risk.ciq.company-safety-level` — v1.0.0 · **Autodesk-provided when available**

**[DOC]** `iq_company_daily_safety_risk_changes` (`daily_safety_risk` numeric,
`daily_safety_risk_indicator`, `start_date`) exists in the schema. Validate availability
independently for the configured account. If absent or empty, render **Not Applicable**; never
substitute the quality table.

### 6.9 `risk.rfi.high-share` — v1.0.0 · **Application-derived over Autodesk classifications**

- **Question:** "What proportion of Construction-IQ-classified RFIs are flagged high risk?"
- **Formula:**

  ```sql
  SELECT COUNT(*) FILTER (WHERE risk = 'high')::float
       / NULLIF(COUNT(*), 0)
  FROM iq_rfis_high_risk WHERE bim360_project_id = :scope
  ```

- **Normalisation:** `normalisation.share`; denominator is **classified RFIs**, not all RFIs.
  Unclassified RFIs are excluded from both numerator and denominator and disclosed separately.
- **Interpretation / how it misleads:** the denominator moves as CIQ classifies more RFIs, so the
  share can fall without any RFI changing. Show the denominator.
- **Provenance:** `risk` is **Autodesk-provided** (`autodeskTerm: "Construction IQ RFI Risk"`); the
  share is Application-derived.
- **Caveats:** see `enc.rfi.score` — its scale and direction are undocumented, so it is never treated
  as a probability.

### 6.10 `risk.safety.signal-density` — v1.0.0 · **Application-derived**

- **Question:** "How much safety signal is Construction IQ producing per unit of open work?"
- **Formula:**

  ```sql
  safety_signals := COUNT(DISTINCT s.id) FROM (
      SELECT id FROM iq_issues_safety_risk         WHERE bim360_project_id = :scope
      UNION
      SELECT id FROM iq_issues_safety_hazard       WHERE bim360_project_id = :scope
      UNION
      SELECT id FROM iq_issues_safety_observations WHERE bim360_project_id = :scope
                                                     AND safety_observation_category = 'negative'
  ) s
  JOIN issues_issues i ON i.issue_id = s.id WHERE ISSUE_OPEN(i)

  density := 100 * safety_signals / NULLIF(COUNT(issues_issues WHERE ISSUE_OPEN), 0)
  ```

- **Inputs:** `iq_issues_safety_risk.id/.safety_risk_category`,
  `iq_issues_safety_hazard.id/.safety_hazard_category`,
  `iq_issues_safety_observations.id/.safety_observation_category`, `issues_issues`.
- **Normalisation:** per 100 active issues.
- **Interpretation / how it misleads:** low-volume safety-sidecar populations are dominated by
  sampling noise. The UI shows raw counts and suppresses the density when `safety_signals < 5`
  **[OURS]**.
- **Provenance:** the classifications are **Autodesk-provided**; the union, the open filter and the
  density are Application-derived. This is **not** an Autodesk safety score.
- **Caveats:** measure the share of `other` and unknown categories per account. Weight `other` lower
  in the Attention Queue (§19), and route unsupported values to `unmapped`.

### 6.11 `risk.domain.condition` — v1.0.0 · **Application-derived**

- **Question:** "Within one project and one risk domain, how elevated is the current evidence?"
- **Population:** canonical records for exactly one `(project_id, RiskDomain)` that are active at
  `AS_OF`. Records created after `AS_OF`, or closed/responded on or before it, are excluded. A
  Construction IQ classification uses the effective value after `enc.ciq.user-override`.
- **Formula [OURS]:**

  ```text
  severity_points = Σ(
    high or critical = 1.00,
    medium           = 0.60,
    low              = 0.25
  )
  severity_share = severity_points / classified_open_records
  overdue_share  = overdue_open_records / open_records
  domain_condition = 100 * (0.75 * coalesce(severity_share, 0)
                          + 0.25 * coalesce(overdue_share, 0))
  ```

  The absent component is zero only after at least one component has a denominator. If both
  denominators are empty, the result is `null` and renders "No eligible evidence", never zero.
  Severity labels use §6.2 thresholds, including the `risk.critical-overdue` escalation.
- **Current/prior comparison:** current is evaluated at `AS_OF`; prior is the stored domain
  condition snapshot at `AS_OF − 7 days`, and `change7d = current − prior`. The deterministic demo
  fixture recreates that prior point from synthetic record lifecycles. Live mode must never apply
  today's classification retroactively to a historical record population; until seven days of
  stored domain snapshots exist, prior/change is unavailable.
- **Inputs:** canonical `RiskRecord.projectId`, `.domain`, lifecycle timestamps, effective
  `.constructionIqRisk`, and the applicable due date; each contributing record is retained as a
  composite evidence key `(projectId, kind, id)`.
- **Normalisation:** within-project/domain shares only. The 75/25 weights and severity point values
  are product choices **[OURS]**.
- **Null and coverage behaviour:** an unavailable project domain is Not Applicable. An available
  domain with no eligible records is null. No value is copied from overall project risk, another
  domain, Construction IQ company risk, or attention priority.
- **Interpretation / how it misleads:** this is a compact condition indicator for domain scanning,
  not `risk.index`, not an Autodesk score, and not a causal diagnosis. Its evidence mix differs by
  domain, so it is not eligible for cross-project or cross-domain ranking. The UI may order cells
  descriptively inside a selected project but must show no rank or Wilson claim.
- **Provenance:** **Application-derived**, `definitionId: "risk.domain.condition"`, `valueKind:
  "application-derived"`, `autodeskTerm` absent. Formula inputs, both as-of timestamps, numerator
  counts, severity points, result, and full composite evidence list are stored with each value.

---

## 7. Dimension: Exposure

`ExposureDimension` in `types.ts`. "What could this affect?"

### 7.1 `exposure.index` — v1.0.0 · **Application-derived**

`exposure.index = 100 * Σ w_i * n_i`, renormalised per §2.6.

| # | Input | Definition ID | Weight **[OURS]** |
|---|---|---|---|
| e1 | Locations affected share | `exposure.locations-affected-share` | **0.20** |
| e2 | Companies affected share | `exposure.companies-affected-share` | **0.15** |
| e3 | Confirmed cost-impact density | `exposure.cost.confirmed-density` | **0.20** |
| e4 | Schedule-linked share | `exposure.schedule-linked-share` | **0.15** |
| e5 | Critical-path-linked share | `exposure.critical-path-linked-share` | **0.20** |
| e6 | Projects affected share (hub scope only; excluded at project scope) | `exposure.projects-affected-share` | **0.10** |
| | | **Total** | **1.00** |

**Critical caveat:** e4 and e5 depend on relationship coverage that can be sparse and uneven.
Below 10 supporting edges **[OURS]** these terms are marked unavailable and dropped from the
renormalisation rather than scored as 0. **A zero here means "no links recorded", not "no schedule
exposure".** Always display the supporting edge count.

### 7.2 `exposure.locations-affected` / `exposure.locations-affected-share` — v1.0.0 · **Application-derived**

- **Question:** "How much of the physical job is touched by high-risk work?"
- **Formula:**

  ```sql
  affected := COUNT(DISTINCT i.location_id)
              FROM issues_issues i JOIN iq_issues_quality_risks q ON q.id = i.issue_id
              WHERE ISSUE_OPEN(i) AND effective_risk(q) IN ('high','medium')
                AND i.location_id IS NOT NULL
  base     := COUNT(DISTINCT location_id) FROM issues_issues WHERE bim360_project_id = :scope
                AND location_id IS NOT NULL
  share    := affected / NULLIF(base, 0)
  ```

- **Inputs:** `issues_issues.location_id`, `locations_nodes` (`tree_id, parent_id, id, name, order`),
  `rfis_rfis.location_id`, `forms_forms.location_id`.
- **Normalisation:** share of locations that carry any record, **not** share of all LBS nodes — a
  project with a 500-node tree and work in 6 rooms should not read 1%.
- **Interpretation / how it misleads:** the expected `locations_nodes` source has no supported
  semantic `type` field.
  **[DOC]** Autodesk states *"the nodes in a given tier don't all have to represent the same type of
  location"*. Building / Level / Zone / Room semantics are therefore **derived from depth + regex**
  and labelled as such (`LocationNode.depth` / `.path` in `types.ts`). Counting "levels affected"
  across projects compares different things.
- **Caveats:** **[DOC]** location deletes cascade and unlink referenced objects with **no tombstone**,
  and the Locations REST API exposes **no timestamps at all** on a node (no `createdAt`/`updatedAt`/
  `createdBy`) — a historical `location_id` can become permanently unresolvable. Validate any Data
  Connector timestamps before using them; neither source guarantees a tombstone for a deleted node.
  The app must maintain a permanent `nodeId → {name, path, depth}` cache;
  unresolvable IDs render as `Unknown location (<id>)`, never dropped.

### 7.3 `exposure.companies-affected` / `-share` — v1.0.0 · **Application-derived**

- **Formula:** distinct `companyId` over open high/medium-risk records ÷ distinct companies with any
  record in scope.
- **Company attribution [OURS]** — `CompanyAttribution` in `types.ts`, in precedence order:

  | Value | Rule | Confidence |
  |---|---|---|
  | `direct` | `issues_issues.assignee_type = 'company'` → `assignee_id` is the company | certain |
  | `via-assignee-membership` | `assignee_type = 'user'` → `admin_project_users.user_id` → `.company_id` | inferred |
  | `via-owner-membership` | `issues_issues.owner_id` → same join | inferred |
  | `unattributed` | none of the above resolve | — |

- **Interpretation / how it misleads:** company attribution coverage can be incomplete. A
  "companies affected" figure describes only attributable records, so the UI shows attribution
  coverage next to the number. `assignee_type = 'role'` cannot be resolved to a
  company: **[DOC]** *"We do not currently provide endpoints to programmatically retrieve information
  about roles"* — the DC `admin_project_roles` / `admin_roles` tables are the only route, and they
  map roles to names, not to companies.
- **Caveats:** **[DOC]** a project user has exactly one company, so dual affiliation cannot be
  represented; deleted companies have their `name` overwritten with `"removed at MMDDYYYY"`,
  breaking name-keyed history — key on `admin_companies.id` only.

### 7.4 `exposure.safety.project-level` — v1.0.0 · **Application-derived — MUST NOT be called a Construction IQ value**

- **Question:** "What is this project's safety exposure?"
- **Autodesk does not answer this question.** **[DOC]** There is **no**
  `iq_project_daily_safety_risk_changes` table — confirmed absent from both the `iq` and `cdciq`
  schemas. The Insight UI's project "Safety Risk Today" card has **no extractable equivalent**.
  This is **NOT SUPPORTED**, not "limited" and not "partial".
- **Our substitute [OURS]:**

  ```
  project_safety_exposure := max over companies on the project of
                             risk.ciq.company-safety-level     -- only when independently available
                             ⊕ counts from iq_issues_safety_risk / _hazard / _observations
  ```

  If the company-safety source is unavailable, the substitute reduces to supported per-Issue safety
  classification counts (§6.10) and discloses the missing input.
- **Provenance:** **Application-derived, always.** Label verbatim:
  *"Safety exposure (Forma Risk Radar) — Autodesk does not publish a project-level safety risk
  value."* The string "Construction IQ Safety Risk" must never appear on a project-scoped tile.

### 7.5 `exposure.cost.confirmed` / `exposure.cost.potential` / `exposure.cost.unquantified` — v1.0.0

Three **counts**, never currency. **There is no monetary cost impact on a risk item.**

| Definition ID | Formula | Provenance |
|---|---|---|
| `exposure.cost.confirmed` | `COUNT(rfis_rfis WHERE cost_impact = 'Yes' AND RFI_OPEN)` + `COUNT(iq_cost_impact_issues WHERE cost_impact = 'High' AND ISSUE_OPEN)` | RFI flag: **Autodesk-provided** (source-of-record, `autodeskTerm: "RFI Cost Impact"`). CIQ categorical: **Autodesk-provided** (`autodeskTerm: "Construction IQ Cost Impact"`). The union and count: Application-derived. |
| `exposure.cost.potential` | `COUNT(rfis_rfis WHERE cost_impact = 'Unknown' AND RFI_OPEN)` + `COUNT(iq_cost_impact_issues WHERE cost_impact = 'Medium' AND ISSUE_OPEN)` | as above |
| `exposure.cost.unquantified` | Count of records in `confirmed ∪ potential` for which **no** numeric amount exists anywhere — i.e. no matching row in `issues_custom_attributes` with a numeric `attribute_data_type` and an `attribute_title` matching the configured cost-attribute title list | Application-derived |

- **Inputs:** `rfis_rfis.cost_impact` (native source-of-record value, not CIQ),
  `iq_cost_impact_issues.cost_impact`, and
  `issues_custom_attributes.attribute_title/.attribute_data_type/.attribute_value`. Validate both
  categorical domains and retain unsupported values as `unmapped`.
- **Normalisation:** `exposure.cost.confirmed-density` = per 100 active records, used by `exposure.index`.
- **Interpretation / how it misleads:**
  - **[DOC]** *"cost impact and quality risk have been developed as separate models… issues may have
    a high cost impact with a low risk level, and vice versa."* **Do not treat `cost_impact` as a
    proxy for risk**, and do not multiply them.
  - **[DOC]** RFI `costImpact` may be **disabled per project**, in which case `null` is
    indistinguishable from "no cost impact" without separately reading the RFI type configuration.
    Nulls are counted as **unknown-coverage**, never as "No".
  - Validate the cost-impact distribution per account. A degenerate category distribution may
    carry little discriminating information even when the metric is computed correctly.
- **NOT SUPPORTED, stated plainly:**
  - **A monetary cost impact on an issue is NOT SUPPORTED as a standard field.** **[DOC]** The Issues
    field whitelist contains no cost attribute. The only route is a **per-project custom attribute**
    with a per-project UUID and no reserved name, discovered by title at runtime, absent in any
    project that never configured one. **Never sum a CIQ categorical impact with a custom-attribute
    amount.**
  - **Linking real money to a risk item is NOT SUPPORTED.** **[DOC]** `cost_change_orders.source_type`
    is documented only as *"The type of entity from which the change order is created (e.g. RFI,
    Issue)"* — free text, **no enum, no companion entity ID**. There is **no `costitem` entity type**
    in the Relationships domain list, so line-level cost cannot be linked to a risk item.
  - **There is no currency normalisation.** **[DOC]** budgets carry no currency field; a configured
    account may contain projects with different currencies. The product performs no FX
    conversion and never sums across currencies.

### 7.6 `exposure.schedule-linked` / `-share` and `exposure.critical-path-linked` / `-share` — v1.0.0 · **Application-derived**

- **Question:** "How many risk items are attached to a scheduled activity, and how many of those sit
  on the critical path?"
- **Formula:**

  ```sql
  -- 1. edges from the relationship graph, in either direction (the graph is undirected)
  WITH e AS (
    SELECT r.relationship_guid,
           CASE WHEN r.item1_domain = :SCHEDULE_DOMAIN THEN r.item2_id ELSE r.item1_id END AS risk_id,
           CASE WHEN r.item1_domain = :SCHEDULE_DOMAIN THEN r.item1_id ELSE r.item2_id END AS activity_id
    FROM relationships_entity_relationship r
    WHERE r.is_deleted = 'f'
      AND (r.item1_domain = :SCHEDULE_DOMAIN OR r.item2_domain = :SCHEDULE_DOMAIN)
      AND (r.item1_entitytype = :ACTIVITY_ENTITYTYPE OR r.item2_entitytype = :ACTIVITY_ENTITYTYPE)
  )
  SELECT COUNT(DISTINCT e.risk_id)                                    AS schedule_linked,
         COUNT(DISTINCT e.risk_id) FILTER (WHERE a.is_critical_path)  AS critical_path_linked
  FROM e LEFT JOIN schedule_activities a ON a.unique_id = e.activity_id
  ```

- **Inputs:** expected `relationships_entity_relationship` columns (`item1_domain,
  item1_entitytype, item1_id, item2_domain, item2_entitytype, item2_id, created_on, deleted_on,
  is_deleted, is_service_owned`) and expected `schedule_activities` columns (`unique_id,
  is_critical_path, planned_start, planned_finish, total_slack_duration, wbs_path, type`). Validate
  the runtime columns before enabling the metric.
- **`:SCHEDULE_DOMAIN` and `:ACTIVITY_ENTITYTYPE` are configuration, read from the extract's own
  distinct-value census, not hard-coded.** Confirm exact literals per extract. Open item OI-8.
- **Normalisation:** share of open high/medium-risk records that carry at least one such edge.
- **Interpretation / how it misleads:**
  - **[DOC]** relationships are **untyped, undirected, unattributed and strictly binary**; Autodesk
    states *"relationships are bi-directional, there is no notion that a relationship can only be
    followed in a single direction"* and *"the entity order is ignored"*. Presence of an edge means
    the two records were linked — it does not mean one affects the other.
  - **[DOC]** *"Older modules that existed before relationships API was introduced do not use this
    API"* — **absence of an edge is not evidence of absence of a real connection.** A 0 here must
    read "no links recorded", never "no schedule exposure".
  - **Documented support status.** **[DOC]** linking a risk item to a schedule activity is
    **NOT SUPPORTED**: Autodesk documents the `autodesk-construction-schedule/activity` entity type
    only in an `asset ↔ activity` pairing, and there is no documented risk-item↔activity pairing.
    Any encountered risk-item/activity edges therefore use an **undocumented pairing that Autodesk
    does not commit to**. It may be absent or change without notice. Both terms ship behind the
    edge-count gate and are labelled "based on links recorded in ACC, an undocumented relationship
    pairing". The UI **must display the supporting edge count** beside every figure.
  - **[DOC]** `is_critical_path` and `total_slack_duration` are the **imported source schedule's**
    values (P6 / MSP / Asta), not Autodesk-computed. Label them "from the project schedule file".
  - **[DOC]** there is **no ACC/Forma Schedule REST API** (proven at the gateway: the schedule route
    404s while a control Issues route 401s). Schedule data is Data Connector only, latest-revision
    only, no webhooks, no on-demand refresh.
- **Provenance:** **Application-derived.**
- **Caveats:** after validating the source encoding, `is_service_owned` is carried through to
  `RiskRelationship.serviceOwned` and used as a confidence signal. Label system-created and
  user-created edges without inferring causality.

### 7.7 `exposure.projects-affected` / `-share` — v1.0.0 · **Application-derived**

Distinct eligible projects with ≥1 open high-risk record ÷ `pop.projects.eligible`. Hub scope only.
**[DOC]** there is **no account-wide or cross-project query for any ACC/Forma module** — every
endpoint is `:projectId`-scoped. Data Connector is the only account-wide read, and `projectIdList`
is capped at 50 project IDs per request.

---

## 8. Dimension: Momentum

`MomentumDimension` in `types.ts`. "Where is this going?" **Every term here is application-derived.**
**[DOC]** no Autodesk API or dataset exposes a rate-of-change value.

### 8.1 `momentum.direction` — v1.0.0 · **Application-derived**

- **Question:** "Is this getting better, holding, or getting worse — and how fast?"
- **Formula [OURS]:**

  ```
  let c7 = velocity.change-7d(risk.index), a = velocity.acceleration(risk.index)
  accelerating := c7 > +3 AND a > 0
  increasing   := c7 > +3
  improving    := c7 < -3
  stable       := otherwise            -- includes "insufficient history"
  ```

  Threshold ±3 index points over 7 days is **[OURS]** and configurable.
- **Interpretation / how it misleads:** with fewer than 8 daily snapshots, `c7` is null and the
  direction is forced to `stable` with an explicit `insufficient-history` annotation — **`stable` is
  not a positive finding**. The UI never renders `stable` in a reassuring colour when history is
  short.
- **Caveats:** the entire time dimension for everything except the three CIQ `_changes` tables is
  **owned by this application's own daily snapshots** (`SnapshotRow` in `types.ts`). Momentum before
  the first snapshot does not exist.

### 8.2 `momentum.new-high-risk-rate` / `momentum.resolved-high-risk-rate` — v1.0.0 · **Application-derived**

```sql
new_rate      := 7.0 * COUNT(high-risk records with created_at in [AS_OF-28d, AS_OF]) / 28
resolved_rate := 7.0 * COUNT(high-risk records with closed_at  in [AS_OF-28d, AS_OF]) / 28
```

Both expressed **per week** over a 28-day window **[OURS]**. Inputs: `issues_issues.created_at` /
`.closed_at`, `rfis_rfis.created_at` / `.closed_at`, joined to the CIQ risk sidecars.

**How it misleads:** a CIQ classification can be applied *after* the record was created
(`predicted_at` is separate from `created_at`; validate both fields), so "new high-risk this week" mixes newly
created records with newly *classified* older records. The product computes both variants and
labels them distinctly: `momentum.new-high-risk-rate` (by `created_at`) and
`momentum.newly-classified-rate` (by `iq_*.predicted_at`). Never conflate them.

**Caveat [DOC]:** CIQ per-record tables carry only the **current** prediction — there is no
prediction version history and no confidence value. A record that was high risk last month and low
risk today shows only "low" with a new `predicted_at`; the change is invisible unless our own
snapshot captured it.

---

## 9. Derived Risk Exposure Index (DREI)

### `index.drei` — v1.0.0 · **Application-derived**

- **Question:** "Combining how bad it is with how much it could affect, where should this scope sit
  on a single 0–100 scale?"
- **Formula:**

  ```
  index.drei = 0.60 * risk.index  +  0.40 * exposure.index          -- [OURS]
  ```

  with both sub-indices already renormalised for coverage (§2.6). `index.drei` is suppressed if
  either sub-index is suppressed.

- **Full input and weight table** (effective weight = dimension weight × within-dimension weight):

| Input | Definition ID | Dimension | Within-dim `w` | Effective `w` |
|---|---|---|---|---|
| Construction IQ project quality level (forward-filled) | `risk.ciq.project-quality-level` | Risk 0.60 | 0.25 | **0.150** |
| High-risk open density per 100 active | `risk.quality.high-open-per-100` | Risk 0.60 | 0.20 | **0.120** |
| Overdue density per 100 active | `risk.overdue.density` | Risk 0.60 | 0.15 | **0.090** |
| Safety signal density per 100 active | `risk.safety.signal-density` | Risk 0.60 | 0.15 | **0.090** |
| RFI high-risk share | `risk.rfi.high-share` | Risk 0.60 | 0.10 | **0.060** |
| Persistence share > 30 days | `persistence.share-over-30d` | Risk 0.60 | 0.15 | **0.090** |
| Locations affected share | `exposure.locations-affected-share` | Exposure 0.40 | 0.20 | **0.080** |
| Companies affected share | `exposure.companies-affected-share` | Exposure 0.40 | 0.15 | **0.060** |
| Confirmed cost-impact density | `exposure.cost.confirmed-density` | Exposure 0.40 | 0.20 | **0.080** |
| Schedule-linked share | `exposure.schedule-linked-share` | Exposure 0.40 | 0.15 | **0.060** |
| Critical-path-linked share | `exposure.critical-path-linked-share` | Exposure 0.40 | 0.20 | **0.080** |
| Projects affected share (hub scope only) | `exposure.projects-affected-share` | Exposure 0.40 | 0.10 | **0.040** |
| | | | | **1.000** |

- **Normalisation:** every input is already a rate or share on [0,1]; DREI inherits their
  denominators. DREI itself has no denominator — it is an index, not a proportion.
- **Interpretation / how it misleads:**
  - **DREI is ours.** It is displayed as **"Derived Risk Exposure Index (Forma Risk Radar)"** with
    the weight table one click away, and it never appears with an Autodesk logo, an Autodesk product
    name, or the word "Construction IQ" in its label.
  - It is **not additive across scopes**. A hub DREI is computed from hub-level numerators and
    denominators, not by averaging project DREIs.
  - **Weight changes are a major version bump.** Any snapshot stored under 1.0.0 must not be plotted
    on the same axis as one stored under 2.0.0 without a visible discontinuity marker.
  - With `coverage` below 100% the index is comparable only to other scopes at similar coverage.
    The UI sorts by DREI **within coverage bands**, not across them.
- **Provenance:** **Application-derived**, `sourceSystem: "forma-risk-radar"`.
- **Caveats:** one or more inputs may be unavailable because CIQ, relationship, or cost coverage
  differs by account and project. Render the resulting coverage explicitly; do not impute missing
  inputs or compare scopes across materially different coverage bands.

---

## 10. Risk Velocity

**Application-derived throughout. [DOC]** no rate-of-change value exists in any Autodesk dataset.

All velocity definitions operate on a **metric series** `S(d)` — one value per calendar day `d` —
built from `SnapshotRow` (`snapshotDate, scope, scopeId, domain, metricId, value`). Where the
underlying source is a CIQ `_changes` table, `S(d)` is the **forward-filled step function** of §4.

### 10.1 `velocity.change-1d` — v1.0.0

- **Question:** "How much did this move since yesterday?"
- **Formula:** `Δ1 = S(AS_OF) − S(AS_OF − 1d)`; `null` if either point is missing.
- **Normalisation:** absolute change in the metric's own units. A percentage form
  (`velocity.change-1d-pct = Δ1 / NULLIF(S(AS_OF−1d),0)`) is available but suppressed when the base
  is below 5 **[OURS]** — percentage change off a base of 1 is theatre.
- **Interpretation / how it misleads:** with a daily Data Connector extract, a 1-day change is a
  **single-observation difference** and is dominated by extract timing. **[DOC]** the activities
  replication lag is ~20 minutes and CIQ tables are change-logs — a 1-day change of 0 usually means
  "no row was emitted", not "nothing happened". `velocity.change-1d` is shown only in drill-down,
  never on an executive tile.

### 10.2 `velocity.change-7d` — v1.0.0

`Δ7 = S(AS_OF) − S(AS_OF − 7d)`. This is the **primary momentum signal** for the UI. Requires at
least 8 days of snapshots; otherwise `null` + `insufficient-history`.

### 10.3 `velocity.change-28d` — v1.0.0

`Δ28 = S(AS_OF) − S(AS_OF − 28d)`. Requires 29 days. 28 rather than 30 so that the window is exactly
4 weeks and is not distorted by weekday effects — construction record creation is strongly weekday-
seasonal **[OURS]**, which is the reason a 7-day multiple is used everywhere.

### 10.4 `velocity.rolling-average-7d` — v1.0.0

- **Formula:** `R7(d) = mean(S(d−6) … S(d))`, requiring ≥5 non-null points in the window; otherwise
  `null`. Missing days inside the window are **forward-filled first** (§4) when the series is
  CIQ-derived, and **skipped** when the series is snapshot-derived (a missing snapshot is a pipeline
  failure, not a flat value).
- **Interpretation:** R7 is what the trend line plots. Raw `S(d)` is plotted underneath as faint
  points so a reader can see how much smoothing is doing.

### 10.5 `velocity.acceleration` — v1.0.0

- **Question:** "Is it not just getting worse, but getting worse faster?"
- **Formula:**

  ```
  acceleration = ( S(AS_OF) − S(AS_OF−7d) ) − ( S(AS_OF−7d) − S(AS_OF−14d) )
               = S(AS_OF) − 2*S(AS_OF−7d) + S(AS_OF−14d)
  ```

  A discrete second difference over two consecutive 7-day windows. Requires 15 days of history.
- **Normalisation:** same units as the metric, per week².
- **Interpretation / how it misleads:** second differences are extremely noisy on short, sparse
  series. The product renders acceleration **only** as the sign qualifier inside
  `momentum.direction` (§8.1) — it is never shown as a standalone number on an executive surface,
  and it is suppressed entirely when the underlying series has fewer than 3 distinct values in
  28 days.

---

## 11. Risk Persistence

**Application-derived throughout. [DOC]** no ageing or time-in-state field exists anywhere in
ACC/Forma. Issues activities are explicitly unsupported in REST (*"We do not currently support
retrieving issue activities."*), as are RFI activity logs and submittal item activities.

### 11.1 `persistence.age-days` — v1.0.0

```sql
age_days := DATE_PART('day', AS_OF - created_at)          -- open records
```

Per record kind: `issues_issues.created_at`, `rfis_rfis.created_at`,
`submittalsacc_items.created_at`, `clashes_assigned_clash_group.created_at`,
`forms_forms.created_at`.

**Clash ageing is feasible and defensible** because **[DOC]** clash IDs are documented stable across
successive model set versions, backed by SIDs. Validate
`clashes_clash_group_to_clash_id` for group→clash membership and
`clashes_assigned_clash_group.created_at` for the group's birth. Persist on `clash.id` — **never**
on `lvid`/`rvid`, which **[DOC]** are explicitly not stable
across seed-file versions.

### 11.2 `persistence.age-bucket` — v1.0.0

- **Question:** "How much of the open high-risk load has been sitting there too long?"
- **Buckets [OURS]:** `0–7d`, `>7d`, `>14d`, `>30d`. **Cumulative, not disjoint** — an item 40 days
  old is counted in `>7d`, `>14d` and `>30d`. This is deliberate: an executive asks "how many are
  over a month old", not "how many are between 14 and 30 days old". The UI labels the buckets
  "over 7 days", "over 14 days", "over 30 days" so the cumulative reading is unambiguous.
- **Formula:**

  ```sql
  over_7  := COUNT(*) WHERE open AND high_risk AND age_days > 7
  over_14 := COUNT(*) WHERE open AND high_risk AND age_days > 14
  over_30 := COUNT(*) WHERE open AND high_risk AND age_days > 30
  ```

- **Normalisation:** `persistence.share-over-Nd = over_N / NULLIF(high_risk_open, 0)`.
  `persistence.share-over-30d` is the input to `risk.index` (r6).
- **Interpretation / how it misleads:** age measures **time since creation**, not time in the
  current state. An issue reopened after 200 days reads as 200 days old; an issue created 200 days
  ago and actively worked every week also reads as 200 days old. Time-in-status is **not available**
  (§11.4). Do not describe an age bucket as "stalled".
- **Caveats:** age is meaningless for records whose `created_at` predates the project's real start
  (bulk imports). Records older than 5 years **[OURS]** are flagged `suspect-age` and excluded from
  the ranking key.

### 11.3 `persistence.consecutive-elevated-periods` — v1.0.0

- **Question:** "For how many consecutive periods has this scope been at elevated risk?"
- **Formula:**

  ```
  elevated(d) := severity_at(d) IN ('high','critical')  OR  risk.index(d) >= 55
  consecutive := max run of elevated(d) = true ending at AS_OF, counted in PERIODS
  ```

  `PERIOD` = **1 day** for snapshot-derived series and **1 day of the forward-filled step function**
  for CIQ-derived series **[OURS]**. Threshold 55 matches `risk.severity` (§6.2).
- **Normalisation:** `n/a` — a count of periods. Also exposed as `persistence.elevated-days`.
- **Interpretation / how it misleads:** **this is the term most distorted by forward-fill.** A CIQ
  project with one old `medium` row and no later emission can appear elevated for an implausibly
  long period. The rule **[OURS]**: `consecutive-elevated-periods` computed off a CIQ-derived
  series is **capped at the number of days since the most recent CIQ row + 30**, and the tooltip
  states *"based on a value carried forward since <date>"*. When the carry-forward exceeds 90 days
  the term is suppressed and the staleness badge (§4) is shown instead.
- **Provenance:** **Application-derived.**

### 11.4 Time-in-status — **NOT SUPPORTED** (partial exception)

**[DOC]** Issues: *"We do not currently support retrieving issue activities."* RFIs: activity logs
unsupported. Submittals: item activities unsupported. Forms `lastStatusChanges` holds only the
**most recent** transition into each status.

The product therefore does **not** publish a time-in-status metric for issues, submittals or forms.

**Potential source-specific exception:** when validated, `rfis_rfi_transitions`
(`rfi_id, from_status, to_status, created_at, created_by`) can provide status-transition history for
RFIs in bulk. Where present, `persistence.rfi.time-in-status` (v1.0.0,
Application-derived) is computed as the gap between consecutive transitions for an `rfi_id`. This
metric exists **for RFIs only** and its availability is stated on the tile. The partial fallbacks
for other modules are the DC `activities` group (31-day window, 12-month lookback, ~20-minute lag
**[DOC]**), a validated `submittalsacc_item_revision` source, and
this application's own daily snapshot diffs going forward.

---

## 12. Risk Concentration

**Application-derived throughout. [DOC]** no concentration, index or ranking value is provided by
any ACC/Forma endpoint, and there is **no aggregate or rollup endpoint anywhere in ACC** — Issues
returns only `pagination.totalResults` for a filtered query. All grouping is client-side.

### 12.1 `concentration.share` — v1.0.0

- **Question:** "Is this risk spread evenly, or is it piling up in one place / one trade / one root
  cause?"
- **Formula:**

  ```sql
  SELECT :dimension_key AS key,
         COUNT(*)                                        AS count,
         COUNT(*)::float / SUM(COUNT(*)) OVER ()         AS share_of_total,
         COUNT(DISTINCT bim360_project_id)               AS projects_affected
  FROM <risk population for :scope>
  GROUP BY :dimension_key
  ORDER BY count DESC
  ```

  Maps 1:1 to `ConcentrationBucket` in `types.ts`.
- **Dimensions and their exact keys** (`ConcentrationDimension`):

| Dimension | Key source | Provenance of the key | Caveat |
|---|---|---|---|
| `company` | resolved per §7.3 attribution → `admin_companies.id` | Autodesk id; attribution **derived** | disclose unattributed coverage |
| `trade` | `admin_companies.trade`, split on `" \| "`, first segment = major trade | Autodesk free-text string | trade may be null; **[DOC]** trade exists on **no** user, project, issue, RFI, submittal or form — attributing a *record* to a trade is an inference via `user → company → trade` |
| `discipline` | `iq_rfis_disciplines.discipline` (CIQ) or `rfis_discipline.discipline` (operational) | CIQ prediction / project config | **[DOC]** the docs publish **three mutually inconsistent** discipline enum lists across three pages (29 / 13 / a third). Never merge CIQ and operational discipline into one bucket |
| `root-cause` | `issues_issues.root_cause_id` → `issues_root_causes.title`, category via `issues_root_cause_categories` | Autodesk, project-configured | UUIDs stable **within** a project, not across |
| `iq-root-cause` | `iq_design_issues_root_cause.root_cause` / `iq_rfis_root_cause.root_cause` | **Autodesk-provided ML prediction** | distinct from `root-cause`; never merged |
| `building-component` | `iq_design_issues_building_components.building_component`, `iq_rfis_building_components.building_component` | Autodesk-provided ML prediction | |
| `location` | `issues_issues.location_id` → `locations_nodes` path | Autodesk id, path **derived** | semantic node type is not supported; depth semantics derived |
| `issue-type` | `issues_issues.type_id` → `issues_issue_types.issue_type` (+ `issues_issue_subtypes`) | Autodesk, project-configured | per-project dictionaries; cross-project merge requires the normalisation layer |
| `project-type` | `admin_projects.type` | Autodesk free text | **[DOC]** *"Any value is accepted"* |
| `business-unit` | `admin_projects.business_unit_id` → `admin_business_units` | Autodesk | validate dictionary coverage per account |

- **ML value domains:** Autodesk does not document allowed root-cause, discipline, or building-
  component values **[DOC]**. Census each source independently, retain the raw value, route invalid
  values to `unmapped`, and do not assume two accounts share a dictionary.
- **Grouping note:** any composite such as "MEP RFIs" is an **application-derived grouping**
  **[OURS]** over validated discipline values. Autodesk does not define an MEP grouping.
- **Normalisation:** `share_of_total` per `normalisation.share`; the denominator is the risk
  population **within the same scope and the same dimension**, excluding null keys. Null keys are
  shown as an explicit **"Unattributed (N)"** bucket — never silently merged into `Other`.
- **Interpretation / how it misleads:** concentration inherits every bias of its key. A trade
  concentration describes only company-attributable records. The UI prints the attributable share
  above every concentration chart.
- **Provenance:** **Application-derived** (over Autodesk-provided keys, some of which are themselves
  Autodesk ML predictions — labelled per row above).

### 12.2 `concentration.top3-share` — v1.0.0 · **Application-derived**

`sum of the three largest bucket shares`. A simple, readable concentration statistic. Reported as
"the top 3 <dimension> account for X% of high-risk items (N of M)".

### 12.3 `concentration.hhi` — v1.0.0 · **Application-derived**

`HHI = Σ share_i²` over all buckets in a dimension, on [1/k, 1]. Reported only in the analyst view,
never on an executive tile. Suppressed when the dimension has fewer than 4 non-null buckets or
fewer than 20 records **[OURS]**.

---

## 13. Actionability Risk

> Placed before Recurrence because the Attention Queue and the DREI both cite it.

### 13.1 `actionability.index` — v1.0.0 · **Application-derived**

- **Question:** "Of the risk that exists, how much of it is nobody's job?"
- **Formula:**

  ```
  actionability.index = 100 * ( 0.50 * unassigned_share
                              + 0.30 * no_due_date_share
                              + 0.20 * stale_share )          -- [OURS]
  ```

  Higher = worse (less actionable). Over the **open high/medium-risk** population in scope.

| Term | Definition ID | Formula | Weight **[OURS]** |
|---|---|---|---|
| Unassigned share | `actionability.unassigned` | `COUNT(assignee_id IS NULL OR assignee_type IS NULL) / open_risk_count` | **0.50** |
| No-due-date share | `actionability.no-due-date` | `COUNT(due_date IS NULL) / open_risk_count` | **0.30** |
| Stale share | `actionability.stale` | `COUNT(updated_at < AS_OF - 30d) / open_risk_count` | **0.20** |

- **Inputs:** `issues_issues.assignee_id`, `.assignee_type`, `.due_date`, `.updated_at`;
  `rfis_rfi_assignees` (`rfi_id, oxygen_id, type, deleted_at`), `rfis_rfis.due_date`, `.updated_at`;
  `submittalsacc_items.ball_in_court`, `.ball_in_court_users`, `.ball_in_court_roles`,
  `.ball_in_court_companies`, `.updated_at`.
- **Normalisation:** three shares of the same open-risk denominator.
- **Interpretation / how it misleads:** missing ownership can be a high-signal condition, but its
  prevalence must be measured from the configured account. An unassigned issue in a small team with a daily
  standup is not the same as one in a 200-person project. Actionability is a **process** signal and
  must be presented as "these items have no named owner in Forma", not "these items are being
  ignored".
- **Provenance:** **Application-derived.** Autodesk publishes no actionability concept.
- **Caveats:** **[DOC]** the Issues API has **no user directory** — *"you can only check permissions
  for the 'current' user"* — so `assignee_id` is an opaque identifier requiring a join to
  `admin_project_users` / `admin_users`. **[DOC]** RFI `assignedTo[].type` *"will always be user"*,
  so an RFI can never be assigned to a company; do not report "RFIs assigned to companies: 0" as a
  finding. **[DOC]** role names are not resolvable via REST (*"We do not currently provide endpoints
  to programmatically retrieve information about roles"*) — join `admin_project_roles` /
  `admin_roles` on `role_id`, and where predefined roles are involved join on the role **key**, never
  the **name**, because predefined role names are localised per request language.

---

## 14. Risk Recurrence

**Application-derived throughout.** Recurrence requires stable identity for "the same thing
happening again"; Autodesk provides identity, not recurrence.

### 14.1 `recurrence.rate` — v1.0.0 · **Application-derived**

- **Question:** "How much of our risk is the same problem coming back, rather than new problems?"
- **Formula:**

  ```
  recurrence.rate = repeated_similar_events / NULLIF(total_relevant_events, 0)
  ```

  where, for a given dimension `D` and window `W` (default 180 days **[OURS]**):

  ```sql
  WITH ev AS (                       -- relevant events only: similarity key must be non-null
    SELECT signature_D(r) AS sig, r.id, r.created_at, r.bim360_project_id
    FROM risk_records r
    WHERE r.created_at BETWEEN AS_OF - W AND AS_OF
      AND signature_D(r) IS NOT NULL
  ), grp AS (
    SELECT sig, COUNT(*) AS occurrences, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen,
           ARRAY_AGG(DISTINCT bim360_project_id) AS projects_affected
    FROM ev GROUP BY sig
  )
  SELECT SUM(GREATEST(occurrences - 1, 0))::float           -- repeats: 2nd and later occurrences
       / NULLIF(SUM(occurrences), 0)                        -- total relevant events
  FROM grp;
  ```

  Maps to `RecurrenceGroup` in `types.ts` (`signature`, `occurrences`, `recurrenceRate`,
  `firstSeen`, `lastSeen`, `projectsAffected`).

- **What counts as a "repeat" [OURS]:** the **2nd and every subsequent** occurrence of a signature
  inside `W`. The first occurrence is not a repeat. A signature seen once contributes 0 to the
  numerator and 1 to the denominator.
- **What counts as "relevant" [OURS]:** an event whose similarity key for that dimension is
  **non-null**. An issue with no root cause is not "non-recurring" — it was never **eligible** to
  recur under the root-cause dimension, so it is excluded from **both** numerator and denominator.
  Excluded counts are displayed.

### 14.2 Similarity definitions — `recurrence.signature.<dimension>` — v1.0.0

**"Similar" is defined per dimension and is entirely ours.** Autodesk asserts no similarity relation
between any two records.

| Dimension | Definition ID | Signature (the "same thing") | Identity stability | Caveat |
|---|---|---|---|---|
| Issue root cause | `recurrence.signature.root-cause` | `(project_id, root_cause_id)` — cross-project form uses the normalised `issues_root_causes.title` | **[DOC]** root-cause UUIDs stable within a project, **not across** projects | cross-project recurrence requires the app's normalisation dictionary |
| CIQ root cause | `recurrence.signature.iq-root-cause` | `normalise(iq_*_root_cause.root_cause)` | value strings, stable enough to group | **[DOC]** allowed values undocumented; measure distinct-signature coverage and suppress coarse rates |
| Issue type | `recurrence.signature.issue-type` | `(project_id, type_id, subtype_id)` | per-project UUIDs | cross-project requires normalisation |
| Location | `recurrence.signature.location` | `(project_id, location_id)` at the configured LBS depth | node IDs stable until deletion | **[DOC]** deletes cascade with no tombstone — a deleted node silently ends a recurrence run |
| Company / trade | `recurrence.signature.company` | `admin_companies.id`; trade form uses the first `" \| "` segment | company IDs stable | disclose unattributed coverage |
| Building component | `recurrence.signature.building-component` | `normalise(iq_*_building_components.building_component)` | value strings | Autodesk ML prediction, undocumented value set |
| Clash | `recurrence.signature.clash` | `clashes_clash_group_to_clash_id.clash_id` | **[DOC]** clash IDs documented **stable across successive model set versions** — the strongest recurrence identity in the platform | never key on `lvid`/`rvid` |
| Submittal spec | `recurrence.signature.submittal-spec` | `submittalsacc_items.spec_id` (+ `spec_identifier`) | stable per project | |
| Checklist question | `recurrence.signature.form-question` | `forms_native_form_values.field_id` (or `field_id_v2`) → `forms_layout_section_items.uid` / `.field_id_v2`, carrying `.label` and `.modifier` | **UNVALIDATED** | **[DOC]** whether the question `schema`/UID survives a **template edit** is **not documented anywhere**. If it does not survive, checklist recurrence fragments across layout versions. Open item OI-5 — until resolved, form-question recurrence is labelled "may under-count across template revisions" |

- **Normalisation:** `normalisation.recurrence`. Also reported per group as
  `occurrences / total_relevant_events` so a single dominant signature is visible.
- **Interpretation / how it misleads:**
  - Recurrence is **not volume**. A dimension with 3 possible values will always show a high
    recurrence rate. The product reports, beside every recurrence rate, the **number of distinct
    signatures** in the denominator; below 8 distinct signatures **[OURS]** the rate is suppressed
    and the group counts are shown instead. This commonly protects coarse ML dimensions from being
    over-interpreted.
  - A rising recurrence rate can mean the classification improved, not that the problem worsened.
- **Provenance:** **Application-derived.**

---

## 15. Risk Burn Rate

`BurnRate` in `types.ts`. **Application-derived**, but well supported by Autodesk timestamps.
**[DOC]** every module exposes creation and closure timestamps with server-side range filters.

Default `periodDays = 28` **[OURS]**.

| Definition ID | v | Question | Formula | Normalisation |
|---|---|---|---|---|
| `burn.created` | 1.0.0 | "How many new risk items appeared?" | `COUNT(*) WHERE created_at BETWEEN AS_OF-periodDays AND AS_OF` | raw count; per-week form below |
| `burn.resolved` | 1.0.0 | "How many were closed out?" | `COUNT(*) WHERE closed_at BETWEEN AS_OF-periodDays AND AS_OF` | raw count |
| `burn.net` | 1.0.0 | "Did the pile grow or shrink?" | `burn.created − burn.resolved` | raw count, signed |
| `burn.backlog` | 1.0.0 | "How big is the pile now?" | `COUNT(*) WHERE open AT AS_OF` (per §2.3) | raw count |
| `burn.creation-rate-per-week` | 1.0.0 | | `7.0 * burn.created / periodDays` | per week |
| `burn.resolution-rate-per-week` | 1.0.0 | | `7.0 * burn.resolved / periodDays` | per week |
| `burn.ratio` | 1.0.0 | "Are we keeping up?" | `burn.resolved / NULLIF(burn.created, 0)` — **< 1 means the backlog is growing** | dimensionless |
| `burn.months-to-clear` | 1.0.0 | "At this rate, how long to clear the backlog?" | `burn.backlog / NULLIF(burn.resolution-rate-per-week * 4.345, 0)`; `null` when resolution rate is 0 | months |

- **Inputs:** `issues_issues.created_at` / `.closed_at` / `.status` / `.deleted_at`;
  `rfis_rfis.created_at` / `.closed_at`; `submittalsacc_items.created_at` / `.responded_at`;
  `clashes_assigned_clash_group.created_at` and `clashes_closed_clash_group.created_at`;
  `forms_forms.created_at` / `.last_submitted_at`.
- **Scoping:** `BurnRate.domain` may be a single `RiskDomain` or `"all"`. When `"all"`, the four
  record kinds are unioned; the UI must state which kinds were included, because a hub without
  submittal access produces a different "all" than one with it.
- **Interpretation / how it misleads:**
  - A burn value is available only when the complete requested half-open window is inside retained
    source history. If the current or comparison period starts before retained coverage, its counts,
    ratios, weekly buckets, breakdowns, recommendations, and lineage entries are withheld rather
    than treating uncovered days as zero. A separately labelled, fully covered 30-day metric may
    still be shown.
  - **`burn.ratio` is undefined, not 1.0, when nothing was created.** `null` renders as
    "no new items in this period", never as a healthy ratio.
  - Closing an item is not resolving a risk. `void` and `draft` transitions are excluded from
    `burn.resolved` **[OURS]** precisely because bulk-voiding inflates a resolution rate.
  - **[DOC]** Issues `filter[deleted]` is mutually exclusive — a complete population requires two
    passes. In the Data Connector path, `deleted_at` is a column and one pass suffices; if the REST
    path is ever used for the same figure, the two-pass rule applies or the population silently
    differs between sources.
  - A low `burn.ratio` or large `burn.months-to-clear` may be a genuine condition rather than a
    calculation defect. Always present absolute created, resolved, and backlog counts beside the
    ratio so the reader can judge scale and coverage.
- **Provenance:** **Application-derived.** **[DOC]** no created-vs-resolved metric exists in any
  Autodesk endpoint.

---

## 16. Checklist non-conformance

### 16.1 The Autodesk position, stated without softening

**ACC/Forma Forms has no conformance or pass/fail concept. This is NOT SUPPORTED.**

**[DOC]**, verbatim and load-bearing:

> *"This endpoint always returns normalized values: True (affirmative), False (negative), or NA (not
> applicable), regardless of the question's modifier type (yes/no, pass/fail, plus/minus)."*

Consequences **[DOC]**:
- There is **no** `conformanceType`, no non-conforming flag, no failed-item count and no score
  anywhere in the Forms schemas. The `checklists` Data Connector group (21 tables) contains no
  conformance or score column.
- Code looking for `toggleVal == "Fail"` matches **nothing**.
- To know a question *was* a Pass/Fail question you must read its `modifier` from the section
  definition, and **the legal `modifier` values are not enumerated in the documentation**.
- Unanswered questions are **silently omitted** from the values response.
- The retired BIM 360 Checklists API did have `conformanceType` (1 = conforming, 2 = non-conforming)
  but is explicitly *"not compatible with ACC projects"*.

Validate that the configured account's extract preserves these documented semantics before enabling
any derived conformance metric. A source encoding must never be guessed from apparent numeric order.

**Therefore any "failed item" definition is the application's, not Autodesk's.**

### 16.2 `conformance.question-dictionary` — v1.0.0 · **Application-derived**

- **Question:** "Which questions in this template are the ones where a negative answer means
  something bad?"
- **Formula:** build, per template layout, a dictionary from the validated
  `forms_layout_section_items` columns (`uid, layout_uid, section_uid, sort_index, label, schema,
  value_name, description, is_required, modifier, presets, type, display_index, field_id_v2`),
  keyed on `uid` and `field_id_v2`, carrying `label`, `modifier`, `type`,
  `is_required` and the owning `layout_uid` / `section_uid`.
- **A question is IN SCOPE for non-conformance when [OURS]:**
  `type` is a toggle-family type **AND** `modifier` is in the configured `NEGATIVE_MEANS_FAILURE`
  set. Because the legal `modifier` values are undocumented **[DOC]**, this set is populated from a
  distinct-value census of `forms_layout_section_items.modifier` in the configured extract and confirmed by a
  human during onboarding. It is never guessed. Open item OI-9.
- **Provenance:** **Application-derived** dictionary over Autodesk-provided template definitions.

### 16.3 `conformance.non-conformance-rate` — v1.0.0 · **Application-derived**

- **Question:** "On the inspections that were actually carried out, how often did an item come back
  negative?"
- **Formula:**

  ```sql
  WITH answered AS (
    SELECT v.native_form_id, v.field_id, v.field_id_v2, v.toggle_val
    FROM forms_native_form_values v
    JOIN forms_native_forms nf ON nf.id = v.native_form_id
    JOIN forms_forms f         ON f.native_form_id = nf.id
    JOIN forms_layout_section_items si
         ON si.uid = v.field_id OR si.field_id_v2 = v.field_id_v2
    WHERE f.last_submitted_at IS NOT NULL          -- the inspection was actually performed
      AND si.modifier IN (:NEGATIVE_MEANS_FAILURE)  -- in-scope questions only
      AND v.toggle_val IS NOT NULL                  -- unanswered are omitted, not failed
      AND v.toggle_val <> :NA_TOGGLE_CODE           -- NA is excluded from both sides
  )
  SELECT COUNT(*) FILTER (WHERE toggle_val = :NEGATIVE_TOGGLE_CODE)::float
       / NULLIF(COUNT(*), 0)
  FROM answered;
  ```

- **Inputs:** validated `forms_native_form_values` columns (`native_form_id, field_id,
  field_id_v2, toggle_val, choice_val, text_val, number_val, …`), `forms_native_forms`
  (`id, template_id, layout_uid`), `forms_forms` (`id, template_id, status, last_submitted_at,
  location_id, assignee_id, due_date`), `forms_layout_section_items`.
- **`:NEGATIVE_TOGGLE_CODE` and `:NA_TOGGLE_CODE` are configuration, not constants.** The source
  encoding of the documented True/False/NA tri-state must be validated for the configured account.
  The rate is not computed until this mapping is confirmed. Open item OI-10. Guessing here would
  invert the entire metric.
- **Normalisation:** `normalisation.rate-over-attempts`.
  **Denominator = in-scope questions that received a non-NA answer on a form that was submitted.**
  Not: all questions in the template. Not: all forms. Treating unanswered questions as failures is
  a denominator error.
- **Interpretation / how it misleads:**
  - This is **"application-defined non-conformance"** and must be labelled with that exact phrase
    wherever it appears. **[DOC]** ACC Forms has no conformance concept; this number does not exist
    in Autodesk's product and cannot be reconciled against any Autodesk report.
  - Form status distributions vary by account; `last_submitted_at IS NOT NULL` is the performance
    gate, not a status-frequency assumption.
  - A template edit that adds questions changes the denominator without any behaviour changing.
    Trend the rate **per template version** (`forms_native_forms.layout_uid`), never across layouts.
- **Provenance:** **Application-derived.** Never labelled "Autodesk checklist conformance".
- **Caveats:** table-type answers live in `forms_native_form_tabular_values` with their own
  `layout_table_column_id` join and are **excluded** from v1.0.0 of this metric.

### 16.4 `conformance.inspections-performed` — v1.0.0 · **Application-derived**

`COUNT(forms_forms WHERE last_submitted_at IS NOT NULL AND template_id IN :INSPECTION_TEMPLATES)`.
`:INSPECTION_TEMPLATES` is an account-specific list derived from validated
`forms_form_templates` columns (`id, name, status, template_type`). **[DOC]** the value set of
`template_type` is not documented, so the list is assembled during onboarding and reviewed by a
human. Open item OI-11.

### 16.5 `risk.inspection.pending` — v1.0.0 · **Autodesk-provided flag**

`iq_inspection_risk_issues.inspection_risk` is a boolean **[DOC]**. Validate its wire encoding and
parse it explicitly. It is one of the documented criteria by which CIQ flags an issue high risk (fall
hazard, water hazard, **pending safety inspection**, overdue status) **[DOC]**.

**This is not checklist conformance** and must not be counted in §16.3. It is a per-issue prediction
about a pending inspection. Validate the table's actual override/category columns; do not assume a
symmetric `user_inspection_risk` field.

---

## 17. Safety Observation Balance

### `safety.observation-balance` — v1.0.0 · **Application-derived over Autodesk classifications**

- **Question:** "When the field reports safety observations, what proportion are positive versus
  negative?"
- **Formula:**

  ```sql
  SELECT COUNT(*) FILTER (WHERE safety_observation_category = 'positive') AS positive,
         COUNT(*) FILTER (WHERE safety_observation_category = 'negative') AS negative,
         COUNT(*)                                                         AS classified_total,
         COUNT(*) FILTER (WHERE safety_observation_category = 'positive')::float
           / NULLIF(COUNT(*), 0)                                          AS positive_share
  FROM iq_issues_safety_observations
  WHERE bim360_project_id = :scope
  ```

- **Inputs:** `iq_issues_safety_observations.id`, `.safety_observation_category`, `.predicted_at`.
  Join to `issues_issues.issue_id` for title, status, location and dates (the `iq_*` tables are
  **prediction side-tables with no title, status, assignee, date or company** **[DOC]** — they are
  useless without `admin`, `issues`, `rfis` and `relationships` in the same extract).
- **Value domain:** **[DOC]** the category value set is **undocumented**. Validate the configured
  account before enabling the metric. The canonical implementation accepts only explicitly
  supported positive/negative categories; any other literal raises an ingestion warning and is
  bucketed as `unclassified`, not folded into `negative`.
- **Normalisation:** `positive_share = positive / classified_total`. The denominator is
  **CIQ-classified observations**, not all safety issues and not all issues.
- **Interpretation / how it misleads:**
  - Small classified populations are noisy. The tile is suppressed below 20 classified
    observations **[OURS]** and shows raw counts instead.
  - **[DOC]** there is **no positive-observations dataset** in ACC/Forma. The Insight UI's
    "Positive Observations" card is driven by this same classification; we are not reading a
    different, richer source.
  - A low positive share may mean the safety culture is poor, **or** that the team only files
    observations when something is wrong. The metric measures *reporting behaviour* at least as much
    as *site condition*, and the tooltip says so.
  - This is **not** a safety score and is never rolled into a project safety rating (§7.4).
- **Provenance:** the per-observation classification is **Autodesk-provided**
  (`autodeskTerm: "Construction IQ Safety Observation"`); the balance ratio is
  **Application-derived**.
- **Related, and separate — `safety.housekeeping`:** **[DOC]** Autodesk's help documents state that
  Construction IQ classifies housekeeping as `Hazard = Housekeeping, Risk = Other`, but the
  extract value domain is undocumented. The metric is not shipped in 1.0.0; validate an explicit
  source predicate before enabling it.

---

## 18. Hotspot overlap score

### `hotspot.overlap-score` — v1.0.0 · **Application-derived**

- **Question:** "Which physical locations have several *different kinds* of risk landing on them at
  once? Multi-domain overlap is what makes a hotspot, not raw count."
- **Formula:**

  ```
  For a location node L in project P, over the open high/medium-risk population:

    d_k    = count of risk records of domain k at L          (k ∈ RiskDomain)
    D      = |{ k : d_k > 0 }|                                -- distinct domains present
    N      = Σ_k d_k                                          -- total high-risk records at L
    N_hat  = min(N, CAP) / CAP,        CAP = 20               -- [OURS] volume, capped
    S      = 1 − Σ_k (d_k / N)²                               -- Simpson diversity across domains
    B      = (D − 1) / (|RiskDomain| − 1)                     -- domain breadth, 0..1

    hotspot.overlap-score = 100 * ( 0.50 * B + 0.30 * S + 0.20 * N_hat )     -- [OURS]
  ```

  A location with 40 records all of one domain scores `0.20*1.0 = 20`. A location with 6 records
  spread across 4 domains scores far higher. That is the intended behaviour.
- **Inputs:** validated `locations_nodes` columns (`tree_id, parent_id, id, name, order`);
  `issues_issues.location_id`; `rfis_rfis.location_id`; `forms_forms.location_id`;
  `clashes_assigned_clash_group.issue_id` → `issues_issues.location_id` (the clash→issue bridge);
  the CIQ risk sidecars for the high/medium filter.
- **Roll-up:** scores are computed at the **leaf** node and rolled up the `parent_id` chain by
  re-running the formula on the union of descendants — **not** by summing child scores.
- **Normalisation:** `B` and `S` are already on [0,1]; `N_hat` is capped at 20 records so a single
  enormous location cannot dominate. `Hotspot.overlapScore` in `types.ts` carries this value.
- **Interpretation / how it misleads:**
  - **[DOC]** **Submittals expose no supported location field via API**, despite the UI supporting
    it. The submittal domain can therefore
    **never** contribute to `D`, which structurally caps breadth. The UI lists which domains are
    location-capable so the score is not read as complete.
  - **[DOC]** only Issues has a descendant-aware location filter (`filter[subLocationId]`); RFI and
    Forms subtree roll-ups are client-side expansions. In the Data Connector path this is moot (we
    hold the whole tree), but a future REST path must not assume parity.
  - Location depth and naming vary by project, so comparing the same numeric tier across projects
    can compare different physical concepts. Roll-up is by **tree position**, and the
    UI shows the materialised `path`, never a numeric tier.
  - A location with no `location_id` on its records is invisible here. The UI reports the share of
    high-risk records with a null `location_id` above the hotspot list.
- **Provenance:** **Application-derived.** Autodesk publishes no hotspot, heat or overlap value.

---

## 19. Attention Queue score

### `attention.score` — v1.0.0 · **Application-derived**

- **Question:** "Of everything open right now, which twenty things should a human look at first?"
- **Formula:** additive points, evaluated per record, then
  `attention.score = LEAST(100, Σ points)`. Every term that fired is emitted as an
  `AttentionReason { code, label, points, detail }` so the ranking is never a black box
  (`AttentionItem.reasons` in `types.ts`).
- **Provenance:** **Application-derived.** The *inputs* include Autodesk-provided classifications;
  the *scoring* is entirely ours and is labelled "Attention score (Forma Risk Radar)".

#### 19.1 Complete term table — every term and its point contribution

| # | `code` | Condition | Points **[OURS]** | Input |
|---|---|---|---|---|
| 1 | `CIQ_QUALITY_HIGH` | `effective_risk(iq_issues_quality_risks) = 'high'` | **25** | `iq_issues_quality_risks.risk/.user_risk` |
| 2 | `CIQ_QUALITY_MEDIUM` | `effective_risk = 'medium'` | **10** | same |
| 3 | `CIQ_RFI_HIGH` | `iq_rfis_high_risk.risk = 'high'` | **25** | `iq_rfis_high_risk.risk` |
| 4 | `CIQ_RFI_SCORE_BAND` | validated, configured ordinal mapping only | **0 / 3 / 6** | `iq_rfis_high_risk.score`; disabled until scale/direction are validated, see `enc.rfi.score` |
| 5 | `CIQ_COST_IMPACT_HIGH` | `iq_cost_impact_issues.cost_impact = 'High'` | **12** | `iq_cost_impact_issues.cost_impact` |
| 6 | `CIQ_COST_IMPACT_MEDIUM` | `= 'Medium'` | **4** | deliberately lower than High; validate category distribution |
| 7 | `SAFETY_RISK_CATEGORISED` | row in `iq_issues_safety_risk` with `safety_risk_category <> 'other'` | **15** | `iq_issues_safety_risk` |
| 8 | `SAFETY_RISK_OTHER` | row in `iq_issues_safety_risk` with `= 'other'` | **6** | lower weight for an uncategorised signal |
| 9 | `SAFETY_HAZARD_PRESENT` | row in `iq_issues_safety_hazard` | **8** | `iq_issues_safety_hazard` |
| 10 | `SAFETY_OBSERVATION_NEGATIVE` | `safety_observation_category = 'negative'` | **6** | `iq_issues_safety_observations` |
| 11 | `OVERDUE` | `*_OVERDUE` per §2.4 | **12** | `due_date` family |
| 12 | `OVERDUE_AGE` | `+1` per full 7 days past due, **cap 10** | **0–10** | `due_date`, `AS_OF` |
| 13 | `OPEN_AGE` | `+1` per full 14 days since `created_at`, **cap 8** | **0–8** | `created_at`, `AS_OF` |
| 14 | `UNASSIGNED` | `assignee_id IS NULL OR assignee_type IS NULL` | **8** | `issues_issues.assignee_id/.assignee_type`; `rfis_rfi_assignees`; `submittalsacc_items.ball_in_court` |
| 15 | `NO_DUE_DATE` | `due_date IS NULL` and record is open | **5** | `due_date` |
| 16 | `STALE` | `updated_at < AS_OF − 30d` and record is open | **5** | `updated_at` |
| 17 | `RFI_COST_IMPACT_YES` | `rfis_rfis.cost_impact = 'Yes'` | **8** | Autodesk source-of-record flag |
| 18 | `RFI_COST_IMPACT_UNKNOWN` | `= 'Unknown'` | **3** | ditto |
| 19 | `RFI_SCHEDULE_IMPACT_YES` | `rfis_rfis.schedule_impact = 'Yes'` | **8** | Autodesk source-of-record flag |
| 20 | `RFI_SCHEDULE_IMPACT_UNKNOWN` | `= 'Unknown'` | **3** | ditto |
| 21 | `RFI_PRIORITY_HIGH` | validated `rfis_rfis.priority = 'High'` | **6** | validate the source enum |
| 22 | `SUBMITTAL_PROCUREMENT_BREACH` | `SUBMITTAL_OPEN AND (required_on_job_date − lead_time) < AS_OF` | **15** | `submittalsacc_items.required_on_job_date`, `.lead_time` — **[DOC]** a documented, defensible breach signal; `lead_time` units are an open item (OI-7) |
| 23 | `SUBMITTAL_RESUBMISSION` | `+4` per revision above 1, **cap 12** | **0–12** | `submittalsacc_items.revision`, `submittalsacc_item_revision` |
| 24 | `CLASH_LINKED` | record is the `issue_id` of a row in `clashes_assigned_clash_group` | **5** | requires a validated clash→Issue bridge |
| 25 | `SCHEDULE_LINKED` | ≥1 relationship edge to the schedule/activity domain | **6** | `relationships_entity_relationship` |
| 26 | `CRITICAL_PATH_LINKED` | that activity has `schedule_activities.is_critical_path = true` | **15** | requires validated relationship and activity sources; reason text states the supporting edge count |
| 27 | `COST_EDGE` | ≥1 relationship edge to a cost entity (`pco` etc.) | **10** | display supporting edge coverage |
| 28 | `RFI_EDGE` | Issue linked to an RFI, or vice versa | **4** | display supporting edge coverage |
| 29 | `USER_CREATED_EDGE_BONUS` | any of terms 25–28 fired on an edge validated as user-created | **+3** | indicates deliberate linking, not causality |
| 30 | `HOTSPOT_MEMBER` | record's `location_id` is in the top decile of `hotspot.overlap-score` in its project | **6** | §18 |
| 31 | `RECURRING_SIGNATURE` | record's signature has ≥3 occurrences in the last 90 days under any dimension | **7** | §14 |
| 32 | `PROJECT_MOMENTUM_WORSENING` | the record's project has `momentum.direction ∈ {increasing, accelerating}` | **5** | §8.1 |
| 33 | `CIQ_USER_OVERRIDE_DOWNGRADE` | a human override set `user_risk` **below** the ML `risk` | **−10** | `enc.ciq.user-override` — the only negative term; a human has explicitly said this is less serious |
| 34 | `CIQ_NOT_APPLICABLE` | no CIQ rows exist for this record's project | **0** | explicitly zero, never negative — absence of CIQ must not push a record **down** the queue |

**Maximum attainable raw sum is well above 100; the displayed score is clamped
(`LEAST(100, Σ)`).** When clamping occurs the UI renders `100 (capped)` and the reason list still
shows every term. Ranking uses the **unclamped** sum so that ties above 100 still order correctly;
this is stated in the drill-down.

#### 19.2 Interpretation / how it can mislead

- **The queue is a ranking, not a risk measurement.** Two records scoring 62 are not "equally
  risky"; they are adjacent in a priority order built from our weights.
- **Terms 1–10 depend on Construction IQ coverage.** An unclassified Issue can reach the queue only via the operational and derived
  terms (11–32),
  so the queue systematically under-represents unclassified work. The UI shows "N of M open records
  have Construction IQ classification" above the queue.
- **Term 14 prevalence varies by account.** Its modest weight limits ranking flattening when
  unassigned records are common. Its primary analytical home is `actionability.index` (§13).
- **Additive scoring double-counts correlated signals.** An overdue, aged, unassigned issue collects
  terms 11, 12, 13 and 14 for the same underlying condition. This is a deliberate accepted tradeoff
  in favour of explainability over statistical purity, and is disclosed in the methodology panel.
- **Weights are configuration.** Any change is a **major** version bump of `attention.score`; queues
  stored under different versions are not comparable and the UI marks the boundary.

---

## 20. Composite score (optional, OFF BY DEFAULT)

### `index.composite` — v1.0.0 · **Application-derived**

- **Question:** "If I insist on one number per project, what is it?"
- **Default state: DISABLED.** The product's central contract (`RiskExposureMomentum` in `types.ts`)
  is that **Risk, Exposure and Momentum are read independently**. Collapsing them destroys the one
  thing that makes the dashboard actionable — a high-risk / low-momentum project and a
  medium-risk / accelerating project need opposite responses and would score identically.
- **Formula (when explicitly enabled):**

  ```
  momentum_penalty = clamp( 50 + 2.5 * velocity.change-7d(risk.index), 0, 100 )   -- [OURS]

  index.composite = 0.50 * risk.index
                  + 0.30 * exposure.index
                  + 0.20 * momentum_penalty
  ```

| Component | Default weight **[OURS]** | Configurable |
|---|---|---|
| `risk.index` | **0.50** | yes |
| `exposure.index` | **0.30** | yes |
| `momentum_penalty` (from `velocity.change-7d`) | **0.20** | yes |
| | **1.00** | weights must sum to 1.00; the UI rejects any other set |

- **Transparency requirements, all mandatory when enabled:**
  1. The three weights are rendered **on the same surface as the number**, not behind a link.
  2. The three component values are rendered beside the composite.
  3. `coverage` (§2.6) is rendered beside the composite.
  4. The label is **"Composite Score (Forma Risk Radar — configurable)"**. It is never called a
     risk score, a health score, a project score, or anything containing the word "Autodesk",
     "Forma" as a product name, "Construction IQ", or "Insight".
  5. Changing any weight bumps a user-visible configuration revision stamped onto every stored
     `SnapshotRow`.
- **Interpretation / how it misleads:** a composite is a **preference statement about what matters**,
  expressed as arithmetic. It has no external validity, cannot be benchmarked, and must never be
  compared to any Autodesk-published figure. **[DOC]** Autodesk publishes no composite project score
  of any kind.
- **Provenance:** **Application-derived**, always. `valueKind: "application-derived"`,
  `autodeskTerm` absent, `sourceSystem: "forma-risk-radar"`.

---

## 21. Mandatory disclosures

These are reproduced from Autodesk's own documentation **[DOC]**. They are **not optional UI copy**.
Each one must appear on, or one interaction away from, any surface rendering the value it governs.

### 21.1 Construction IQ detection is not exhaustive

> *"Not every issue that Construction IQ identifies as high risk may be a high-risk issue.
> Conversely, Construction IQ may not detect every high-risk issue."*

**Where:** every tile, list and chart that renders a Construction IQ classification
(`risk.quality.high-open`, `risk.rfi.high-share`, `exposure.cost.*`, `safety.observation-balance`,
all `iq-*` concentration dimensions, Attention Queue terms 1–10).

### 21.2 Human overrides can disagree with the model

`user_*` columns are **human overrides** and can disagree with the ML value in the same row —
**show which one you rendered**. Implemented as `enc.ciq.user-override` and
the canonical fields `RiskRecord.constructionIqModelRisk` (model output),
`RiskRecord.constructionIqRisk` (effective rendered value), and
`RiskRecord.riskUserOverridden` (override indicator). A downward human override can reduce the
Attention Queue score; an upward override must not be labelled or scored as a downgrade.

### 21.3 A risk level is not a management judgement

> *"A project's risk level doesn't indicate whether it's well managed; instead it indicates that the
> project has a higher than normal risk level for that day."*

**Where:** every project-level CIQ tile and **every cross-project ranking**.
**Do not build a cross-project risk leaderboard from raw CIQ values without normalisation** (§3).

### 21.4 Cost impact is not a proxy for risk

> *"cost impact and quality risk have been developed as separate models… issues may have a high cost
> impact with a low risk level, and vice versa."*

**Where:** `exposure.cost.*` and anywhere the two appear together. They are never multiplied, summed
or used to fill each other in.

### 21.5 No Construction IQ data means Not Applicable, never low risk

Construction IQ produces **no data at all** for non-English project data or for project types
outside Commercial / Healthcare / Institutional / Residential / Infrastructure→Transportation
Building. **Absence must render as "Not Applicable", never as "low risk".** Implemented as §2.5 and
enforced at the canonical-model boundary, not in the UI layer.

### 21.6 Relationship edges are undirected, untyped and non-causal

> *"relationships are bi-directional, there is no notion that a relationship can only be followed in
> a single direction"* … *"the entity order is ignored"*

and

> *"Older modules that existed before relationships API was introduced do not use this API"*

**Where:** every propagation, funnel, linkage or "led to" surface. The product says **"linked"** for
a confirmed edge and **"associated"** for an inferred one (`RelationshipConfidence` in `types.ts`),
and **never** "caused". Timelines ordered by `created_on` carry the caption:
*"records linked in ACC; ordering shown by creation date; direction and causality not asserted by
Autodesk."* **Absence of an edge is not evidence of absence of a real connection.**

### 21.7 The product is daily, not live

**[DOC]** Data Connector is capped at **24 jobs per account per rolling 24 hours** (UI-initiated jobs
included), extracts are **purged after 30 days**, and signed download URLs live **60 seconds**.
There are **no webhooks** for RFIs, Submittals, Forms, Locations, Model Coordination, Schedule,
Construction IQ or Data Connector. **There is no Construction IQ REST API at all** — the `iq` Data
Connector service group is the only route, which caps the entire risk-value refresh cadence.

**Where:** the global `AS_OF` stamp, and the methodology panel.

### 21.8 Schedule criticality comes from the imported schedule file

`is_critical_path` and `total_slack_duration` are the **imported source schedule's** values
(P6 / MSP / Asta), not Autodesk-computed. Label them *"from the project schedule file"*.

### 21.9 Clash data can freeze silently

**[DOC]** `isDocumentLimitReached: true` silently freezes clash data at the 1,000-document cap with
**no error**, which a naive dashboard reads as improving coordination. Any falling clash count must
be cross-checked against this flag before it is described as improvement.

### 21.10 A permission gap is indistinguishable from "nothing happened"

**[DOC]** every module silently under-reports rather than erroring when the service identity lacks
permission: Issues returns only the caller's company's issues under company-scoped visibility;
Submittals hides draft items from non-managers and void items by default; Forms returns only
templates the user can access; Model Coordination returns **zero model sets** for an Upload-only
identity. `Project.accessible` and `Project.availableDomains` in `types.ts` exist for this reason,
and the UI must say "no access" rather than showing an empty state that reads as "no risk".

---

## 22. Open items requiring live validation

Carried forward from the feasibility synthesis. **None of these is resolved by assumption.** Each
one gates the definitions listed against it; a gated definition ships disabled or explicitly
labelled approximate.

| ID | Open question | Gates | Interim behaviour |
|---|---|---|---|
| **OI-1** | Does Secure Service Account auth work against Data Connector? **[DOC]** the Data Connector samples specify a 3-legged token; whether SSA (`jwt-bearer`) is accepted remains unproven. | The entire ingestion path, hence every definition in this catalog | Operate with a stored refresh token for an authorized service user; validate SSA separately |
| **OI-2** | Is `cdciq` accepted as a delta service group? It has a published schema but is **absent from the documented delta `serviceGroups` enum** | Intraday CIQ refresh | Assume unavailable; nightly full `iq` extract only (`iq` supports **no** date-range extraction — it is always a full extract **[DOC]**) |
| **OI-3** | What is the scale of `daily_risk_indicator`? **[DOC]** undocumented | Any numeric rendering of CIQ daily risk | Use the validated ordinal `daily_risk` string only; show the indicator as a raw labelled number in drill-down |
| **OI-4** | What is the scale and direction of `iq_rfis_high_risk.score`? **[DOC]** undocumented | `enc.rfi.score`, Attention term 4 | Keep score-derived bands disabled until validated. **Never render as a percentage** |
| **OI-5** | Is the Forms question `schema` / UID stable across template edits? **[DOC]** not documented anywhere | `recurrence.signature.form-question` | Ship with the label "may under-count across template revisions" |
| **OI-6** | Which submittal `state_id` values map to which due-date column (`sbc-1`→`submitter_due_date`, `mgr-1`→`manager_due_date`, `rev`→step due date, excluding `sbc-2`/void **[DOC]**)? `state_id` is opaque in the extract | `SUBMITTAL_OVERDUE`, `risk.critical-overdue`, Attention terms 22–23 | `COALESCE` approximation, labelled approximate |
| **OI-7** | What unit is `submittalsacc_items.lead_time` in? | Attention term 22 (`SUBMITTAL_PROCUREMENT_BREACH`) | Assume days, flag the assumption on the tile, validate against a known item |
| **OI-8** | What are the exact `item*_domain` / `item*_entitytype` literals for schedule activity and cost entities in `relationships_entity_relationship`? | `exposure.schedule-linked-*`, `exposure.critical-path-linked-*`, Attention terms 25–27 | Read the distinct-value census from each extract; never hard-code |
| **OI-9** | What are the legal values of `forms_layout_section_items.modifier`? **[DOC]** not enumerated | `conformance.question-dictionary` | Census the column and have a human confirm the `NEGATIVE_MEANS_FAILURE` set during onboarding |
| **OI-10** | How does `forms_native_form_values.toggle_val` encode the documented True / False / NA values? | `conformance.non-conformance-rate` | **Metric not computed until validated.** Guessing could invert it |
| **OI-11** | What is the value set of `forms_form_templates.template_type`? | `conformance.inspections-performed` | Human-reviewed template list assembled by name during onboarding |
| **OI-12** | Which relationship pairs are available and populated for the configured account? **[DOC]** *"not all modules make use of relationships API at this point"* | All funnel/propagation surfaces | Validate each pairing and display the supporting edge count beside every figure |
| **OI-13** | Which projects and CIQ source families are available for the configured account? | Every CIQ-derived definition | Record coverage independently by source; render unavailable populations Not Applicable and never impute |
| **OI-14** | Activities backfill depth — does an 11-month-old window return rows? **[DOC]** 12-month API-level lookback, 31-day max window, ~20-minute lag | Any baseline longer than 12 months | Baselines beyond 12 months require Autodesk's manual "Request Full Historical Activity Data" process; raise at onboarding, not go-live |
| **OI-15** | What is the configured account's ACC/Forma and region topology? | Ingestion, not definitions | Validate platform metadata and region before assuming a single code path |

---

## 23. Definition register

All definitions ship at **1.0.0**. `A` = Application-derived, `AD` = Autodesk-provided,
`AD*` = Autodesk-provided value with an application-derived transformation clearly disclosed.

| Definition ID | v | Kind | §|
|---|---|---|---|
| `pop.projects.eligible` | 1.0.0 | A | 2.2 |
| `pop.issue.state` / `pop.rfi.state` / `pop.submittal.state` | 1.0.0 | A | 2.3 |
| `risk.overdue.*` | 1.0.0 | A | 2.4 |
| `normalisation.per-100-active` | 1.0.0 | A | 3.2 |
| `normalisation.share` | 1.0.0 | A | 3.2 |
| `normalisation.rate-over-attempts` | 1.0.0 | A | 3.2 |
| `normalisation.recurrence` | 1.0.0 | A | 3.2 |
| `ciq.daily.forward-fill` | 1.0.0 | AD* | 4 |
| `enc.severity.ordinal` | 1.0.0 | A | 5 |
| `enc.ciq.case-normalisation` | 1.0.0 | A | 5 |
| `enc.ciq.user-override` | 1.0.0 | AD* | 5 |
| `enc.rfi.score` | 1.0.0 | AD* | 5 |
| `risk.index` | 1.0.0 | A | 6.1 |
| `risk.severity` | 1.0.0 | A | 6.2 |
| `risk.quality.high-open` | 1.0.0 | AD* | 6.3 |
| `risk.quality.high-open-per-100` | 1.0.0 | A | 6.4 |
| `risk.critical-overdue` | 1.0.0 | A | 6.5 |
| `risk.ciq.project-quality-level` | 1.0.0 | AD* | 6.6 |
| `risk.ciq.company-quality-level` | 1.0.0 | AD* | 6.7 |
| `risk.ciq.company-safety-level` | 1.0.0 | AD — **availability must be validated** | 6.8 |
| `risk.rfi.high-share` | 1.0.0 | A | 6.9 |
| `risk.safety.signal-density` | 1.0.0 | A | 6.10 |
| `risk.domain.condition` | 1.0.0 | A | 6.11 |
| `exposure.index` | 1.0.0 | A | 7.1 |
| `exposure.locations-affected` / `-share` | 1.0.0 | A | 7.2 |
| `exposure.companies-affected` / `-share` | 1.0.0 | A | 7.3 |
| `exposure.safety.project-level` | 1.0.0 | A — **Autodesk provides no such value** | 7.4 |
| `exposure.cost.confirmed` / `.potential` / `.unquantified` | 1.0.0 | AD* / A | 7.5 |
| `exposure.schedule-linked` / `-share` | 1.0.0 | A | 7.6 |
| `exposure.critical-path-linked` / `-share` | 1.0.0 | A | 7.6 |
| `exposure.projects-affected` / `-share` | 1.0.0 | A | 7.7 |
| `momentum.direction` | 1.0.0 | A | 8.1 |
| `momentum.new-high-risk-rate` | 1.0.0 | A | 8.2 |
| `momentum.newly-classified-rate` | 1.0.0 | A | 8.2 |
| `momentum.resolved-high-risk-rate` | 1.0.0 | A | 8.2 |
| `index.drei` | 1.0.0 | A | 9 |
| `velocity.change-1d` / `-7d` / `-28d` | 1.0.0 | A | 10.1–10.3 |
| `velocity.rolling-average-7d` | 1.0.0 | A | 10.4 |
| `velocity.acceleration` | 1.0.0 | A | 10.5 |
| `persistence.age-days` | 1.0.0 | A | 11.1 |
| `persistence.age-bucket` / `.share-over-7d` / `-14d` / `-30d` | 1.0.0 | A | 11.2 |
| `persistence.consecutive-elevated-periods` / `.elevated-days` | 1.0.0 | A | 11.3 |
| `persistence.rfi.time-in-status` | 1.0.0 | A — RFIs only | 11.4 |
| `concentration.share` | 1.0.0 | A | 12.1 |
| `concentration.top3-share` | 1.0.0 | A | 12.2 |
| `concentration.hhi` | 1.0.0 | A | 12.3 |
| `actionability.index` / `.unassigned` / `.no-due-date` / `.stale` | 1.0.0 | A | 13.1 |
| `recurrence.rate` | 1.0.0 | A | 14.1 |
| `recurrence.signature.*` (9 dimensions) | 1.0.0 | A | 14.2 |
| `burn.created` / `.resolved` / `.net` / `.backlog` / `.creation-rate-per-week` / `.resolution-rate-per-week` / `.ratio` / `.months-to-clear` | 1.0.0 | A | 15 |
| `conformance.question-dictionary` | 1.0.0 | A | 16.2 |
| `conformance.non-conformance-rate` | 1.0.0 | A — **gated by OI-10** | 16.3 |
| `conformance.inspections-performed` | 1.0.0 | A | 16.4 |
| `risk.inspection.pending` | 1.0.0 | AD | 16.5 |
| `safety.observation-balance` | 1.0.0 | AD* | 17 |
| `safety.housekeeping` | — | **not shipped in 1.0.0** — source predicate unvalidated | 17 |
| `hotspot.overlap-score` | 1.0.0 | A | 18 |
| `attention.score` (34 terms) | 1.0.0 | A | 19 |
| `index.composite` | 1.0.0 | A — **off by default** | 20 |

### 23.1 Versioning rules

- A definition ID is **never** reused for a different concept, and **never** deleted — retired
  definitions are marked retired with the version at which they stopped being written.
- **Patch** (`1.0.0 → 1.0.1`): documentation, wording, tooltip copy. Values unchanged.
- **Minor** (`1.0.0 → 1.1.0`): a new optional input, a new caveat, a widened value domain. No stored
  value changes.
- **Major** (`1.0.0 → 2.0.0`): any weight change, threshold change, denominator change, population
  change, or formula change. Stored `SnapshotRow`s keep their original version; any chart spanning a
  major boundary renders a visible discontinuity marker and both versions in the legend.
- Every `Measured<T>` written to a snapshot carries `definitionId` **and** `definitionVersion`. A
  snapshot without both is rejected at ingest.
