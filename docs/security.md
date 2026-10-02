# Forma Risk Radar — Security Architecture

> **Demo-only edition:** No customer data, Autodesk credentials, or session is needed. The
> dashboard uses synthetic records unconditionally, and Autodesk OAuth handlers are not
> registered as HTTP routes. The original backend security design below is retained as reference;
> setting `DATA_MODE=autodesk` does not activate it in this repository.

Audience: senior engineers implementing or reviewing this system. This document is normative.
Where it says MUST, a pull request that violates it is a defect regardless of test status.

## 0. Naming, and what this system talks to

Autodesk Construction Cloud was renamed **Forma** effective **2026-03-24**. The API documentation
set is now titled **"Forma APIs"** and is published at `/en/docs/acc/v1/`, while the runtime base
paths are unchanged: `/construction/...`, `/cost/v1/...`, `/bim360/...`, `/data-connector/v1/...`.

This is **not** Forma Site Design (formerly Spacemaker), documented at `/en/docs/forma/v1/`. That
product has no Issues, RFIs, Submittals, Forms, Construction IQ or Data Connector and is entirely
out of scope. Configured ACC account identifiers use bare GUIDs; Forma Site Design uses `pro_...`
identifiers.

Throughout this document, factual claims use these provenance labels:

| Label | Meaning |
|---|---|
| **[DOC]** | Documented behaviour of the Autodesk platform, per current official documentation. |
| **[OURS]** | A Forma Risk Radar design decision, derivation or control. Autodesk asserts nothing about it. |

The same discipline is enforced in code by `MetricProvenance.valueKind`
(`autodesk-provided` | `application-derived` | `ai-generated`) in
`src/lib/canonical/types.ts`. Security review treats a provenance mislabel as a
customer-facing integrity defect, not a cosmetic one.

---

## 1. Trust boundaries

```
Browser (React 19, client components)
   |  session cookie only. No APS token. No client secret. No Autodesk host is
   |  ever contacted from browser code.
   v
Next.js 16 App Router — server components + route handlers  [trust boundary]
   |  holds APS_CLIENT_SECRET, SESSION_SECRET, and the user's APS tokens
   |
   +--> PostgreSQL (PGlite in-process by default, or DATABASE_URL server)
   |       local copy of Autodesk customer data — see §9 residency, §12.4 retention
   |
   +--> Autodesk Platform Services (APS)
   |       /authentication/..., /construction/..., /cost/v1/...,
   |       /bim360/..., /data-connector/v1/...
   |
   +--> (OFF by default) third-party LLM provider — see §10
```

Rules derived from this diagram:

1. **All APS calls originate from server components or route handlers.** [OURS] There is no
   client-side APS SDK, no token in `localStorage`, no token in a non-httpOnly cookie, no token in
   a React Server Component payload, and no APS host in the browser's connect-src.
2. **No environment variable that carries a secret may be prefixed `NEXT_PUBLIC_`.** [OURS] A CI
   check greps the repository for `NEXT_PUBLIC_.*(SECRET|TOKEN|KEY|PASSWORD)` and fails the build
   on a match. `APS_CLIENT_SECRET`, `SESSION_SECRET`, `DATABASE_URL` and `ANTHROPIC_API_KEY` are
   server-only by construction.
3. **The database is inside the trust boundary and contains customer data.** PGlite is real
   PostgreSQL compiled to WASM running in-process; its data directory (`PGLITE_DIR`, default
   `.data/pg`) is a plaintext on-disk copy of extracted ACC data and MUST be gitignored and
   excluded from container images, backups shared outside the deployment, and support bundles.

---

## 2. Secret handling

### 2.1 Inventory

| Secret | Env var | Scope | Never appears in |
|---|---|---|---|
| APS client secret | `APS_CLIENT_SECRET` | Server process only | Browser bundle, logs, error responses, database, telemetry |
| Session signing key | `SESSION_SECRET` | Server process only | Browser bundle, logs, cookies (it signs them; it is not in them) |
| APS access token | (runtime, not env) | Server memory + server-side session store | Browser, logs, database columns other than the encrypted session record, URLs |
| APS refresh token | (runtime, not env) | Server-side session store | Browser, logs, URLs |
| Runtime database URL (may embed a password) | `DATABASE_URL` | Server process only; DML role without DDL | Logs — redacted to `postgres://<redacted>@host:port/db` |
| Migration database URL (may embed a password) | `MIGRATION_DATABASE_URL` | One-off migration job only; never the web runtime | Browser, application logs, long-running runtime environment |
| LLM provider key | `ANTHROPIC_API_KEY` | Server process only; unused while `AI_RECOMMENDATIONS_ENABLED=false` | Everything |
| Data Connector signed download URL | (runtime, ephemeral) | Server memory for < 60 s | Logs, database, UI — see §2.4 |

`.env.local` is gitignored. `.env.example` contains **placeholders only** and is the sole committed
env file; it already documents `DATA_MODE`, `APS_CLIENT_ID`, `APS_CLIENT_SECRET`,
`APS_CALLBACK_URL`, `ACC_ACCOUNT_ID`, `ACC_REGION`, `PGLITE_DIR`, `DATABASE_URL`,
`MIGRATION_DATABASE_URL`, `SESSION_SECRET` and `AI_RECOMMENDATIONS_ENABLED` with empty or non-secret
values.

The APS application MUST be registered as a confidential ("Traditional Web App") client so the
secret is never required in a public client. `APS_CALLBACK_URL` MUST match the registered callback
exactly; a mismatch is an authorization failure, not a fallback.

### 2.2 The logging rule

**No token, secret, signed URL, cookie value or `Authorization` header is ever written to any log,
at any level, in any environment, including local development.** [OURS] This is absolute. There is
no `if (process.env.NODE_ENV === 'development')` exemption, because the most common leak path is a
developer pasting a local log into an issue tracker.

### 2.3 Log redaction approach

All logging goes through a single module. Direct `console.*` calls outside that module are banned
by lint rule; the CI lint job fails on violation.

The logger is **allowlist-first, deny-list-second**:

1. **Structured only.** Callers pass `(event: string, fields: Record<string, Loggable>)`. `Loggable`
   is a narrow union — string, number, boolean, null, ISO date string, and the branded id types.
   Arbitrary objects are not `Loggable`, so an Autodesk API response cannot be passed to the logger
   without an explicit, reviewable projection. `RiskRecord.raw` is typed
   `Readonly<Record<string, unknown>>` and is therefore not `Loggable` — it can never be logged
   without a cast, and casts to `Loggable` are lint-banned.
2. **Key deny-list**, applied recursively to whatever does get through, case-insensitive, on
   substring match: `authorization`, `cookie`, `set-cookie`, `access_token`, `refresh_token`,
   `id_token`, `client_secret`, `code`, `code_verifier`, `code_challenge`, `state`, `password`,
   `api_key`, `apikey`, `signature`, `x-amz-`, `secret`. Matched values are replaced with
   `"[redacted]"` — not truncated, not hashed, not prefix-preserved.
3. **URL scrubbing.** Any value that parses as a URL is reduced to `origin + pathname`; the query
   string and fragment are dropped wholesale. This is what keeps a Data Connector signed download
   URL out of the logs, and it is why URL scrubbing is unconditional rather than host-specific.
4. **Bearer-shape scrubbing.** A regex pass replaces `Bearer [A-Za-z0-9._-]{20,}` and long
   JWT-shaped substrings (`eyJ...`) anywhere in a message body, catching tokens embedded in
   third-party error strings the logger did not construct.
5. **Error objects are projected, never spread.** Only `name`, `message` (after passes 2–4),
   HTTP status, APS request id where present, and a stack trace with absolute paths made relative.
   An `Error` carrying a `config` or `request` property from an HTTP client is not logged; the
   projection drops unknown properties rather than serialising them.
6. **Volume discipline in `DATA_MODE=autodesk`.** Record bodies are never logged. Log record
   *counts*, table names, project ids and durations. Record ids may be logged (they are opaque
   GUIDs and are needed for support); titles, descriptions, comments, user names, emails and
   locations are customer content and MUST NOT be logged. Identity and profile datasets can carry
   fields such as `email`, `phone`, `address_line1`, `job_title` and `last_sign_in`; treat them as
   PII subject to §9.4.

The implemented APS error boundary is unit-tested to ensure response bodies, request URLs, bearer
tokens, and signed-URL query strings never escape through thrown errors. A future structured logger
must add equivalent fixture coverage for database URLs and arbitrary metadata before live activation.
Successful OAuth JSON bodies are streamed with a 64 KiB ceiling; other APS JSON reads use an 8 MiB
ceiling. Both reject oversized `Content-Length` values before allocation and cap chunked bodies as
they arrive while the request deadline remains active.

### 2.4 Data Connector signed URLs

[DOC] Signed download URLs from Data Connector live **60 seconds**. Consequences that are
security-relevant, not just operational:

- A signed URL is a **bearer credential**. It MUST NOT be persisted to the database, written to a
  log, included in an error message returned to the browser, or forwarded to the client for a
  "download here" link. The server fetches the bytes; the client never sees the URL.
- The download client accepts only HTTPS URLs on exact operator-approved DNS hosts configured in
  `APS_DATA_CONNECTOR_DOWNLOAD_HOSTS`. Fetch redirects are manual; every hop is re-parsed and
  rechecked against the same allowlist before the credential is sent onward. There is deliberately
  no guessed Autodesk bucket hostname before the first live response is validated.
- The 60-second lifetime means retry logic MUST re-request the URL via
  `GET /data-connector/v1/accounts/:accountId/jobs/:jobId/data/:name` rather than retrying a
  cached URL. A cached URL in a retry queue is both broken and a leak.
- [OURS] The server requires a safe non-negative size in the listing, then requires the signed
  receipt's filename and size to match that listing. If the response supplies `Content-Length`, it
  must match too; the final streamed byte count must always equal the declared size. The stream has
  an abort deadline and a 128 MiB cap. Archive decompression and CSV loading remain activation-gated
  until separate decompressed-byte and row-count limits plus runtime schema/region validation are
  installed.

---

## 3. Authentication and session security

### 3.1 Flow

Forma Risk Radar's Data Connector integration uses a three-legged OAuth authorization-code flow
with PKCE. [OURS] The product therefore authenticates a **human Autodesk identity** and acts as
that user.

Token and APS JSON request deadlines remain active through response-body consumption. A peer that
sends headers and then stalls therefore cannot hold an OAuth exchange or provider read indefinitely.

```
/api/aps/login
  generate code_verifier (32 random bytes, base64url)
  code_challenge = S256(code_verifier)
  state          = 32 random bytes, base64url
  store {state, code_verifier, returnTo} in a short-lived, httpOnly,
        SameSite=Lax, Secure, signed cookie (TTL 10 minutes)
  302 -> APS authorize endpoint with response_type=code, PKCE params, state

/api/aps/callback
  reject if state cookie absent, expired, or != state query param  -> 400, no detail
  reject if `error` param present                                   -> render generic failure
  exchange code + code_verifier for tokens (server-to-server, client secret in the request)
  delete the transient state cookie
  establish session (§3.2)
  302 -> returnTo, validated as a same-origin relative path (leading "/" and no "//")
```

- **`state` is the CSRF control on the authorization-code flow.** It is compared with a constant-time
  comparison and is single-use: the transient cookie is deleted on first callback regardless of
  outcome.
- **PKCE (S256) is mandatory** even though this is a confidential client. It removes authorization-code
  interception as a class and costs nothing.
- `returnTo` is validated as a relative path. An absolute URL, protocol-relative URL, or path
  containing `\` is rejected and replaced with `/`. This is the open-redirect control.

### 3.2 Session cookie

| Property | Value | Rationale |
|---|---|---|
| `httpOnly` | true | XSS cannot read the session |
| `Secure` | true | Set unconditionally in any non-localhost deployment; HTTPS-only |
| `SameSite` | `Lax` | Survives the OAuth top-level redirect back from Autodesk; blocks cross-site POST |
| `Path` | `/` | |
| Signature | HMAC-SHA256 with `SESSION_SECRET`, verified in constant time | Tamper detection |
| Contents | Opaque session id only | No tokens, no user attributes, no hub id in the cookie |
| `Max-Age` / `Expires` | Session creation + 7 days | The browser cookie cannot outlive the server's absolute session limit and is not renewed by activity |

The cookie carries an **opaque session identifier**. APS access and refresh tokens live in the
server-side session store, keyed by that identifier. This means a stolen cookie is revocable and a
database dump is the only place tokens exist at rest — where they are encrypted with a key derived
from `SESSION_SECRET`.

The application session has a **24-hour idle limit** and a **7-day absolute limit**. These are
explicit application policy, not claims about Autodesk token lifetimes. `last_seen_at` tracks idle
activity independently; `updated_at` remains the sole optimistic version for token rotation. A
normal authenticated read touches only `last_seen_at` and never sweeps unrelated sessions.

`SESSION_SECRET` MUST be at least 32 random bytes. Live authentication and Autodesk provider
construction refuse to proceed if it is unset, shorter than 32 bytes, or recognisably a placeholder.
The activation-gate page and liveness endpoint may still run so the operator can diagnose the
configuration. Defaulting to a generated ephemeral key is not allowed, because it silently
invalidates sessions on every deploy and hides misconfiguration.

### 3.3 Token lifetimes, refresh and rotation

| Item | Value | Status |
|---|---|---|
| Access token lifetime | 60 minutes | **[OURS] assumed** — see the open item below |
| Refresh token lifetime | 15 days | **[OURS] assumed** — see the open item below |
| Refresh trigger | 5 minutes before expiry, or on a 401 from APS | [OURS] |
| Rotation | Every refresh replaces **both** the access token and the refresh token in the session record, in a single transaction | [OURS] |
| Reuse detection | A refresh token presented after it has been rotated invalidates the entire session chain | [OURS] |
| Application idle lifetime | 24 hours from `last_seen_at` | **[OURS] policy** |
| Application absolute lifetime | 7 days from `created_at`; never renewed | **[OURS] policy** |

> **OPEN ITEM (carry forward, do not resolve by assumption).** The current assessment does not
> establish APS token lifetimes. The implementation MUST NOT hard-code 60
> minutes or 15 days as truth. It MUST read `expires_in` from the token response and schedule from
> that, treating the values above only as sanity bounds for alerting (e.g. "APS returned an
> `expires_in` an order of magnitude outside expectation"). Confirm both lifetimes against the APS
> authentication reference before go-live.

Refresh is **serialised per session** behind a mutex. Concurrent server components refreshing the
same session simultaneously is the standard way to burn a rotating refresh token and log the user
out mid-page. Token replacement compares only the token-generation `updated_at`; an independent
idle touch cannot make a successful APS refresh lose its compare-and-swap. The replacement advances
`last_seen_at` monotonically.

### 3.4 Scopes

The application requests only the explicit, operator-reviewed minimum scopes needed by the enabled
providers. OAuth scope names required for Data Connector request creation may be write-named even
though V1 never mutates Autodesk project records; capability is therefore constrained again by the
named transport and provider methods in §8.

> **OPEN ITEM.** The current assessment does not enumerate the exact APS scope strings, and this
> document will not guess them — a wrong scope string is a startup failure,
> not a documentation nicety. Pin the scope list in one constant, sourced from the APS
> authentication reference, and assert at login that the granted scope set returned by APS equals
> the requested set. A silently narrowed grant is the same failure mode as §6: it produces
> under-reporting, not an error.

### 3.5 Sign-out and invalidation

Sign-out MUST: delete the server-side session record (tokens included), clear the session cookie
with an immediate expiry and identical attributes, and clear any transient OAuth cookie. Sessions
are also invalidated on: terminal refresh rejection, refresh-token reuse detection,
`SESSION_SECRET` rotation, a change to `ACC_ACCOUNT_ID`, and either application lifetime expiring.
Transient network, timeout, 429, and 5xx refresh failures preserve
the revocable encrypted session for a later retry; terminal OAuth rejections invalidate it. Cached
Autodesk data in PostgreSQL is **not** deleted at sign-out
— it is the product's archive (§12.4) — which is precisely why every read of it re-applies the
authorization checks in §4 rather than trusting that it was fetched for someone.

The production scheduler runs `npm run sessions:sweep` against the DML-only `DATABASE_URL`. One run
drains 100-row batches up to a hard ceiling of 10,000 sessions, deletes and appends the fixed
`authentication.session-expired` audit records in the same transaction, and exits non-zero if a
backlog remains. Schedule another run after any capped result. Autodesk authentication in
`NODE_ENV=production` requires shared PostgreSQL; embedded PGlite is local, single-process storage
and is rejected for production authentication, so the sweep never opens a live PGlite directory
from a competing process.

### 3.6 Application-level CSRF

Beyond the OAuth `state` parameter: all state-changing route handlers (all of which are
app-internal — see §8, nothing writes to Autodesk) require `SameSite=Lax` plus an `Origin` header
check against the deployment origin. Requests with a missing or mismatched `Origin` on a
non-idempotent method are rejected with 403. The OAuth callback is the necessary GET exception: it
validates a signed, short-lived, single-use state transaction before creating a session.

### 3.7 Demo mode

`DATA_MODE=demo` is the default. It runs with **no Autodesk credentials**, performs no OAuth, opens
no outbound connection to Autodesk, and generates synthetic data (`SourceSystem = "demo-generator"`).
Every surface is labelled synthetic. Security relevance: demo mode is the safe default, so a
misconfigured deployment fails toward "no customer data" rather than toward "partial customer data
with no auth". The mode is displayed persistently in the UI chrome; live authentication/provider
operations MUST NOT run without `APS_CLIENT_ID`, `APS_CLIENT_SECRET`, `ACC_ACCOUNT_ID`,
`APS_SCOPES`, and `SESSION_SECRET` all present and non-placeholder.

---

## 4. Authorization model

### 4.1 Principle

**The product shows the authenticated Autodesk user exactly what their Autodesk identity can see,
and never more.** Forma Risk Radar does not maintain its own permission model, does not grant
access, and does not have an "admin sees everything" mode. Autodesk is the authority; this product
is a lens.

The UI MUST NEVER imply that a user can see a project, record, company or metric their Autodesk
identity cannot access. Concretely: a project the identity cannot reach is not rendered greyed out
with a real count next to it, is not included in a hub-level denominator, and does not contribute
to a portfolio index. It is either absent or shown as explicitly out-of-coverage (§6).

### 4.2 Preconditions that are authorization, not setup

1. **[DOC] Hub Admin must add the APS Client ID under Hub Admin → Custom Integrations.** This is
   manual, per hub, per region, has no API, and cannot be checked programmatically. Nothing works
   before it. Treat a total-blackout read as "integration not approved" and say so, rather than
   rendering an empty, healthy-looking dashboard.
2. **[DOC] `GET /project/v1/hubs` returns `BIM360DM_ERROR` 401/403 inside an otherwise HTTP-200
   response.** The `meta` block MUST be parsed on every call. Naive status-code handling sees an
   empty hub list and renders "no hubs" — an authorization failure disguised as an empty account.
   This is a fail-closed violation and is explicitly tested.
3. **[DOC] Region must be resolved per hub before any module call.** Hub Admin does not auto-route:
   probe with each region value — 200 = correct, 404 = wrong — and cache the result. Header names
   differ by module (`x-ads-region` on Issues / Model Coordination / Relationships, `Region` on Hub
   Admin, `region` on Cost; no region header is documented on Submittals, Forms or RFIs). A 404 from
   a wrong-region call is indistinguishable from "resource does not exist" and MUST NOT be rendered
   as absence of data.

### 4.3 Hub membership verification

On every session establishment and on a periodic revalidation interval:

1. Enumerate hubs reachable by the token (parsing the `meta` block per §4.2.2).
2. Assert that the bare-GUID `ACC_ACCOUNT_ID` appears in that set. Add Data Management's `b.`
   prefix only at its call site; do not store the prefixed form.
3. If it does not appear, or the enumeration errored, or the `meta` block signalled an error:
   **the session has zero project access.** Not "all projects"; zero.
4. Enumerate the project roster via Hub Admin, filtering documented non-production classifications
   such as template / component / sample [DOC]. Additional organization-specific exclusions belong
   in deployment configuration, not source code. Portfolio views MUST exclude non-production
   projects so they do not distort risk metrics.
5. Record per-project reachability into `Project.accessible` in the canonical model, and the set of
   domains with data into `Project.availableDomains`.

Every read path — API route, server component, and every SQL query against the local archive —
filters on the session's accessible project set. The filter is applied in one place (a query builder
wrapper that requires an explicit accessible-project-id list argument), not repeated per query. A
query function that does not take that argument does not exist.

### 4.4 The fail-closed rule

**If access cannot be positively established, access is denied.** [OURS]

| Condition | Correct behaviour | Wrong behaviour to guard against |
|---|---|---|
| Hub membership check errors | Zero projects; explicit error state | Fall back to the last cached accessible set |
| Project roster call times out | Zero projects; explicit error state | Render the archive unfiltered |
| A region probe is inconclusive | Treat the module as unreachable for this session | Assume `US` and proceed |
| `meta` block signals `BIM360DM_ERROR` | Authorization error state | Empty hub list |
| Session token refresh fails | Sign out | Serve stale data from the archive |
| A project id appears in the archive but not in the current roster | Exclude it | Include it because "we already have the data" |

The archive is a cache of Autodesk data, not a grant. Data ingested yesterday under a service
identity with broad access MUST NOT become visible today to a narrower identity. Every archive read
is re-authorized against the current session's project set.

### 4.5 What we deliberately do not do

Extracts may include Autodesk module ACL datasets such as cost, asset or document permissions.
**We do not reimplement Autodesk's access control from them.** Reconstructing an ACL from an extract
is a reliable way to build a permissive bug: the records may be partial, module-specific, and
describe policy at extraction time. Authorization is determined by what the live, per-user API
returns — not by our interpretation of a permissions table. These datasets may be *displayed* as
project configuration data to a user who already has access; they are never an input to an access
decision.

---

## 5. Service identity, and the SSA open item

The design assumes ingestion runs under an identity with the breadth to see the hub. Two facts
constrain this:

- **[OURS] The supported Data Connector integration uses a three-legged token.**
- **OPEN: Whether a Secure Service Account (SSA) works against Data Connector is unconfirmed.**
  Autodesk's own Data Connector sample READMEs state "3 legged token only" via Authorization Code
  and never mention SSA. Adversarial verification could not confirm SSA support.

> **OPEN ITEM 1 (highest architectural risk).** Validate SSA against Data Connector: create an SSA,
> provision its email into the hub, grant executive overview, mint a `jwt-bearer` token, and
> `POST /data-connector/v1/accounts/:accountId/requests` with `serviceGroups:["admin"]`,
> `scheduleInterval:"ONE_TIME"`. A 401/403 means the product must instead hold a **stored refresh
> token for a human service user** — materially worse security and operations: a long-lived
> credential tied to a person, which must be encrypted at rest, rotated on that person's departure,
> and re-consented when the refresh token expires.
>
> **OPEN ITEM 2.** Validate SSA against Relationships v2 (`GET /bim360/relationship/v2/utility/relationships:writable`)
> and Model Coordination v3 (`GET /bim360/modelset/v3/containers/{id}/modelsets`). Both reference
> sets predate SSA and document only a three-legged flow.

Whichever identity ingests, §4 still governs display: **ingestion breadth is not display breadth.**
The ingesting identity may legitimately see more than a given end user; the archive read filter is
what keeps that from leaking. This separation is the single most important authorization property in
the system, because it is the one that a "just show the cached data" optimisation would quietly
destroy.

If a stored-refresh-token service user is required, it MUST be a dedicated account, never a real
person's day-to-day account, and the hub admin must be told in writing what it can see.

---

## 6. Permission coverage as a correctness problem

This is the most consequential security-adjacent finding in the feasibility work, and it is not a
conventional vulnerability. It is an integrity failure.

**[DOC] Every ACC/Forma module silently under-reports rather than erroring when the calling identity
lacks permission.** A permission gap is therefore indistinguishable from "nothing happened".

| Module | Documented silent under-report |
|---|---|
| Issues | Under company-scoped visibility, returns **only the caller's company's issues**. No error, no flag. |
| Submittals | Hides **draft** items from non-managers; hides **void** items by default. |
| Forms | Returns **only templates the user can access**. |
| Model Coordination | Returns **zero model sets** for an identity with Upload-only folder permission — identical to "coordination not configured". |
| Reviews webhooks | Deliver **only events the creating user could see**; a hook created by a narrow user is a narrow feed forever. |
| Construction IQ | Produces **no rows at all** for non-English project data or for project types outside Commercial / Healthcare / Institutional / Residential / Infrastructure→Transportation Building. |

A risk dashboard that renders an under-reported number as fact is worse than one that renders
nothing: it manufactures false assurance about safety and quality. "3 open high-risk issues" when the
identity can only see one company's issues is not a small error; it is an inverted conclusion.

### 6.1 Required behaviour

1. **Coverage is a first-class, rendered object, not a log line.** Every scope (hub, project,
   domain) carries a coverage state that the UI displays alongside the number.
2. **Three distinct renderings, never conflated:** `0` (we can see this scope and the count is
   genuinely zero), `Not Applicable` (Autodesk produces no data here under documented eligibility
   rules, including the Construction IQ eligibility case), and `Coverage unknown / restricted`
   (we could not establish that the identity can see this scope).
   **Absence MUST NEVER render as "low risk".**
3. **Explicit coverage audit at ingest.** For each project × domain, record whether the module
   returned data, returned an empty set, or was unreachable, plus the identity used. The canonical
   model already carries `Project.accessible` and `Project.availableDomains`; ingest-time detail
   belongs in `IngestionJob.warnings` and `ColumnReportRow`.
4. **Aggregates state their denominator.** Any hub-level or portfolio number displays "across N of M
   projects with coverage". A composite index computed over partial coverage is labelled partial —
   `MetricProvenance.valueKind = "application-derived"` is necessary but not sufficient; the
   coverage caveat travels with the number to the screen, to CSV export, and to any snapshot row.
5. **Coverage warnings use icon + text, never colour alone.** Per the brand rules, severity colours
   (good `#0CA30C`, warning `#FAB219`, serious `#EC835A`, critical `#D03B3B`) are always paired with
   an icon and a text label. `#FFFF00` Hello Yellow is accent/focus only and is never a series or
   status colour — its contrast is insufficient.
6. **Suspicious-coverage detection.** Compare each ingest with prior authorized baselines by domain.
   A sudden population drop is a permission-change signal, not a business improvement, and must
   raise a coverage warning rather than a downward trend line. The same logic applies to [DOC]
   `isDocumentLimitReached: true` on a model set, which silently freezes clash data at the
   1,000-document cap — a naive dashboard reads that as improving coordination.

### 6.2 Mandatory Construction IQ disclosures

Where a Construction IQ value is displayed, these documented statements travel with it. They are
integrity controls, not legal boilerplate:

- "Not every issue that Construction IQ identifies as high risk may be a high-risk issue.
  Conversely, Construction IQ may not detect every high-risk issue."
- "A project's risk level doesn't indicate whether it's well managed; instead it indicates that the
  project has a higher than normal risk level for that day." — therefore **no cross-project risk
  leaderboard from raw CIQ values without normalisation.**
- `user_*` columns are **human overrides** and can disagree with the ML value in the same row; the
  UI shows which one it rendered. A NULL override means the model value remains effective; the
  implementation must evaluate this per record rather than assume an account-wide default.
- Cost impact and quality risk are separate models; `cost_impact` is not a proxy for risk.

### 6.3 Naming discipline (integrity, enforced)

An application-derived value MUST NEVER be described in a way that implies Autodesk computed it.

| Permitted, Autodesk's value | Required, ours |
|---|---|
| "Construction IQ Quality Risk" (`iq_project_daily_quality_risk_changes.daily_risk`) | "Derived Risk Exposure Index" |
| "Construction IQ Cost Impact" (High/Medium/Low) | "Derived Cost Exposure" |
| RFI `cost_impact` / `schedule_impact` (Yes/No/Unknown), Autodesk source-of-record | "Derived Schedule Linkage" |
| Schedule `is_critical_path`, `total_slack_duration` — **from the imported project schedule file** (P6/MSP/Asta), labelled as such, not as Autodesk-computed | "Derived Critical Path Exposure" |

There is **no documented** project-level safety-risk dataset in the platform:
`iq_project_daily_safety_risk_changes` does not appear in the documented schema. Any project safety
figure is ours, is labelled application-derived, and is never called "Construction IQ Safety Risk".

---

## 7. Relationships governance

**[DOC] Relationship read access is deliberately permissive across module permissions.** Any project
member can see that an edge exists between two records, including records they cannot open. The docs
state relationships are bi-directional, that entity order is ignored, and that older modules do not
write relationships at all.

Security consequences and required controls:

1. **Dangling edges MUST be filtered from customer-visible output.** [OURS] An edge whose counterpart
   record is not present in the session's authorized, dereferenced record set is dropped before
   render — not shown as "1 linked record (no access)". Showing the count leaks the existence and
   volume of records the identity cannot open, which is exactly the leak the permissive read model
   creates. The drop is counted and surfaced as a coverage note ("N linked records not shown"),
   which conveys incompleteness without conveying content.
2. **Dereference before display, always.** The graph is built from edges but rendered from records.
   An edge is only renderable once both endpoints have been resolved to records the identity can
   read, with a title, a project and a status.
3. **Ingestion order is a control, not just an optimisation.** [OURS] Relationships sync runs last
   among REST work so both endpoints of an edge are already resident, which makes the dangling-edge
   filter a local decision rather than a live callback that could be skipped under load.
4. **No causality claims.** Edges are untyped, undirected, unattributed, have no `createdBy` and are
   capped at exactly two entities. The canonical model encodes this: `RelationshipConfidence` is
   `confirmed | inferred | none` and `RelationshipMethod` names the mechanism
   (`acc-relationship-service`, `clash-group-issue-id`, `shared-document-lineage`,
   `shared-location-and-root-cause`, `shared-location-window`). The UI says "linked" for confirmed
   edges and "associated" for inferred ones. It never says "caused" or "led to".
5. **Sample-size honesty.** The UI MUST display the post-filter edge count so an executive cannot
   over-read a small sample. Presenting a sparse graph as a portfolio conversion funnel is a
   misrepresentation, and the visible count may fall further after dangling-edge filtering.
6. **`is_service_owned` is a confidence signal, not a permission signal.** When supplied, it may
   inform `RelationshipConfidence`; it grants nothing.

> **OPEN ITEM 6** (§13). Which relationship pairs are writable, and which are actually populated, is
> unresolved. `GET /bim360/relationship/v2/utility/relationships:writable` must be called at runtime
> and the application must degrade gracefully. V1 writes nothing (§8), so this is a read-planning
> item today and a prerequisite for any future write scope.

---

## 8. Write-back posture

**V1 is strictly read-only against Autodesk.** [OURS]

Not implemented, not behind a feature flag, not present in the codebase:

- No issue creation, modification, status change, or comment.
- No closing, resolving or dismissing a risk in ACC.
- No assignment or reassignment of any record.
- No messaging, notification, mention or email sent through Autodesk.
- No relationship creation or deletion.
- No Data Connector request creation on behalf of an end user from a UI action.
- No writes to Cost, Submittals, Forms, Reviews, Locations or Model Coordination.

Enforcement, in order of reliability:

1. **Scope.** The requested OAuth scope set is read-only (§3.4). A write is rejected by APS before
   it reaches a resource.
2. **Client.** The APS HTTP client exposes only `get` and the specific documented `POST`-shaped
   *read* operations the platform requires — `POST .../search:rfis`,
   `POST relationships:intersect`, `POST relationships:sync`, `POST relationships:syncStatus`, and
   Data Connector request creation from the scheduled ingestion job. There is no generic `post`,
   `patch`, `put` or `delete` method on the client. Adding one is a reviewable architectural change,
   not a line of code.
3. **Provider interfaces.** `IssuesProvider`, `RfiProvider`, `FormsProvider`, `ReviewsProvider`,
   `SubmittalsProvider`, `ScheduleProvider` and `DataConnectorProvider` declare read methods only.
   A write has nowhere to live.

Mitigations are recorded **locally** by `MitigationService` in PostgreSQL. A mitigation is Forma Risk
Radar state; it does not change anything in Autodesk, and the UI says so explicitly rather than
implying the source record was updated. Marking a risk as mitigated here and having it still be open
in ACC is the expected state, and the UI must not obscure it.

**Future writes** (deliberately architected for, deliberately not built): any controlled write would
require a **separate OAuth scope**, a **separate explicit approval step in the UI with a confirmation
that names the exact record and the exact change**, an audit record written before the call and
resolved after it, and a distinct provider interface. It would not reuse the read client, and it
would not be enabled by an environment variable alone.

---

## 9. Data residency, minimisation, and PII

### 9.1 Region is a per-hub property

[DOC] ACC/Forma hubs are region-bound. The application supports **US and EMEA** as configured
by `ACC_REGION` (blank = let Autodesk route) — these are the only values the module references
document. Other region values remain unsupported until validated in an approved environment
(§13 item 7). Critical
properties:

- **Region is a property of the hub, not of the application, the user, or the request.** Data for a
  hub provisioned in EMEA is EMEA data regardless of where this application runs.
- [DOC] Hub Admin does not auto-route. The region must be probed (200 = correct, 404 = wrong) and
  cached per hub. Header names differ by module: `x-ads-region` (Issues, Model Coordination,
  Relationships), `Region` (Hub Admin), `region` (Cost); Submittals, Forms and RFIs document no
  region header.
- [DOC] Several endpoints document only `US, EMEA` even though the platform lists eight regions.
  Requesting an undocumented region value is not a supported configuration.
- [OURS] Ingestion reads the extract's `metadata.region` value and refuses to load an extract whose
  region does not match the configured region for that hub. A silent cross-region load is a
  residency incident.

### 9.2 Where the copy lives

This application **necessarily creates a local copy of customer data**, because [DOC] Data Connector
extracts are purged after 30 days, activities are capped at a 12-month lookback, and every Tier D
dataset (Hub Admin, Locations, all lookup/config data, Model Coordination membership, latest-revision-only
Schedule) has no history at all. The product owns the time dimension; that means the product owns an
archive.

Therefore the deployment's own location is a residency decision, and it is the operator's:

- The PGlite data directory or the `DATABASE_URL` server MUST be in a region compatible with the
  hub's region. The application cannot enforce this; it MUST document it and it MUST record the
  configured hub region alongside every ingested batch so an operator can audit it.
- One deployment serves one hub. Multi-hub, multi-region tenancy in a single database is out of
  scope for V1 precisely because it turns a configuration mistake into a cross-border transfer.

### 9.3 Minimisation at ingest

We extract the service groups the risk model needs — `admin`, `issues`, `rfis`, `submittalsacc`,
`forms`, `checklists`, `cost`, `iq`, `locations`, `relationships`, `schedule`, `reviews`, and
`activities` as a separate windowed job. Extracts can include unrelated datasets such as markups,
photos, takeoff classifications, sheets and meeting minutes. Groups that the risk model does not
consume are **not requested**, and where a group must be requested for a few tables, unconsumed
tables are not loaded into PostgreSQL. Every row we do not hold is a row we cannot leak.

### 9.4 PII

Identity and participant datasets may carry `email`, `phone`, postal-address fields, `job_title`,
`last_sign_in`, access-level flags and information about external participants. Treat all such
fields as sensitive even when the current risk model does not consume them.

Rules:

- Load only the identity columns the product needs to resolve an assignee or a company: `id`,
  `autodesk_id`, `name`, `default_company_id`, `status`. **Do not load** postal address, phone or
  `job_title` — no risk metric consumes them.
- `email` is loaded only if required to resolve identity where `autodesk_id` is insufficient; if
  loaded it is treated as sensitive, is never logged (§2.3), is never included in a CSV export, and
  is never sent to an AI provider (§10).
- Do not compile personal profiles across sources. Ownership and accountability analytics operate on
  opaque ids and display names, not on person dossiers. Missing assignment is a *coverage* story
  about assignment discipline, not a story about individuals.
- [DOC] Deleted companies have their `name` overwritten with `"removed at MMDDYYYY"`. Do not treat
  that string as a company name; detect it and render the company as removed.

---

## 10. AI and third-party data flow

**Default: `AI_RECOMMENDATIONS_ENABLED=false`. No Autodesk customer data is sent to any third-party
AI provider.** While the flag is false the application makes no outbound request to any LLM provider,
and `ANTHROPIC_API_KEY` is unread.

Deterministic rules always run and require no configuration. They produce
`Recommendation.origin = "deterministic-rule"` with a `ruleId`, and they are the sole source of
recommendations in the default configuration. The product is fully functional with AI off; AI is
additive, never load-bearing.

When an operator explicitly enables it:

| Control | Requirement |
|---|---|
| Payload | **Minimised structured risk context only** — counts, severities, normalised category labels, aggregate ages, derived index values, domain names. |
| Never sent | Raw records; `RiskRecord.raw`; issue/RFI titles, descriptions, comments or responses; attachments; user names; emails; company names; project names; location names; model/document names; any PII from §9.4; any Autodesk identifier that would let the provider correlate to a real project. |
| Identifiers | Replaced with opaque per-request surrogates. The mapping stays server-side and is discarded after the response is rendered. |
| Labelling | Every AI output renders as **"AI Suggested Action"**, with `Recommendation.origin = "ai-suggested"` and `MetricProvenance.valueKind = "ai-generated"`. |
| Evidence | Every AI suggestion cites `EvidenceRef` records resolved **locally after** the response returns. The model does not supply evidence; it supplies a suggestion, and we attach the evidence we already hold. A suggestion whose citations cannot be resolved is discarded, not shown. |
| Authority | An AI suggestion never changes a metric, a severity, an index, or a rank. It is advisory text beside a deterministic result. |
| Residency | Enabling AI may transfer data outside the hub's region. The setting's documentation says so, and enabling it is an operator decision recorded in the audit log (§12). |
| Prompt injection | Autodesk record content is untrusted input. Because no raw record text is sent, the injection surface is minimal by construction — this is a second reason for the minimisation rule, beyond confidentiality. Model output is rendered as **text**, never as HTML or markdown that can produce a link or script, and never interpreted as an instruction to the application. |

---

## 11. Input validation, SQL, and output encoding

### 11.1 Input validation

Every route handler and server action validates its inputs at the boundary with a schema
(zod or equivalent) before any other work. Untyped access to `searchParams`, `params` or a request
body is lint-banned.

| Input | Rule |
|---|---|
| Hub id | Bare GUID, exact regex. Data Management's `b.` prefix is added at that call site only, never stored. Rejecting the wrong form early prevents the prefix reaching Data Connector, where it is invalid. |
| Project id | GUID regex, **and** membership in the session's accessible project set (§4.3). Format validity is not authorization. |
| Record ids (issue, RFI, submittal, form, clash group, relationship guid) | GUID regex, plus scoping to a validated project id. |
| Dates / windows | ISO-8601; window length clamped server-side. [DOC] the activities window max is 31 days and exceeding it does **not** error — it silently returns the default range. Assert the returned row range rather than trusting the request. |
| Pagination | Integer, bounded, server-clamped to the documented per-module maxima (Issues `limit=100`, RFIs `limit=200`, Submittals `limit=50`, Forms `limit=200`, Locations `limit=10000`). |
| Service groups, table names, column names, sort keys, dimension keys | **Allowlist only**, never pass-through. `ConcentrationDimension`, `RiskDomain` and `SourceRecordKind` are closed unions in the canonical model and are validated against those unions. |
| Free-text search | Length-capped, treated as a parameter value only (§11.2), never concatenated. |
| `returnTo` and any redirect target | Relative path, leading `/`, no `//`, no `\`. |

### 11.2 SQL

- **All SQL is parameterised.** String interpolation of a value into SQL is banned and CI-checked.
  This holds identically on PGlite and on a `DATABASE_URL` server — the schema and the SQL are the
  same; only the driver differs.
- Identifiers (table names, column names) cannot be parameterised. Where a query is built
  dynamically across varying extract tables, identifiers come from a **compile-time
  allowlist derived from the ingest schema definition**, never from a request. A request supplies a
  key into the allowlist, not an identifier.
- The risk model uses window functions, `generate_series`, recursive CTEs, `jsonb` and
  `percentile_cont`, all verified to work on PGlite. None of them require dynamic SQL construction
  from user input.
- Every query that returns customer data takes the accessible-project-id list as a bound parameter
  and filters on it (§4.3). There is no "unscoped read" helper.
- Least privilege on a real server: the `DATABASE_URL` application role has
  `SELECT/INSERT/UPDATE/DELETE` on its own schema and no `CREATE/ALTER/DROP`. Web startup performs
  read-only checksum verification of the immutable migration ledger and fails closed if anything is
  absent or altered. It never creates the ledger or runs migration DDL.
- Migrations run before deployment through `npm run db:migrate` under a separate, DDL-capable
  `MIGRATION_DATABASE_URL` role. `DATABASE_URL` is deliberately not a fallback for this command, and
  the migration credential must not be injected into the long-running web process.
- Every external PostgreSQL workload has finite pool size, connection acquisition, server-side
  statement, client-side query, lock, idle-connection, and connection-lifetime bounds. The client
  query deadline is slightly longer than `statement_timeout` so PostgreSQL normally cancels and
  reports the statement before the client abandons the wait.
- Every non-loopback PostgreSQL connection uses certificate-verified TLS and requests channel
  binding when the server offers it. Plaintext is allowed only on loopback. All connection-string
  query parameters and fragments are rejected so they cannot replace the URL authority or the
  application-owned TLS and timeout policy; deployments use a server certificate chained to a CA
  trusted by Node.js.
- Statement timeouts are set so a pathological analytic query is a failed request, not a stalled
  process.

### 11.3 Output encoding

- React escapes by default. `dangerouslySetInnerHTML` is banned outright; there is no sanitiser
  exception, because no Autodesk field needs to render as HTML.
- **Autodesk free-text is untrusted.** Location node names, company `trade` strings, issue titles,
  form labels and project names can all contain customer-entered free text. They are rendered as
  text, everywhere, including in
  chart labels, tooltips, table cells and SVG `<text>` nodes.
- **CSV/Excel export MUST neutralise formula injection.** Any exported cell beginning with `=`, `+`,
  `-`, `@`, tab or CR is prefixed with a single quote. Construction record titles routinely begin
  with `-`, so this is a live case, not a theoretical one.
- **URLs are never taken from source data.** `EvidenceRef.href` is constructed server-side from a
  single allowlisted origin constant plus validated identifier segments. A URL-shaped value present
  in an Autodesk record is rendered as text, never as an anchor `href`. This is the control against
  a malicious link planted in an issue title reaching a user as a clickable element.
- A Content-Security-Policy is set with no `unsafe-inline` for scripts, a nonce for the framework's
  inline bootstrap, `connect-src` limited to `'self'`, `frame-ancestors 'none'`, and
  `form-action 'self'`. Framework `<style>` elements are nonce-controlled; `style-src-attr` permits
  only the application-authored numeric layout attributes used by charts and bars. No source record
  can supply a style object. Companion headers: `Strict-Transport-Security`, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- Error responses to the browser are generic. APS error bodies, SQL errors, stack traces and
  internal identifiers stay server-side; the client receives a correlation id that appears in the
  server log.

---

## 12. Auditability, safe logging, and retention

### 12.1 What is logged

| Category | Logged | Level |
|---|---|---|
| Authentication | Fixed session-established/refreshed/invalidated/expired actions, with session id (opaque), hub scope, timestamp, outcome and correlation id | info |
| Authorization | Hub membership check outcome, accessible project count, per-project access denials with project id and reason | info / warn |
| Coverage | Per project × domain: reachable / empty / unreachable, and the identity kind used | info |
| Ingestion | Job id, source system, service groups, project count, row counts per table, duration, `sourceExtractedAt`, status, warnings — mirroring `IngestionJob` | info |
| Schema drift | Unrecognised or newly-missing columns, per `ColumnReportRow` | warn |
| APS calls | Method, host, path **with identifiers replaced by placeholders**, status, duration, rate-limit headers, APS request id | debug / warn on 4xx-5xx |
| Rate limiting | 429s per module, with the governing documented limit for context (e.g. RFIs 100 rpm per client ID across all RFI endpoints and all projects; Forms 100 rpm across all Forms endpoints; Data Connector 24 jobs per hub per rolling 24 h) | warn |
| Configuration changes | `DATA_MODE`, `AI_RECOMMENDATIONS_ENABLED`, `ACC_REGION`, `ACC_ACCOUNT_ID` at boot and on change | info |
| AI | That a request was made, the surrogate ids used, latency, and the labelled outcome — never the payload content | info |
| Mitigations | Local mitigation create/update: who, when, which risk id, previous and new local state | info |
| Export | Who exported what scope, when, and the row count | info |

### 12.2 What is never logged

Tokens (access, refresh, id, authorization code, PKCE verifier or challenge, OAuth state), the client
secret, the session secret, cookie values, `Authorization` headers, Data Connector signed URLs, full
API response bodies, `RiskRecord.raw`, issue/RFI/submittal/form free-text content, comments,
attachment names, personal data from §9.4, and AI prompt or completion content.

### 12.3 Audit trail properties

- Audit entries are **append-only**; there is no update or delete path in the application.
- Authentication state transitions require a durable audit sink. A custom session store without a
  paired sink fails closed; refresh callers receive a generic authentication failure, callback
  establishment is rolled back, and logout remains effective but returns unavailable if its audit
  write fails. Audit-sink errors are reported without token, cookie, or provider response content.
- Every entry carries: timestamp, actor (Autodesk user id or `system`), session id, action, scope
  (hub / project / record id), outcome, and a correlation id shared with the request log.
- The audit trail is queryable per project so a hub admin can answer "who saw what".
- Provenance is part of auditability: because every displayed number carries `MetricProvenance`
  (`sourceSystem`, `sourceDataset`, `sourceRecordId`, `extractedAt`, `calculatedAt`, `definitionId`,
  `definitionVersion`, `valueKind`), a historical figure can be reproduced and attributed after the
  formula changes. `definitionVersion` is bumped whenever a formula changes so old snapshots stay
  interpretable rather than being silently recomputed under new rules.

### 12.4 Retention

| Data | Retention | Rationale |
|---|---|---|
| Autodesk record archive (PostgreSQL) | Operator-configured; default retain-all | [DOC] DC extracts purge at 30 days and activities cap at 12 months, so the product is the archive by necessity. |
| Daily snapshot rows (`SnapshotRow`) | Retain-all by default | They are the entire time dimension for Tier D data; deleting them destroys history that cannot be re-fetched. |
| Raw downloaded extract files | Deleted after successful load | [DOC] download every run even if the output is discarded, or scheduled extractions auto-pause (14 days for daily/weekly, 2 months for monthly) with no API-level error. Download is mandatory; **keeping** the file is not. |
| Application logs | 30 days default | Post-redaction they contain ids and counts, not content. |
| Audit trail | 12 months minimum, configurable upward | Must outlive an access dispute. |
| Sessions | 24-hour idle / 7-day absolute; deleted at sign-out or on access after expiry; production backlog swept with `npm run sessions:sweep` | Application policy, not Autodesk token policy |
| AI request records | 30 days, metadata only | |

**Deletion on disconnect.** When a hub is disconnected or `ACC_ACCOUNT_ID` changes, the operator MUST
be able to purge all data for that hub — archive, snapshots, mitigations and derived tables — with a
single documented command, leaving the audit trail entry recording that the purge occurred.

---

## 13. Open security items carried forward

These are unresolved. They are listed here rather than assumed away, and each has a defined
validation step. None may be closed by inference.

| # | Item | Why it is a security item | Validation |
|---|---|---|---|
| 1 | Does SSA authentication work against Data Connector? | Determines whether the system needs a long-lived stored refresh token for a human service user — a materially worse credential posture. | Mint a `jwt-bearer` SSA token; `POST /data-connector/v1/accounts/:accountId/requests` with `serviceGroups:["admin"]`, `scheduleInterval:"ONE_TIME"`. 401/403 = fallback path required. |
| 2 | Does SSA work against Relationships v2 and Model Coordination v3? | Same credential question for two modules whose reference sets predate SSA. | `GET /bim360/relationship/v2/utility/relationships:writable`; `GET /bim360/modelset/v3/containers/{id}/modelsets` with an SSA token. |
| 3 | APS access- and refresh-token lifetimes, and rotation semantics | §3.3 currently states assumed values. Wrong assumptions produce either unnecessary refresh traffic or mid-session expiry handled as a data error. | Read `expires_in` from a live token response; confirm against the APS authentication reference. |
| 4 | Exact read-only OAuth scope strings, and whether the granted set can be silently narrowed | A narrowed grant reproduces the §6 under-reporting failure at the auth layer. | Assert granted scope equals requested scope at login; fail closed on mismatch. |
| 5 | Model Coordination visibility for the operating identity | Upload-only folder permission returns **zero model sets with no error**, indistinguishable from "not configured". | Read the `permission` field (None / Read / Edit) on `GET modelsets/:modelSetId`; also check `isDocumentLimitReached`. |
| 6 | Which relationship pairs are writable for the configured account? | Prerequisite for any future write scope; today it bounds what the read graph can contain. | `GET /bim360/relationship/v2/utility/relationships:writable`; cross-check a representative sample of issues the UI shows with References. |
| 7 | Region topology of the configured account, and which region header each module honours | A wrong-region call returns 404, which is indistinguishable from absence and is a residency risk if it succeeds against the wrong store. | Run the 200/404 region probe per module; confirm whether anything beyond `US`/`EMEA` is accepted for Issues, Model Coordination and Relationships. |
| 8 | Does the configured account contain BIM 360 projects? | BIM 360 projects need a second code path; Issues v1, RFIs v3, Forms, Submittals v2 and Locations writes are **not compatible** with them, and an unhandled BIM 360 project is a silent coverage hole. | `GET /construction/admin/v1/accounts/:accountId/projects?filter[platform]=bim360`. |
| 9 | Data Connector job state-machine token set | `status == "complete"` without branching on `completionStatus` produces a load of a failed job's partial output — an integrity failure that looks like a data drop. | One `ONE_TIME` job; record the literal `status` / `completionStatus` tokens, the `data-listing` behaviour on failure, and the master-ZIP filename. |
| 10 | Activities backfill depth | If the 12-month lookback is hard, longer baselines require Autodesk's manual "Request Full Historical Activity Data" process — a human-latency dependency with its own approval path, which must be raised at onboarding, not at go-live. | Request `activities` for a window 11 months back; confirm rows return. |

---

## 14. Review checklist

A change is not mergeable if it:

- Introduces an APS call from client-side code, or exposes any token to the browser.
- Adds a `NEXT_PUBLIC_` variable carrying a secret, or logs a token, secret, cookie or signed URL.
- Reads customer data without the accessible-project-id filter.
- Renders an empty result as zero risk where coverage was not positively established.
- Labels an application-derived value with an Autodesk name, or omits `MetricProvenance`.
- Renders a relationship edge whose counterpart the identity cannot read.
- Adds a write method to the APS client or a write method to a provider interface.
- Sends any raw Autodesk record content to an AI provider.
- Interpolates a value into SQL, or an identifier into SQL from a request.
- Uses `dangerouslySetInnerHTML`, or constructs an `href` from source data.
- Conveys severity by colour alone, or uses `#FFFF00` as a status or series colour.
