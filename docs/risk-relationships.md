# Risk Relationships

How Forma Risk Radar links one risk record to another: what Autodesk actually stores, what runtime
validation must establish, and what the application infers on top. Implementation reference.

---

## 0. Evidence labels used throughout

Every claim in this document carries one of two labels. They are not decoration — they map
directly onto `ValueKind` and `RelationshipConfidence` in
`src/lib/canonical/types.ts`, and the UI must be able to render the distinction.

| Label | Meaning | Source of truth |
|---|---|---|
| **[DOC]** | Documented behaviour of a published Autodesk API or Data Connector dataset. | Autodesk reference documentation, as consolidated in the feasibility synthesis. |
| **[DERIVED]** | Forma Risk Radar computes this. Autodesk asserts nothing about it. | This application. |

A value that is **[DERIVED]** must never be rendered in a way that implies Autodesk produced it.
"Construction IQ Quality Risk" is an Autodesk value. "Derived Risk Exposure Index" is ours.

### Naming

**[DOC]** Autodesk Construction Cloud was renamed **Forma** effective **2026-03-24**. The API
documentation set is now titled *"Forma APIs"* and lives at `/en/docs/acc/v1/`, but every base path
is unchanged: `/construction/…`, `/cost/v1/…`, `/bim360/…`, `/data-connector/v1/…`. The
Relationships service in particular still lives under `/bim360/…` and that is not a legacy
mistake — it is the current path.

This is **not** Forma Site Design (ex-Spacemaker) at `/en/docs/forma/v1/`, which has no Issues,
RFIs, Submittals, Forms, Construction IQ or Data Connector and is entirely out of scope. A bare
GUID hub IDs identify ACC-now-Forma; Forma Site Design uses `pro_…` IDs. Validate the configured
identifier before making provider calls.

---

## 1. The ACC Relationships service

### 1.1 Base path and endpoints

**[DOC]** Base path: **`/bim360/relationship/v2`**.

| Purpose | Call |
|---|---|
| Read edges touching a container | `GET /bim360/relationship/v2/containers/:containerId/relationships:search` |
| Read edges for a supplied set of entities | `POST /bim360/relationship/v2/containers/:containerId/relationships:intersect` |
| Incremental change feed (includes soft deletes) | `POST /bim360/relationship/v2/containers/:containerId/relationships:sync` |
| Cheap poll for "is there anything new" | `POST /bim360/relationship/v2/containers/:containerId/relationships:syncStatus` |
| Which domain/entity-type pairs this token may **write** | `GET /bim360/relationship/v2/utility/relationships:writable` |

**[DOC]** `containerId` for Relationships is the **Docs project GUID**, not a synthesised value.
Read it from `relationships.<service>.data.id` on the Data Management project. Never construct a
service container ID from a project ID — in Autodesk's own sample payload, cost and submittals
containers equal the project GUID while issues/rfis/markups/checklists share a different one.

**[DOC]** Region header for this service is `x-ads-region`. Rate limit is **120 rpm per APS user
account**. Sharding across client IDs does **not** raise it; shard across service identities.

Bulk alternative used by this product: the Data Connector `relationships` service group, table
`relationships_entity_relationship`. Treat its population as account-specific and disclose coverage.

### 1.2 The record shape

**[DOC]** REST record: a relationship GUID, an `entities` array, `createdOn`, and the soft-delete
pair `isDeleted` / `deletedOn`.

Data Connector flattens the same record into columns:

```
relationships_entity_relationship
  bim360_account_id, bim360_project_id, relationship_guid,
  item1_domain, item1_entitytype, item1_id,
  item2_domain, item2_entitytype, item2_id,
  created_on, deleted_on, is_deleted, is_service_owned
```

State the following plainly to anyone who asks what the graph can do:

| Property | Status |
|---|---|
| Edge has a **type** or label | **No.** There is no type, category or label field of any kind. **[DOC]** |
| Edge has a **direction** | **No.** **[DOC]** Autodesk states verbatim: *"relationships are bi-directional, there is no notion that a relationship can only be followed in a single direction"* and *"the entity order is ignored"*. |
| Edge is **binary** | **Yes, exactly 2.** `entities` is capped at exactly two members. There is no n-ary relationship record. **[DOC]** |
| Edge has an **author** | **No.** No `createdBy`. The sync feed likewise has no `deletedBy` — you learn *what* changed, never *who*. **[DOC]** |
| Edge has an **updatedAt** | **No.** Only `createdOn`, and `deletedOn` when soft-deleted. **[DOC]** |
| Edge has a **weight, score or confidence** | **No.** **[DOC]** |
| Edge distinguishes system from human creation | **Partially.** DC exposes `is_service_owned`; this is the only creator-side signal available and it is a boolean, not an identity. Validate its raw encoding at ingest. |

Because the relationship is documented as undirected, ingest must tolerate the same logical link
appearing as `(A,B)` and `(B,A)`. **Deduplicate on `relationship_guid`, and additionally on the
unordered pair `{(domain,type,id)₁, (domain,type,id)₂}`, before counting anything.** A naive
`COUNT(*)` can overstate an edge population.

### 1.3 Sync semantics

**[DOC]**

- `relationships:sync` is a genuine incremental change feed and it does report soft deletes
  (`isDeleted`, `deletedOn`).
- The only available filter is `filters.domains`, capped at **20 domains**.
- A `syncToken` obtained from a filtered search **inherits that filter**. Changing the domain list
  requires a fresh token and a full re-read.
- Poll `syncStatus` first (cheap), call `sync` only when `moreData` indicates new data.

### 1.4 Two constraints that change how absence must be read

**[DOC]** *"Older modules that existed before relationships API was introduced do not use this
API."* Therefore **absence of an edge is not evidence of absence of a real connection.** The UI
must never render "no linked records" as "this issue is isolated". It renders "no links recorded in
ACC".

**[DOC]** Autodesk warns that UI-created pairs may be readable but not API-writable *"because some
of them have not been exposed with 3-legged token support"*. The app calls
`GET /bim360/relationship/v2/utility/relationships:writable` at runtime and degrades gracefully.
Note the asymmetry that matters for this product: a clean writable matrix does **not** imply the
pairs are populated. This product only reads, so writability is a diagnostic, not a dependency.

---

## 2. Relationship domains and runtime validation

Discover the distinct domains and entity types from
`relationships_entity_relationship` on every configured account. Do not use one account's
population as a platform allowlist.

### 2.1 Population handling

Relationship counts must be computed after deduplicating on `relationship_guid` and the canonical
unordered entity pair. Every funnel or comparison view must show its current deduplicated sample
size, extraction timestamp, and coverage state. Sparse populations are evidence of limited recorded
adjacency, not evidence that business relationships do not exist.

Entity presence and useful population remain runtime facts; enumerate both from each current
extract rather than relying on a static census.

### 2.2 Documented entity types may be absent

**[DOC]** The `autodesk-bim360-issue` domain documents `issue`, `quality`, `design`,
`coordination`, and `collaboration`. A configured hub may expose only a subset. When `design`
edges are absent, design-issue identity can instead come from Construction IQ sidecars, subject to
coverage disclosure.

**[DOC]** The `autodesk-bim360-cost` domain documents `budget`, `budgetpayment`, `contract`,
`costpayment`, `maincontract`, `oco`, `pco`, `rco`, `rfq`, and `sco`. There is no
`costitem` entity type, so line-level cost cannot be linked through this graph.

**[DOC]** Autodesk also documents `autodesk-construction-submittals/submittalitem`,
`autodesk-construction-schedule/activity`, `sheet/sheetlineage`, `markup/markupdocument`,
`cost/expense`, and `form/formtemplate/formfield`. Some documented examples cover only
`asset ↔ …` pairings. Any other pairing discovered at runtime must remain account-specific,
not promoted to a documented platform guarantee.

---

## 3. The confidence model

The product exposes exactly three confidence levels, matching `RelationshipConfidence` in
`src/lib/canonical/types.ts`:

```ts
export type RelationshipConfidence = "confirmed" | "inferred" | "none";
```

Each is produced by a specific `RelationshipMethod`. No other method may set a confidence.

| `RelationshipMethod` | Confidence | Basis | Evidence label |
|---|---|---|---|
| `acc-relationship-service` | **confirmed** | A row exists in `relationships_entity_relationship` (or the REST `relationships:search` result) linking the two records. | [DOC] mechanism; runtime population |
| `clash-group-issue-id` | **confirmed** | `clashes_assigned_clash_group.issue_id` is populated and resolves to a known issue. A first-class foreign key, not a graph edge. | [DOC] `issueId` on `clashes/assigned`; validate DC column availability |
| `shared-document-lineage` | **inferred** | Both records reference the same document. Issues: `issues_issues.linked_document_urn`. RFIs: `rfis_rfis.linked_document` / `linked_document_version`. | [DERIVED] inference; validate column availability |
| `shared-location-and-root-cause` | **inferred** | Both records carry the same `location_id` **and** the same normalised root cause label. | [DERIVED] |
| `shared-location-window` | **inferred** | Both records carry the same `location_id` and were created inside a configured time window. The weakest method. | [DERIVED] |
| *(no method matched)* | **none** | Rendered as "no recorded link". Never as "unrelated". | — |

Rules that are not negotiable:

1. **`confirmed` means Autodesk stored a link. It does not mean Autodesk stated a cause.** Even a
   `confirmed` edge is untyped and undirected. `confirmed` licenses the word "linked", never
   "caused".
2. **An inferred edge may never be upgraded to confirmed by accumulating more inferred evidence.**
   Three weak signals are still `inferred`. Confidence is a statement about the *source*, not about
   our subjective certainty.
3. `is_service_owned` is carried through to `RiskRelationship.serviceOwned` and shown, because a
   user-created link and a service-created link are different kinds of assertion. Validate the raw
   encoding at ingest.
4. Confidence is displayed on **every** rendered edge. There is no default and no hidden state.

---

## 4. The Risk Conversion Funnel

The intended narrative is:

```
Design Issue → RFI → Field Issue → Change → Rework → Cost / Schedule Impact
```

**The funnel is architecturally traversable, but its population is account-specific.** The UI must
always disclose the current deduplicated sample size.

### 4.1 Stage-by-stage verdict

| # | Transition | Verdict | Mechanism | Runtime validation |
|---|---|---|---|---|
| 1 | Design Issue → RFI | **inferred** | No direct link exists. See §4.3. The generic `issue ↔ rfi` edge does not distinguish a design issue from a field issue — the edge carries no type. | Measure the deduplicated `issue ↔ rfi` population and classify issue endpoints at runtime. |
| 2 | RFI → Field Issue | **confirmed** *(adjacency only)* | Same `issue ↔ rfi` edge population. Because the edge is undirected, stages 1 and 2 read the **same rows**; they are separated only by [DERIVED] classification of the issue endpoint and by `created_at` ordering. | Show the same disclosed edge population; do not imply two independent stages. |
| 3 | Field Issue → Change | **confirmed** *(adjacency only)* | `issue ↔ cost/pco` edge. | Measure and disclose the deduplicated population. |
| 3b | RFI → Change | **confirmed** *(adjacency only)* | `rfi ↔ cost/pco` edge. | Measure and disclose the deduplicated population. |
| 4 | Change → Rework | **UNSUPPORTED** | There is no rework entity, no rework field, and no rework flag anywhere in ACC/Forma. No API and no dataset. | n/a |
| 5 | → Cost Impact (monetary) | **UNSUPPORTED** | **[DOC]** No cost amount exists on an issue (the Issues `fields` whitelist has none). Change orders carry `sourceType` as **free text with no enum and no companion entity ID**; `sourceId` points at the originating PCO inside Cost Management, not at a risk record. | n/a |
| 5b | → Cost Impact (categorical) | **confirmed, Autodesk value** | `iq_cost_impact_issues.cost_impact`, documented enum **High / Medium / Low**. This is a per-issue classification, not a funnel edge and not money. | Profile value distribution and disclose coverage. |
| 5c | → Cost Impact (RFI flag) | **confirmed, Autodesk value** | `rfis_rfis.cost_impact` ∈ `Yes` / `No` / `Unknown` / NULL. A flag, never an amount. | Profile value distribution and disclose coverage. |
| 6 | → Schedule Impact (linkage) | **[DOC] NOT SUPPORTED** | There is no ACC/Build Schedule REST API, and Relationships documents `schedule/activity` only in an `asset ↔ activity` pairing. Additional pairings discovered at runtime are account-specific adjacency, never a documented platform capability. | Enumerate pairings and disclose sample sizes per account. |
| 6b | → Schedule Impact (RFI flag) | **confirmed, Autodesk value** | `rfis_rfis.schedule_impact` ∈ `Yes` / `No` / `Unknown` / NULL. | Profile value distribution and disclose coverage. |

**[DERIVED]** Funnel *membership* can be approximated from undirected adjacency plus `createdOn`
ordering — the approximation is ours. Autodesk documents no funnel, no membership and no stage
concept. **[DOC]** Funnel *conversion* cannot be approximated at all: there is no direction, no
edge type, no author, and no n-ary
record. Where the synthesis says staged conversion is NOT SUPPORTED, it is not "partially"
supported and not "limited" — the required input does not exist.

### 4.2 Mandatory UI treatment

Small samples are not a funnel. The following are hard requirements, not styling preferences.

1. **Every funnel stage displays its edge count** adjacent to the stage, at the same visual weight
   as the stage label. An executive must see the sample size before interpreting a conversion rate.
2. **Percentages and conversion rates are suppressed below a configured minimum edge count.** Below
   the threshold the UI shows the raw count and the words "insufficient data".
3. **The funnel is rendered as a timeline ordered by `created_at`, not as a directed flow diagram
   with arrows implying causation.** **[DOC]** Autodesk states entity order is ignored; drawing an
   arrow asserts something Autodesk does not.
4. **A caption is always present:** *"Records linked in ACC. Ordering shown by creation date.
   Direction and causality are not asserted by Autodesk."*
5. **Absence renders as "no links recorded", never "no impact".** **[DOC]** Older modules do not
   write relationships at all.
6. Stage 4 (Rework) is either omitted from the visual or shown explicitly greyed with "not
   available in ACC". It is never silently collapsed into stage 5, which would make an unsupported
   stage look like a zero.

### 4.3 Design-to-RFI propagation

**[DOC]** **There is no direct design-issue → RFI causal link.** Nothing in the platform records
that a design issue produced an RFI. The `issue ↔ rfi` edge that exists is untyped, undirected,
unattributed and binary, and it does not indicate that the issue endpoint is a design issue.

The defensible **[DERIVED]** bridge combines three independent signals. All three must be present
for the app to emit an inferred edge; any weaker combination produces `confidence: "none"`.

| Signal | Data basis | Method |
|---|---|---|
| **Shared document lineage** | Match `issues_issues.linked_document_urn` against `rfis_rfis.linked_document` / `linked_document_version`, after validating column availability. Optionally corroborate with a shared `documentlineage` counterparty in the relationship graph. | `shared-document-lineage` |
| **Shared root cause** | Construction IQ predicts root cause on both sides. Normalize only values present in the current account, preserve the raw labels, and require an exact normalized match. | `shared-location-and-root-cause` (root-cause term of the composite) |
| **Temporal ordering** | The design issue's `created_at` precedes the RFI's `created_at`. Ordering only — it establishes that the reverse is impossible, not that this direction happened. | applied as a gate on the above |

Open caveat that must not be papered over: the RFI side of the document-lineage bridge may need to
rest on the `rfis_rfis.linked_document` column rather than the graph. Validate coverage before
shipping the bridge; if it is largely NULL, the bridge degrades to root-cause plus location only,
and its confidence stays `inferred` with weaker evidence text.

**Exact permitted language.** The UI renders inferred design→RFI relationships using these words
and no others:

| Permitted | Forbidden |
|---|---|
| "associated with" | "caused" |
| "potential propagation" | "led to" |
| "potentially related to" | "resulted in" |
| "shares a document with" | "because of" |
| "shares a root cause with" | "downstream of" |
| "created before" | "triggered" |
| "linked in ACC" (confirmed edges only) | "converted into" |

Copy strings for relationship rendering live in one module and are reviewed as a unit. Free-text
concatenation of relationship labels at call sites is prohibited, because that is how "caused"
gets in.

---

## 5. Clash → coordination issue

This one is **confirmed**, and it is the only clash-to-issue bridge on the platform.

Two independent mechanisms, both real:

| Mechanism | Basis | Evidence |
|---|---|---|
| Relationship graph | `modelcoordination/clashgroup → issue/coordination` | Optional corroboration; validate population per account. |
| Direct foreign key | `clashes_assigned_clash_group.issue_id` | **[DOC]** the REST equivalent is `issueId` on `GET modelsets/:modelSetId/clashes/assigned`; validate DC column availability. |

**[DOC]** `clashes/assigned` carrying `issueId` is *the only clash↔issue bridge in the platform*.
There is no other route from a clash to a work item.

Implementation notes:

- Reconcile the two mechanisms rather than picking one. Compare their deduplicated populations and
  count non-NULL `issue_id` values before asserting a discrepancy. Treat the
  FK as authoritative for the clash→issue link and the graph edge as corroboration; record which
  mechanism produced each `RiskRelationship` via `method`.
- Related scope- or document-lineage-to-issue edges, when present, are not clash→issue links and
  must not be counted as such.
- **[DOC]** Everything downstream of the clash is thinner than the bridge: there is no clash-count
  endpoint, no clash severity or priority (only `dist`, penetration distance), and no discipline
  field anywhere. Clash counts, backlog, ageing and discipline attribution are all **[DERIVED]** and
  labelled as such.
- **[DOC]** `isDocumentLimitReached: true` on a model set silently freezes clash data at the
  1 000-document cap with no error. A falling clash count may be an artefact. Surface the flag.

---

## 6. Governance: permissive relationship reads

**[DOC]** Relationship read access is deliberately permissive. **Any project member can see that an
edge exists between records they cannot open**, regardless of their permissions in the modules that
own those records. The relationship record itself carries only domain, entity type and ID — but an
ID plus a domain is still a disclosure that a record exists, and the counterparty's title, if the
app resolves it from a different privileged source, is a real leak.

This is a customer-facing dashboard, so the graph is filtered before it reaches output.

### 6.1 Filtering rules

Applied in the read path, not in the UI layer:

1. **Dereference-or-drop.** An edge is admitted to customer-visible output only if **both**
   endpoints resolve to a record the current viewing context is entitled to see. An endpoint that
   cannot be dereferenced with the caller's entitlement is a **dangling edge**.
2. **Dangling edges are dropped whole, not half-rendered.** The product never shows an edge with one
   named endpoint and one placeholder. A partially-rendered edge is worse than no edge because it
   confirms the existence of a hidden record and states what module it lives in.
3. **Dropped edges are counted, not silenced.** Each response carries a suppressed-edge count so an
   analytic can distinguish "no links" from "links you cannot see". The count is exposed to
   operators; whether a customer-facing surface displays it is a per-deployment policy decision, but
   the number must exist.
4. **Deleted edges are excluded.** Filter `is_deleted = t` / `isDeleted` out of all analytics.
   `deleted_on` is retained for audit only.
5. **Ordering matters in the pipeline.** **[DERIVED]** Run relationships sync **last** among REST
   work, after both endpoint populations are already resident, so that a dangling edge means "not
   permitted or not ingested" rather than "not fetched yet". This is our ingestion ordering, not
   documented Autodesk behaviour. Log the two cases differently.
6. **A permission gap is indistinguishable from "nothing happened".** **[DOC]** Every ACC module
   silently under-reports rather than erroring when the service identity lacks access — Issues
   returns only the caller's company's issues under company-scoped visibility; Model Coordination
   returns zero model sets for an Upload-only identity. Identity coverage must be explicitly
   audited; otherwise the suppressed-edge count is measuring our own misconfiguration and reporting
   it as customer permissions.

---

## 7. Auditability

Every relationship the product asserts — **including every inferred one** — is persisted with a
full provenance record. This is the `RiskRelationship` shape in `src/lib/canonical/types.ts`, and
these five fields are mandatory on every row:

| Field | Requirement |
|---|---|
| relationship type | The nature of the assertion. For `acc-relationship-service` edges this is our own descriptor, because **the Autodesk edge itself carries no type** — it must be recorded as an app label, never presented as an Autodesk classification. |
| `confidence` | `confirmed` \| `inferred` \| `none`. Never null, never defaulted. |
| `evidence` | Human-readable justification rendered next to the edge in the UI, naming the concrete data that produced it (e.g. "same `linked_document_urn`; both classified root cause `Documentation Incomplete`; issue created 2026-01-14, RFI created 2026-01-22"). |
| `method` | One of the five `RelationshipMethod` values. Identifies the code path, so a rule change can be re-run against history. |
| `serviceOwned` + `createdAt` | `is_service_owned` and `created_on` from the source row, carried verbatim. Null `createdAt` for edges the app inferred, because no Autodesk timestamp exists for an inference. |

Additional persistence requirements:

- **Every derived edge is reproducible.** The evidence string names the source columns and the
  record IDs on both sides. Given the same extract, re-running the method must reproduce the edge.
- **Inference rules are versioned.** Threshold changes (the `shared-location-window` window length,
  the root-cause matching table) bump `definitionVersion` on the enclosing metric so archived
  snapshots stay interpretable. A relationship count that changed because we changed a threshold
  must be distinguishable from one that changed because the project changed.
- **Autodesk's absent fields are recorded as absent, not as null-and-forgotten.** There is no
  `updatedAt` and no author on an Autodesk edge; the schema does not carry columns that imply
  otherwise.
- **Relationship edges are History Tier A** (they have `sync`, including soft deletes). The
  *dereferenced entities* on either end are Tier D — current-state only, snapshot-and-diff.
  Do not assume the endpoints have the history the edges do.

---

## 8. Open items requiring live validation

Carried forward unresolved. None of these may be closed by assumption.

| # | Question | Why it matters | How to settle it |
|---|---|---|---|
| 1 | Does a Secure Service Account token work against Relationships v2? | The reference set predates SSA and documents only *"a three-legged OAuth flow"*. If SSA fails, headless ingestion of the graph needs a stored refresh token for a human service user. | `GET /bim360/relationship/v2/utility/relationships:writable` with an SSA token. |
| 2 | Which relationship pairs are writable, and which are actually **populated**? | **[DOC]** *"not all modules make use of relationships API at this point"*. A clean writable matrix does not imply data. | (a) call `relationships:writable` and record whether cost↔issue, cost↔rfi, issue↔rfi, submittals/submittalitem and schedule/activity appear; (b) review a representative issue sample with UI References and confirm edges via `relationships:search`. |
| 3 | What are the deduplicated populations for each relationship pair? | These feed funnel display thresholds directly. | Re-count from the current extract with the both-directions dedupe from §1.2 applied. |
| 4 | Is the `formtemplate ↔ asset category` entity-type spelling correct? | `category` is not a documented entity type in the sources available. | `SELECT DISTINCT item1_domain, item1_entitytype, item2_domain, item2_entitytype` on the live extract. |
| 5 | What is the NULL rate of `rfis_rfis.linked_document`? | Determines whether the shared-document-lineage half of the design→RFI bridge is viable at all. See §4.3. | Column profile on the current extract. |
| 6 | Does the `design` entity type appear on an edge in the configured account? | **[DOC]** documented; its presence is account-specific. If absent, design-issue identity depends on the CIQ-sidecar join. | Longitudinal `SELECT DISTINCT` across successive extracts. |
| 7 | Which region header does Relationships honour for the configured account, and does it accept anything beyond `US` / `EMEA`? | **[DOC]** several endpoints document only `US, EMEA` although the platform lists additional regions. Wrong region returns 404, not an error message. | Region 200/404 probe, cached per account. |
| 8 | Does the 20-domain `filters.domains` cap constrain us? | A filtered `syncToken` inherits its filter, so exceeding the cap or changing the domain set forces a full re-read. | Discover the domain count at runtime and decide whether to sync unfiltered. |

---

## 9. Summary of what may and may not be said

| Claim | Allowed? |
|---|---|
| "This clash is linked to coordination issue X." | **Yes** — confirmed, two independent mechanisms. |
| "This issue and this RFI are linked in ACC." | **Yes** — confirmed edge, adjacency only. |
| "This RFI was raised because of this design issue." | **No.** Causality is not supported by any Autodesk data. |
| "This design issue is associated with this RFI (shared document, shared root cause, created earlier)." | **Yes**, labelled `inferred`, with the evidence string shown. |
| "A percentage of design issues converts to RFIs." | **No.** Staged conversion is not supported by an undirected adjacency graph. |
| "The configured account contains N issue↔RFI links." | **Yes**, when N is computed from the current deduplicated population and shown with its extraction time. |
| "Construction IQ rated this issue's cost impact Medium." | **Yes** — Autodesk value, documented enum, from `iq_cost_impact_issues`. |
| "This issue will cost $X." | **No.** Monetary attribution to a risk item is not supported. |
| "This issue is unrelated to anything." | **No.** Absence of an edge is not evidence of absence. |
| "Derived Risk Exposure Index: 62." | **Yes**, labelled application-derived, formula shown. |
