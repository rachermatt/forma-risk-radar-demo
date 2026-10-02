# Forma Risk Radar — Setup

> **Reference only:** This document is inherited from the upstream sample and describes its
> separate, unfinished live-data foundation. It does not describe the runtime of this demo-only
> repository. Autodesk authentication routes are not registered here, `DATA_MODE` cannot enable
> live data, and no credentials or database are required. Use [Demo setup](setup.md) instead.

Audience: a senior engineer standing this up in demo mode (no Autodesk account required) or
preparing the deliberately gated work required for a configured ACC/Forma hub.

Three labels are used throughout this document and throughout the product. They are not decorative:

| Label | Meaning |
|---|---|
| **DOCUMENTED** | Stated in current official Autodesk documentation. |
| **OBSERVED** | Empirical schema behavior that must be revalidated for each account; no tenant identifiers or populations are included. |
| **DERIVED** | Computed by this application. Never attributable to Autodesk. |

---

## 0. Naming, once, clearly

Autodesk Construction Cloud was renamed **Forma** effective **2026-03-24**. The API documentation set
is now titled "Forma APIs" and lives at `/en/docs/acc/v1/`, while the base paths are unchanged:
`/construction/…`, `/cost/v1/…`, `/bim360/…`, `/data-connector/v1/…`.

This is **not** Forma Site Design (formerly Spacemaker), whose docs are at `/en/docs/forma/v1/`. Forma
Site Design has no Issues, RFIs, Submittals, Forms, Construction IQ or Data Connector and is entirely
out of scope for this product. A quick discriminator: an ACC/Forma hub id is a bare GUID; Forma Site
Design uses `pro_…` identifiers. Validate the configured account identifier before provider calls.

Throughout this document "the hub" means the ACC/Forma **account**.

---

## 1. Prerequisites

| Requirement | Detail |
|---|---|
| Node.js | **22 or newer.** Verified on 24.19.0. `package.json` pins `@types/node` 24.x. |
| npm | Ships with Node. No other package manager is configured. |
| PostgreSQL server | **Not required.** See below. |
| Docker | **Not required.** Nothing in the default path containerises. |
| Autodesk credentials | **Not required for demo mode.** Required only for `DATA_MODE=autodesk`. |
| Disk | A few hundred MB for `node_modules`, plus the PGlite data directory (`.data/pg` by default). Extract size depends on enabled service groups and tenant activity; measure the first controlled run. |

### Why there is no database to install

The persistence foundation is PostgreSQL. Local migration and seed commands use **PGlite**
(`@electric-sql/pglite`), which is real PostgreSQL compiled to WASM and running in-process. The
current synthetic dashboard is generated in memory and does not require or query the seeded store.
No server, no port, no Docker, no `initdb` is needed. PGlite has been verified to support everything
the target persistence-backed risk model needs:

- window functions (velocity, momentum, rank-within-project)
- `generate_series` (dense date spines for forward-filling the sparse Construction IQ daily tables)
- recursive CTEs (location tree materialisation)
- `jsonb` (raw source rows preserved for drill-down, per `RiskRecord.raw`)
- `percentile_cont` (exposure and concentration distributions)

Setting `DATABASE_URL` selects a real PostgreSQL server for the implemented database/session
foundation and seed command. The schema and SQL adapters do not branch on engine. Use a server for
production authentication and, after the live query path is implemented, for multiple app instances,
external BI access, or backups you control.

External PostgreSQL has a deliberate privilege boundary. The long-running web role in
`DATABASE_URL` should have application DML permissions but no DDL. At startup the web process only
reads `schema_migrations`, verifies every known checksum, and fails closed if the database is not
ready. It never creates a table, takes a migration lock, or applies a migration. Run the one-off
migration command first with a separately injected DDL-capable credential:

```bash
MIGRATION_DATABASE_URL='postgres://migration_user:…@host/db' npm run db:migrate
DATABASE_URL='postgres://app_user:…@host/db' npm start
```

`db:migrate` deliberately ignores `DATABASE_URL`; this prevents a deployment mistake from silently
turning the web credential into a migration credential. Production should inject
`MIGRATION_DATABASE_URL` only into the migration job, not into the web runtime. PGlite remains
zero-setup and applies the same immutable migration plan automatically in the local process.

Every non-loopback PostgreSQL hostname uses TLS with server-certificate verification and requests
channel binding when the server offers it. Plaintext is accepted only for `localhost`, `127.0.0.1`,
and `::1`. Do not add query parameters or fragments to either URL: node-postgres can let URL
parameters replace connection identity or programmatic TLS settings, so the application rejects
all of them. Use a server certificate chained to a CA trusted by Node.js.

Production Autodesk authentication requires shared PostgreSQL (`DATABASE_URL`); PGlite is a
single-process local engine and is rejected for production sessions. Schedule the bounded session
maintenance command with the runtime DML credential (hourly is the recommended starting policy):

```bash
DATABASE_URL='postgres://app_user:…@host/db' npm run sessions:sweep
```

The command verifies migrations without DDL, drains up to 10,000 expired sessions in 100-row
batches, and atomically appends their audit records. Exit code 2 means the cap was reached and a
follow-up run is required. Do not run this command against `PGLITE_DIR`; local expired sessions are
removed when accessed, and embedded storage is not an authorized production topology.

External connection waits are finite rather than relying on `pg`'s unbounded defaults:

| Workload | Pool | Connect/acquire | Lock | Server statement | Client query | Idle / lifetime |
|---|---:|---:|---:|---:|---:|---:|
| Web runtime | 8 | 5 s | 5 s | 30 s | 35 s | 30 s / 5 min |
| Migration command | 1 | 10 s | 15 s | 5 min | 310 s | 10 s / 15 min |
| Demo seed on PostgreSQL | 4 | 10 s | 10 s | 60 s | 65 s | 30 s / 10 min |

The client deadline intentionally trails the server deadline, giving PostgreSQL time to cancel the
statement and return its bounded error before the client stops waiting. Idle-in-transaction time is
also capped at the corresponding server statement limit. All connection-URL query parameters and
fragments are rejected. This includes identity overrides such as `host`, `port`, `user`, `password`,
and `database`, timeout/`options` settings, and every `ssl*` parameter. This matters because `pg`
otherwise lets URL parameters override URL authority and object-level safety settings. A fixed
process-owned `options` value also prevents `PGOPTIONS` from disabling the bounds.

---

## 2. Quick start — demo mode

```bash
git clone <repo> forma-risk-radar
cd forma-risk-radar
cp .env.example .env.local     # defaults are already demo-mode safe
npm install
npm run dev
```

Open **http://localhost:8080**. The port is fixed at 8080 by `npm run dev` (`next dev -p 8080`) so it
matches the default `APS_CALLBACK_URL`.

No Autodesk credentials are needed. `DATA_MODE=demo` is the default in `.env.example`, and in that
mode no provider ever constructs an APS request.

Optional: `npm run seed:demo` regenerates the synthetic dataset explicitly. `npm run dev` is expected
to work without it. Against PGlite, the seed applies the local immutable migration plan as before.
Against `DATABASE_URL`, the seed is DML-only: migrate first with `npm run db:migrate`, then opt in
with `ALLOW_DEMO_SEED_TO_DATABASE_URL=true`. A missing or drifted migration makes the seed fail
without creating or altering schema objects.

### Demo data is synthetic and is labelled as such

Demo mode is not a masked copy of a customer hub. It is generated data. Every metric produced in demo
mode carries `provenance.sourceSystem = "demo-generator"` (see
`src/lib/canonical/types.ts`, `SourceSystem`), and the UI renders a persistent synthetic-data banner
plus per-metric provenance. Do not screenshot demo mode into anything that implies it is a real
portfolio.

Demo mode is faithful about *shape*, deliberately, so that the honesty constraints stay visible:

- sparse Construction IQ daily rows that require bounded forward-fill
- unassigned issues that preserve missing accountability data rather than inventing an owner
- a deliberately thin cross-module relationship graph whose views disclose sample size
- some projects with **no** Construction IQ rows at all, rendering as "Not Applicable"

---

## 3. Preparing live Autodesk activation

> **This section is prerequisites, not a working "switch."** The current application implements
> secure OAuth/session handling, bounded read transports, Data Connector request/download guards,
> provider contracts, and the executable persistence schema. It does not yet implement extract
> ZIP/CSV mapping, live ingestion orchestration, or persistence-backed dashboard queries.
> `DATA_MODE=autodesk` renders an activation gate and `/api/readiness` returns
> `503 activation-required`; it never displays the synthetic portfolio as live data. No first
> extract is submitted by setting these variables.

To exercise the activation checks, set `DATA_MODE=autodesk` and fill in the applicable prerequisites.
Every variable in `.env.example`:

| Variable | Required when | Notes |
|---|---|---|
| `DATA_MODE` | always | `demo` or `autodesk`. Default `demo`. In `demo` no APS call is ever made. |
| `APP_ORIGIN` | optional | Canonical deployment origin used for metadata. Default `http://localhost:8080`. |
| `APS_CLIENT_ID` | `autodesk` | From https://aps.autodesk.com/myapps. This exact string must also be registered by a hub admin under Custom Integrations — see §5. |
| `APS_CLIENT_SECRET` | `autodesk` | Server-side only. The app is a Traditional Web App (§4); the secret never reaches the browser. |
| `APS_CALLBACK_URL` | `autodesk` | Must match a callback registered on the APS app **exactly** — scheme, host, port, path, trailing slash. Default `http://localhost:8080/api/aps/callback`. |
| `APS_SCOPES` | `autodesk` | Space-delimited, reviewed minimum scope set. Data Connector may require write-named OAuth scopes for extract creation even though V1 never mutates project records. There is deliberately no built-in default while exact scopes remain a live validation item. |
| `APS_DATA_CONNECTOR_DOWNLOAD_HOSTS` | before live extract download | Exact comma/space-delimited DNS hostnames observed from and approved after the first signed-download response. No wildcard/default is invented; downloads remain activation-gated while empty. Redirects are manual and every hop must remain HTTPS on this allowlist. |
| `ACC_ACCOUNT_ID` | `autodesk` | **The bare account GUID, with no `b.` prefix.** Example: `<ACC_ACCOUNT_ID>`. See the ID rules below. |
| `ACC_REGION` | optional | `US` \| `EMEA` are currently validated. Leave blank to run the explicit region probe (§7); Hub Admin does not auto-route. |
| `PGLITE_DIR` | optional | Embedded Postgres data directory. Default `.data/pg`. Delete it to reset local state. |
| `DATABASE_URL` | production Autodesk auth; otherwise optional | Runtime `postgres://…` credential. When set it **wins over** `PGLITE_DIR`. Use a DML-only role; web startup verifies migrations and never runs DDL. It is also used by `npm run sessions:sweep`. Non-loopback connections use application-enforced, certificate-verified TLS; URL query parameters and fragments are rejected. |
| `MIGRATION_DATABASE_URL` | `npm run db:migrate` with external PostgreSQL | One-off DDL-capable credential. It is deliberately not read as a fallback from `DATABASE_URL`; do not inject it into the production web process. The same verified-TLS URL policy applies. |
| `SESSION_SECRET` | `autodesk` | 32+ random bytes, base64. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Signs the opaque session cookie and derives the server-side token-encryption key; the cookie never holds APS tokens. |
| `APS_SESSION_STORE` | `autodesk` | Set to `database` to store encrypted APS token envelopes in PGlite/PostgreSQL. Any other value fails closed during callback. PGlite is limited to local, non-production authentication; production requires `DATABASE_URL`. |
| `ALLOW_DEMO_SEED_TO_DATABASE_URL` | Demo seed with `DATABASE_URL` | Must be exactly `true` to acknowledge writing synthetic fixtures to the configured, already-migrated development PostgreSQL database. The seed verifies migrations but runs no DDL, and still refuses Autodesk mode and production. |
| `AI_RECOMMENDATIONS_ENABLED` | optional | Default `false`. Deterministic rules always run and need no configuration. While this is `false`, no Autodesk customer data leaves the process. |
| `ANTHROPIC_API_KEY` | only if AI is on | Commented out by default. |

`.env.local` is gitignored. Keep it that way.

### The `b.` prefix rule — get this right once, centrally

This is the single most common integration bug in ACC.

| Context | Form of the id |
|---|---|
| Data Management (`GET /project/v1/hubs`, folders, items) | `b.<ACC_ACCOUNT_ID>` — **with** `b.` |
| `ACC_ACCOUNT_ID` env var | bare GUID — **no** `b.` |
| Data Connector `/data-connector/v1/accounts/{accountId}` | bare GUID |
| `/construction/admin/v1/accounts/:accountId/…` | bare GUID |
| Data Connector extract column `bim360_account_id` | bare GUID; validate it against the configured account ID |

Related, and equally load-bearing: **never synthesise a service container id from a project id.**
In Autodesk's own sample the Cost and Submittals container ids happen to equal the project GUID while
Issues/RFIs/markups/checklists share a *different* one. Read container ids from
`relationships.<service>.data.id` on the Data Management project. Locations `treeId` is the literal
string `"default"` (DOCUMENTED).

---

## 4. Creating the APS app

1. Go to https://aps.autodesk.com/myapps and create an app.
2. **App type must be "Traditional Web App"** — server-side, holds a client secret, runs the
   authorization-code (3-legged) flow. A SPA or desktop/mobile app type cannot hold the secret and
   cannot complete the flow this application uses. Every APS call in this codebase is made from a
   server component or route handler; nothing APS-related runs in the browser.
3. Set the callback URL to exactly the value of `APS_CALLBACK_URL`. APS does exact-string matching.
   `http://localhost:8080/api/aps/callback` and `http://localhost:8080/api/aps/callback/` are
   different URLs and the second will fail with a redirect-URI mismatch. Register one callback per
   environment (local, staging, production) rather than editing one entry back and forth.
4. Grant the app access to the APIs it needs on the app's API-access list — at minimum Data
   Management, ACC/Forma Account Admin, and Data Connector.
5. Copy the Client ID and Client Secret into `.env.local`.

> **Open item (not resolved by the source material):** the exact OAuth **scope strings** required for
> each module are not enumerated in the feasibility research. Determine them from the current
> reference page of each endpoint at provisioning time and record them in this file. Do not guess a
> scope list into code; an over-broad request will be rejected by security review and an under-broad
> one fails at runtime with a 403 that looks like the Custom Integrations failure in §5.

---

## 5. The step everyone misses: Custom Integrations

**An ACC/Forma Hub Admin must add your APS Client ID under `Hub Admin > Custom Integrations`.**

Until that is done, your application does not exist as far as the hub is concerned. This is manual,
it is done by a customer-side administrator, and:

- **There is no API to perform it and no API to check whether it has been done.** You cannot detect
  this state programmatically except by observing the failure below.
- **It is per hub.** Adding the client id to one hub grants nothing on another.
- **It is per region.** A hub provisioned in a second data region needs the integration added again
  for that region.
- Nothing else in this guide works before it. Do this first, and treat the admin's confirmation as a
  hard gate in your onboarding checklist.

### What the failure looks like — and why naive code misses it

`GET /project/v1/hubs` returns **HTTP 200** with an empty or short `data` array and a `meta` block
containing a `BIM360DM_ERROR` with a 401 or 403 inside it. Status-code-only error handling sees a
successful request and an empty hub list, and the UI reports "no hubs" instead of "not authorised".

**Parse the `meta` block on every `GET /project/v1/hubs` call** and surface a distinct
"integration not registered" state. The symptom to teach support: *the user signed in fine, and the
hub list is empty.*

For Secure Service Accounts (§6.3) the admin must additionally add the SSA's generated email address
as a hub/project member and grant it product subscriptions, roles and folder permissions. Registering
the client id alone is not sufficient for an SSA.

---

## 6. Why you must sign in — and the headless story

### 6.1 Three-legged is mandatory

- **Data Connector requires a 3-legged (user-context) token.** Autodesk's Data Connector sample
  material says "3 legged token only"; validate SSA support separately before production.
- **Construction IQ is only reachable through Data Connector.** There is no Construction IQ REST API
  on APS — it is absent from the ACC/Forma API reference navigation entirely. So the whole risk-value
  surface of this product inherits the 3-legged requirement.

Therefore the app runs an authorization-code flow, a human signs in, and the resulting user-context
token is what drives ingestion.

One deliberate exception to be aware of: the legacy `hq/*` endpoints
(`GET /hq/v1/accounts/:id/users`, `…/projects/:pid/companies`,
`…/business_units_structure`) are documented as **2-legged app-only**, with `limit` max 100 and
bare-array responses. If you use them, they need a *different* token from everything else. The
Data Connector `admin` service group covers the same ground in bulk and avoids the second token path.

### 6.2 The signing-in user's permissions decide what you see

**The signing-in user needs Hub Admin or Executive Overview to see the whole hub.** Without it they
silently receive only their own projects — no error, no warning, just a smaller portfolio. A
permission gap and "nothing happened" are indistinguishable at the API layer, in every module:

| Module | Silent under-reporting behaviour (DOCUMENTED) |
|---|---|
| Issues | Under company-scoped visibility, returns only the caller's company's issues. |
| Submittals | Hides draft items from non-managers; hides void items by default. |
| Forms | Returns only templates the user can access. |
| Model Coordination | Returns **zero model sets** for a user with Upload-only folder permission. Indistinguishable from "coordination not configured". |
| Reviews webhooks | Deliver only events the creating user could see. |
| Relationships | Read access is granted to any project member regardless of module permission — so you can see that an edge exists to a record you cannot open. |

Treat identity coverage as a correctness requirement. The app records project reachability on
`Project.accessible` and which domains actually returned data on `Project.availableDomains`, so the UI
can say "not visible to this identity" rather than implying zero risk.

### 6.3 Headless ingestion: Secure Service Accounts

Secure Service Accounts (SSA) are the intended headless option for a scheduled nightly ingestion: the app mints a `jwt-bearer` token for a machine identity instead of
depending on a human being logged in.

> **OPEN VALIDATION ITEM — UNCONFIRMED.** *Whether SSA auth actually works against Data Connector has
> not been confirmed.* Adversarial verification could not establish it: Autodesk's Data Connector
> sample READMEs say only "3 legged token only" and never mention SSA. Two further reference sets
> that predate SSA — Relationships v2 and Model Coordination v3 — likewise document only a
> three-legged flow.
>
> **How to validate, before you commit to the design:**
> 1. Create an SSA, have the hub admin provision its generated email into the hub and grant Executive
>    Overview.
> 2. Mint a `jwt-bearer` token.
> 3. `POST /data-connector/v1/accounts/:accountId/requests` with
>    `serviceGroups: ["admin"]`, `scheduleInterval: "ONE_TIME"`.
> 4. A 401 or 403 means SSA against Data Connector does not work.
> 5. Separately: `GET /bim360/relationship/v2/utility/relationships:writable` and
>    `GET /bim360/modelset/v3/containers/{id}/modelsets` with the same token.
>
> **Fallback if it fails:** a stored, rotated refresh token belonging to a *human service user* who
> holds Hub Admin or Executive Overview. This is a materially worse operational story — the token
> expires, the account can be disabled by the customer's IT, and the data visible to the pipeline is
> whatever that person can see. Plan for it, budget the secret-rotation work, and raise it during
> onboarding rather than at go-live.

---

## 7. Region configuration and the 200/404 probe

Hub Admin does **not** auto-route across data regions. Resolve the region for the hub **before any
other call** and cache the result.

**The probe (DOCUMENTED):** call `GET /construction/admin/v1/accounts/:accountId/projects` once per
candidate region value.

- **HTTP 200** → correct region. Cache it.
- **HTTP 404** → wrong region. Try the next.

Set `ACC_REGION` to the winner to skip the probe on subsequent boots.

Two traps:

1. **The header name differs by module.** `x-ads-region` on Issues, Model Coordination and
   Relationships; `Region` on Hub Admin; `region` on Cost; **not documented at all** on Submittals,
   Forms and RFIs. There is no single region header. The provider layer must know the per-module
   name; do not centralise it into one constant and assume.
2. **Several endpoints document only `US, EMEA`** even though the platform lists additional regions.
   `.env.example` offers `US | EMEA | AUS`. Which regions each module honours for the configured account
   is an **open item** to settle with the deployment-time probe.

Related open item, worth running at the same time: confirm the platform mix with
`GET /construction/admin/v1/accounts/:accountId/projects?filter[platform]=bim360`. Any hits mean a
second code path (see the BIM 360 row of §10).

---

## 8. Running the first ingestion

### 8.1 What the first run does, in order

The ordering is not arbitrary — later steps cannot be interpreted without earlier ones.

1. **Region probe** (§7), cached.
2. **`GET /project/v1/hubs`**, parsing the `meta` block (§5).
3. **Hub Admin project roster.** Filter out `classification` = template / component / sample,
   exclude other configured non-production project types, record the exclusion counts at runtime,
   and branch on `platform` (`acc` vs `bim360`).
4. **Dimensions before facts, per project:** issue types + subtypes, root-cause categories, issue
   custom-attribute definitions and mappings, Submittals metadata/responses/item-types/specs, RFI
   types and workflow, Forms templates → layouts → sections (this builds the `fieldId → label/modifier`
   dictionary), Locations nodes, companies, project users and roles.
5. **Facts.**
6. **Relationships sync last** among the REST work, so both endpoints of every edge are already
   resident. Expect dangling edges you cannot dereference; filter them out of customer-visible output.
7. **Model Coordination, in strict order:** model set → `versions/latest` manifest → tests filtered to
   `status=Success` → `resources` → **download immediately** (60-second signed URLs) → join
   `scope-version-clash` ← `scope-version-clash-instance` (`cid`) → `scope-version-document`
   (`ldid`/`rdid`). Persist on `clash.id`, `loid`, `roid` — **never** on `lvid`/`rvid`, which are
   explicitly not stable across seed-file versions.
8. **Snapshot/diff job last.** Writes one daily state row per entity for everything with no Autodesk
   history (`SnapshotRow` in the canonical types). This is what makes velocity, persistence and
   momentum possible at all.

### 8.2 Construction IQ joins — get these exactly right

| From | To |
|---|---|
| `iq_*` issue tables `.id` | **`issues_issues.issue_id`** |
| `iq_rfis_*.id` | `rfis_rfis.id` |
| `iq_company_*.company_id` | `admin_companies.id` |
| `bim360_project_id` | `admin_projects.id` |

Validate the extract header at ingestion. The expected issue key is `issue_id`; a missing expected
key is a schema-drift error. Joining on the wrong key can return an empty set without an error.

The `iq_*` tables are prediction side-tables. They carry no title, status, assignee, date or company.
They are useless without `admin`, `issues`, `rfis` and `relationships` in the same extract.

### 8.3 Expected duration

Wall-clock for the first run is dominated by the Data Connector job, not by your code.

| Phase | Expectation |
|---|---|
| Data Connector job submission → completion | Varies by extract size; poll, do not assume. Autodesk documents no fixed completion SLA. |
| Download of the master ZIP | Seconds. **Must begin within 60 seconds** of fetching the signed URL. |
| Parse + load into PGlite | Varies with service groups, extract size, and hardware; measure the first controlled run. |
| REST fan-out (per-project dimensions and facts) | Rate-limit bound, not CPU bound. See §8.5. |

Treat the whole first cycle as "start it and go and do something else", not as an interactive
operation. This is a **daily risk intelligence system, not a real-time feed** — a design consequence
of the job cap below and of Construction IQ being reachable only through batch extracts.

### 8.4 The 24-jobs-per-24-hours budget

**DOCUMENTED:** "Accounts have a limit of 24 jobs a day and individual Users have a limit of 24 jobs a
day." Validate current quota behavior during activation. Critical properties:

- It is a **rolling** 24-hour window, not a midnight-reset quota.
- **UI-initiated extracts consume it.** A customer admin clicking Export in the Data Connector UI can
  exhaust your budget without telling you.
- Exceeding it returns **429**.
- There is no way to raise it except a case-by-case support request to Autodesk.

Recommended allocation:

| Job | Contents | Notes |
|---|---|---|
| 1 — nightly full snapshot | `admin`, `iq`, `issues`, `rfis`, `submittalsacc`, `forms`, `checklists`, `cost`, `locations`, `relationships`, `schedule`, `reviews` | `iq` supports **no** date-range extraction — it is always a full extract. Hub-wide via executive overview, or `projectIdList` ≤ **50 project ids** per request. |
| 2 — nightly activities | `activities` with a **3-day overlapping window** | Absorbs the ~20-minute replication lag. Max **31 days** per request, **12-month** lookback (an API limit, not just a UI limit). Exceeding the max range does **not** error — it silently returns the default range, so assert the row date range you actually got. |
| 3–4 — optional intraday CDC | `cdcissues`, `cdcrfis`, `cdcsubmittalsacc`, `cdccost` | Beta. The response does not say whether a row was added, updated or deleted — you must diff across runs. Use overlapping windows and UPSERT. Do **not** send `projectStatus` on CDC calls. If you supply no date params you silently get a full extract. |
| reserve | **at least 8 of the 24** | Retries and re-runs. Do not plan to the cap. |

The implementation does not trust a caller-provided counter on its own. Before the non-idempotent
APS request is dispatched, a PostgreSQL transaction takes an advisory lock, combines current APS
usage with the rolling local reservation count, rejects any existing in-flight/ambiguous request,
and persists the new reservation. Accepted and ambiguous attempts remain budgeted for 24 hours;
only a recognized terminal job releases the in-flight exclusion, not the consumed slot.

`cdciq` is an **open item**: it has a published schema but is absent from the documented delta
`serviceGroups` enum on `POST requests`. Assume unavailable until a `POST` with
`serviceGroups: ["cdciq"]` actually returns a job.

Non-negotiable operational rules:

- **Download every job's output, even if you intend to discard it.** Scheduled extractions
  auto-pause if output is not downloaded within 14 days (daily/weekly) or 2 months (monthly), with no
  API-level error. An unattended pipeline that skips downloads simply stops receiving data.
- Fetch the signed URL and **start the transfer within 60 seconds**.
- Extracts are **purged after 30 days**. The application is the archive. Persist everything.
- Enumerate files with `GET jobs/:jobId/data-listing`; do not hard-code CSV filenames.
- Pin column expectations against the public schema service
  `https://developer.api.autodesk.com/data-connector/v1/doc/schema?name=<group>&format=json` and
  monitor `/doc/changes` for drift. The per-extract README inside the ZIP carries the same schema.
- **Never treat `status == "complete"` as success without also branching on `completionStatus`.** The
  exact token sets for both fields are an open item until one `ONE_TIME` job has been observed
  end-to-end.
- Extract downloads are capped at 128 MiB by default. The listing must declare a safe size; the
  signed receipt must repeat that filename and size; an HTTP `Content-Length`, when supplied, must
  agree; and the final streamed byte count must match exactly. Transfers use an abort deadline. Live
  ZIP/CSV ingestion stays disabled until decompression/row caps and runtime schema and region
  validation are accepted against the first extract.

### 8.5 The REST rate limits that actually bite

| Scope | Limit |
|---|---|
| RFIs — **all** RFI endpoints, **all** projects, per client id | **100 rpm.** The tightest read budget in the platform. Always use `limit: 200` on `POST search:rfis`. |
| Forms — all Forms endpoints combined, per client id | **100 rpm.** At 1–2 calls per form this caps a full item-level crawl at roughly 50–100 forms/minute for the entire application across every tenant. A hard multi-tenant ceiling. |
| Relationships | **120 rpm per APS user account.** Sharding across client ids does **not** help; shard across service users. |

The implemented limiter serializes wake-ups against a shared sliding window inside one Node process.
That closes burst races in the local/PGlite deployment. A horizontally scaled live deployment must
move those REST buckets to shared storage before enabling multiple ingestion replicas, because the
documented APS limits apply beyond one process.
| Issues | 500 rpm per user hub — shared with any other app acting for that user. |
| Data Connector | 60 rpm, scoped **both** per client id and per user account/hub. |
| `hq/*` (legacy) | 100 rpm combined. |
| Cost | Per-endpoint; 5000 rpm service-wide ceiling; lowest is **20 rpm** (expense detail, expense items). `GET change-orders` (the type list) is 30 rpm — call once and cache. |
| Submittals | 600 rpm per API key **and** 600 rpm per user account. 50-record pages. |
| Model Coordination | 600 rpm per APS user account, plus per-project job token pools (clash test 25/hr + 50/12hr). |

### 8.6 Triggering it

`package.json` currently defines exactly these scripts:

```
npm run dev        # next dev -p 8080
npm run build      # next build
npm start          # next start -p 8080
npm run typecheck  # tsc --noEmit
npm test           # node --conditions=react-server --import tsx --test 'tests/**/*.test.ts'
npm run db:migrate # node --import tsx scripts/migrate-database.ts
npm run sessions:sweep # node --import tsx scripts/sweep-expired-sessions.ts
npm run seed:demo  # node --import tsx scripts/seed-demo.ts
```

> **Open item:** there is no ingestion command, scheduler, or UI action in `package.json` yet, and
> the running app does not initiate the first live extraction after sign-in. Implement the bounded
> extract orchestrator, ZIP/CSV mapper, persistence transaction, and database query path; then add
> and document a headless command for the nightly schedule. Do not document or schedule a command
## 9. What "risk" means in the output, so you can sanity-check the first run

Use the first controlled extract to profile Construction IQ fields before enabling live views.
This public guide deliberately omits account-specific value distributions.

| Field | Table | Public handling rule |
|---|---|---|
| `risk`, `user_risk` | `iq_issues_quality_risks` | Preserve raw values; render the human override separately when present. |
| `cost_impact` | `iq_cost_impact_issues` | Normalize casing without changing the Autodesk category. |
| `risk`, `score` | `iq_rfis_high_risk` | The score's range and direction are undocumented; show it as a raw ordinal, never a percentage. |
| `safety_risk_category` | `iq_issues_safety_risk` | Normalize source-defined text and route unknown values to `unmapped`. |
| `safety_observation_category` | `iq_issues_safety_observations` | Profile literals per hub and gate ratios on a disclosed minimum N. |
| `safety_hazard_category` | `iq_issues_safety_hazard` | Treat the value set as undocumented and runtime-discovered. |
| `root_cause` | `iq_design_issues_root_cause` | Keep Autodesk labels separate from application-defined groupings. |
| `daily_risk`, `daily_risk_indicator` | `iq_project_daily_quality_risk_changes` | `daily_risk` uses the documented Low / Medium / High enum; the indicator scale is undocumented. |

IQ table and row availability varies by tenant. A missing or empty domain renders **Not Applicable**,
never low risk or zero. Autodesk documents no project-level safety-risk dataset, so any project
safety number this product shows is **DERIVED** and must be labelled accordingly.

**Application-derived, always labelled as such:** every velocity, ageing/persistence, concentration,
recurrence, exposure and conversion metric; **overdue and days-overdue for every module**; any
project-level safety value; any portfolio or cross-project rollup; clash counts, backlog, ageing and
discipline attribution; checklist non-conformance; trade attribution of an individual record; any
propagation or causal claim; normalised LBS tiers; submittal response grouping; safety-observation
ratios; time-in-status outside validated transition data; and any monetary figure attached to an
issue or RFI.

Mandatory Construction IQ disclosures remain in `docs/risk-definition-catalog.md`. In particular,
Construction IQ detection is not exhaustive, a project risk level is not a management judgement,
and cost impact is a separate model from quality risk.

---

---

## 10. Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| **Hub list is empty**, sign-in succeeded | The APS Client ID may not be registered under `Hub Admin > Custom Integrations` for the configured account and region. The response can carry a `BIM360DM_ERROR` inside an HTTP 200 `meta` block. | Parse `meta` and show the real error. Ask an account admin to verify the client id (§5), then confirm the region (§7). There is no API to check integration status. |
| **Empty hub list, integration confirmed added** | Wrong region, or the signed-in user has neither Hub Admin nor Executive Overview and genuinely belongs to no projects. | Run the 200/404 region probe. Then check the user's hub role. |
| **Portfolio is much smaller than expected** | The signing-in user lacks Hub Admin / Executive Overview and silently sees only their own projects. No error is raised. | Sign in as a Hub Admin or Executive Overview user. Audit coverage explicitly — `Project.accessible` and `Project.availableDomains` exist for this. |
| **403 on Data Connector** | (a) a 2-legged client-credentials token was used — Data Connector requires **3-legged**; (b) Custom Integrations not registered; (c) for an SSA, the account email was never provisioned into the hub; (d) the SSA path itself may simply not be supported (§6.3, open item). | Confirm the token is user-context. Confirm §5. If using SSA, fall back to a stored refresh token for a human service user. |
| **Job stuck "processing"** | Normal for a large hub; also the state a naive client gets stuck in when it only reads `status`. | Poll `GET jobs/:jobId`. **Branch on `completionStatus` as well as `status`** — `complete` alone does not mean success. Do not treat the job-completion `callbackUrl` as authoritative: it is unsigned with no documented retry. Treat it as a hint and keep polling. |
| **429 from Data Connector** | The rolling 24-jobs-per-24h cap (per account **and** per user). Remember that customer-initiated UI exports consume it. | Back off; do not retry-storm. Reduce to one nightly job plus one activities job. Reserve at least 8 jobs for retries. Raising the cap requires a support request. |
| **429 with `Retry-After` on a REST module** | Per-module rate limit — most likely RFIs or Forms at 100 rpm per client id across all projects. | Honour `Retry-After` exactly. Use `limit: 200` on RFI search. For Relationships, shard across service **users**, not client ids. |
| **Extract download 404s / data has vanished** | Extracts are purged after **30 days**. | Persist locally on every run. The app is the archive, not Autodesk. |
| **Signed URL fails / 403 on download** | Signed download URLs live **60 seconds**. | Fetch the URL and begin the transfer immediately in the same code path. Never fetch URLs in a batch and download later. |
| **Scheduled extract silently stopped producing data** | Scheduled extractions **auto-pause** if output is not downloaded within 14 days (daily/weekly) or 2 months (monthly). No API-level error. | Download every run even if you discard the bytes. Alert on "no new job in N days". |
| **Activities query returns far fewer days than requested** | The 31-day max range does **not** error when exceeded — it silently returns the default range. Lookback is capped at 12 months at the API level. | Assert the returned row date range against what you asked for. For a deeper baseline you need Autodesk's manual "Request Full Historical Activity Data" process — human latency, raise it at onboarding. |
| **Project shows "Construction IQ Not Applicable"** | Correct behaviour, not a bug. CIQ produces **no data at all** for non-English project data, or for project types outside Commercial / Healthcare / Institutional / Residential and Infrastructure→Transportation Building. | Verify with a Hub Admin `filter[type]` census plus a row count on `iq_project_daily_quality_risk_changes` per project. **Absence must render "Not Applicable", never "low risk".** |
| **Risk trend line is flat then jumps** | CIQ daily tables may be sparse change logs rather than one row per day. | Forward-fill as a bounded step function from the last known value, disclose coverage, and say so in the chart caption. |
| **Clash count is falling and coordination "looks better"** | `isDocumentLimitReached: true` freezes clash data at the 1,000-document cap **with no error**. Also, a user with Upload-only folder permission gets **zero model sets** with no error. | Read `isDocumentLimitReached` and the model set `permission` field (None/Read/Edit) and surface both. Never report a falling clash count without them. |
| **BIM 360 project behaves differently or errors** | Issues v1, RFIs v3, Forms, Submittals v2 and Locations writes are **not compatible with BIM 360 projects**. The retired BIM 360 Checklists API is explicitly not compatible with ACC projects either. | Branch on `platform` (`acc` vs `bim360`) from the Hub Admin roster on ingest. Probe the mix with `filter[platform]=bim360`. In the extract, `admin_projects.acc_project` and the parallel `issuesbim360_*` tables mark the split (OBSERVED). |
| **Issue status values don't match between sources** | Data Connector and REST expose different documented status sets. | Normalize centrally before union, retain the raw value, and route unknown values to `unmapped`. |
| **Construction IQ joins return nothing** | Joined on `issues_issues.id`, which does not exist. The column is `issue_id`. | Fix the join (§8.2). It fails silently as an empty set. |
| **Portfolio totals look absurd** | Template, Training, Demonstration, component, or sample projects were not filtered. | Apply the configured non-production filter and disclose excluded-project counts at runtime. |
| **Checklist / form "pass-fail" logic matches nothing** | ACC Forms has **no conformance concept**. `GET forms/{formId}/values` normalizes toggle answers to True / False / NA regardless of the configured wording, and unanswered questions are omitted. | Build a per-template question dictionary from templates → layouts → sections, key on `fieldId`, and define the app's own rule. Label it "application-defined non-conformance" and validate extract-table availability per hub. |
| **A relationship edge points at a record the app cannot open** | Relationship read access is granted to any project member regardless of module permission. | Filter undereferenceable edges out of customer-visible output. Never render a link to a record the token cannot fetch. |
| **Funnel view looks statistically meaningless** | The configured relationship population may be too sparse for a stable funnel. | Show the current deduplicated edge count. Relationships are undirected, untyped, unattributed and strictly binary — present as co-occurrence with a `created_on` timeline, never as causality. |

---

## 11. Tests

```bash
npm test        # node --import tsx --test 'tests/**/*.test.ts'
npm run typecheck
```

`npm test` uses the Node built-in test runner (`node --test`) with the `tsx` TypeScript loader.
No Jest, no Vitest, no separate config file. Tests live in `tests/` and are
named `*.test.ts`.

Run both before every commit. `npm run typecheck` is not optional here: the canonical model in
`src/lib/canonical/types.ts` uses the type system to enforce the product's central honesty
constraint — every user-visible number is a `Measured<T>` carrying `MetricProvenance`, and provenance
carries `valueKind` (`autodesk-provided` | `application-derived` | `ai-generated`). If a derived value
can reach the screen without provenance, that is a type error, and `tsc` is what catches it.

The test suite requires no Autodesk credentials and no database server — it runs against PGlite in a
temporary directory, the same engine as `npm run dev`.

---

## 12. Open items carried forward

These are unresolved validation items. Do not close any of them by assumption; each needs a
controlled call against the configured account.

| # | Open item | How it gets settled |
|---|---|---|
| 1 | Does Secure Service Account auth work against **Data Connector**? The entire headless design depends on it. | §6.3 procedure. |
| 2 | Does SSA work against **Relationships v2** and **Model Coordination v3**? Both reference sets predate SSA. | `GET …/relationships:writable` and `GET …/modelsets` with an SSA token. |
| 3 | Is **`cdciq`** accepted as a `serviceGroup`? Published schema, absent from the documented delta enum. | `POST requests` with `serviceGroups: ["cdciq"]` and a date window. |
| 4 | Exact Data Connector **job state machine**: literal `status` / `completionStatus` tokens, whether a failed job's `data-listing` 404s, pagination envelope on `GET requests` / `GET jobs`, the master-ZIP filename, the `projectStatus` token (`all` vs `both`), whether a 200-active-request quota exists. | One `ONE_TIME` job, observed end to end. |
| 5 | Which **regions** each module honours for the configured account, and which region header each accepts. | The 200/404 probe (§7) per module. |
| 6 | Is the configured account **ACC-only**, or is there a BIM 360 population needing a second code path? | `filter[platform]=bim360`. |
| 7 | Is the Forms question **`schema` UID stable across template edits**? If not, checklist recurrence fragments across layout versions. | Sandbox template: record `schema` values, edit the template, re-read, compare. |
| 8 | Legal **`modifier`** values on a Forms section item, and whether `GET forms?include=nativeValues` returns answers inline. The second decides whether item-level extraction is viable against the 100 rpm Forms budget. | `GET sections` on a template with a known Pass/Fail question; then `GET forms?include=nativeValues`. |
| 9 | Which **relationship pairs are writable**, and which are actually populated. A clean writable matrix does not imply populated data. | `GET /bim360/relationship/v2/utility/relationships:writable`, plus a reviewed sample of issues the UI shows with References. |
| 10 | Do any projects define a **numeric cost custom attribute** on issues? This is the only route to a monetary figure on an issue, and it is per-project with no reserved name. | `GET issue-attribute-definitions` across the portfolio, grouped by `title` and `dataType`. If coverage is thin, drop the feature rather than showing it for a handful of projects. |
| 11 | **Activities backfill depth** — is the 12-month lookback enforced hard? | Request a window 11 months back and confirm rows return. Anything deeper needs Autodesk's manual historical-data process. |
| 12 | **Model Coordination visibility** for the ingestion identity, and `isDocumentLimitReached` across model sets. | `GET modelsets/:id`, read `permission` and the document-limit flag. |
| 13 | Exact **OAuth scope strings** per module (§4). | Current reference page of each endpoint at provisioning time. |
| 14 | The **APS callback URL for non-local environments**, and the corresponding registered entries. | Decide at deployment; register one per environment. |
