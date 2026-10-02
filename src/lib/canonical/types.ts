/**
 * Canonical internal risk model.
 *
 * Nothing in the UI is allowed to touch an Autodesk API response shape directly.
 * Providers map Autodesk payloads onto these types; every analytic and every
 * component reads only from here. That is what lets a provider be swapped when
 * Autodesk changes an API without the risk engine or the UI noticing.
 *
 * Two rules are load-bearing throughout this file:
 *
 *  1. Every number a user can see carries `MetricProvenance`, and provenance
 *     carries `valueKind`. An application-derived score must never be able to
 *     reach the screen wearing Autodesk's name.
 *  2. Autodesk's own vocabulary is preserved verbatim in `autodeskTerm` where an
 *     Autodesk-defined metric exists. Renaming an Autodesk metric so a derived
 *     value looks official is the specific failure this guards against.
 */

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a value came from, and — critically — whether Autodesk said it or we did.
 *
 * `autodesk-provided`   Autodesk computed this. Construction IQ risk levels,
 *                       RFI cost/schedule impact flags, issue timestamps.
 * `application-derived` Forma Risk Radar computed this from Autodesk records.
 *                       Every index, velocity, recurrence and exposure number.
 * `ai-generated`        An LLM produced this. Advisory only, always labelled.
 */
export type ValueKind = "autodesk-provided" | "application-derived" | "ai-generated";

export type SourceSystem =
  | "acc-data-connector"
  | "acc-issues-api"
  | "acc-rfis-api"
  | "acc-submittals-api"
  | "acc-forms-api"
  | "acc-admin-api"
  | "acc-relationships"
  | "acc-model-coordination"
  | "aps-data-management"
  | "forma-risk-radar" // our own calculation
  | "demo-generator";

export interface MetricProvenance {
  readonly sourceSystem: SourceSystem;
  /** Dataset or endpoint, e.g. "iq_issues_quality_risks" or "GET /issues". */
  readonly sourceDataset: string;
  /** Autodesk's own record id, when the metric traces to a single record. */
  readonly sourceRecordId?: string;
  readonly projectId?: string;
  /** When Autodesk produced the data (extract `created_at`, or fetch time). */
  readonly extractedAt: string;
  /** When we computed the value. Equals `extractedAt` for pass-through values. */
  readonly calculatedAt: string;
  /** Stable id into the risk definition catalog, e.g. "risk.quality.high-open". */
  readonly definitionId: string;
  /** Bumped whenever the formula changes, so old snapshots stay interpretable. */
  readonly definitionVersion: string;
  readonly valueKind: ValueKind;
  /**
   * Autodesk's own name for this metric, when one exists. Present only for
   * `autodesk-provided` values. Never invent one for a derived metric.
   */
  readonly autodeskTerm?: string;
}

/** A value bundled with its provenance. The only shape the UI renders as a metric. */
export interface Measured<T> {
  readonly value: T;
  readonly provenance: MetricProvenance;
  /** Records that produced this value, for drill-down. */
  readonly evidence?: readonly EvidenceRef[];
}

export interface EvidenceRef {
  readonly kind: SourceRecordKind;
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  /** Deep link into ACC, when one can be constructed. */
  readonly href?: string;
}

export type RecordIdentity = Pick<EvidenceRef, "projectId" | "kind" | "id">;

/** Autodesk record ids are not globally unique across projects or services. */
export function recordIdentityKey(identity: RecordIdentity): string {
  return `${identity.projectId}\u001f${identity.kind}\u001f${identity.id}`;
}

export function sameRecordIdentity(left: RecordIdentity, right: RecordIdentity): boolean {
  return left.projectId === right.projectId && left.kind === right.kind && left.id === right.id;
}

// ---------------------------------------------------------------------------
// Severity and risk domains
// ---------------------------------------------------------------------------

/**
 * Ordered severity. Never communicated by colour alone anywhere in the UI —
 * every rendering pairs the colour with this label and an icon.
 */
export type Severity = "critical" | "high" | "medium" | "low" | "none" | "unmapped";

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "unmapped", "none"];

export function severityRank(s: Severity): number {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/**
 * Construction IQ emits `high` | `medium` | `low` (lower case) for quality and
 * RFI risk, and `High` | `Medium` | `Low` for cost impact. Normalise casing but
 * never invent a `critical` where Autodesk said `high` — `critical` is reserved
 * for application-derived escalation and is always labelled as such.
 */
export function severityFromConstructionIq(raw: string | null | undefined): Severity {
  switch (raw?.trim().toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return raw === null || raw === undefined || raw.trim() === "" ? "none" : "unmapped";
  }
}

/** Documented Construction IQ safety-risk categories, normalized to stable keys. */
export type SafetyRiskCategory =
  | "fall"
  | "electrocution"
  | "struck_by"
  | "caught_inbetween"
  | "fire"
  | "other"
  | "unmapped";

/** Unknown nonblank observation values are retained explicitly as unmapped. */
export type SafetyObservationCategory = "positive" | "negative" | "unmapped";

export function trimmedCanonicalText(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function safetyRiskCategoryFromConstructionIq(raw: unknown): SafetyRiskCategory | null {
  const value = trimmedCanonicalText(raw);
  if (!value) return null;
  const key = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  switch (key) {
    case "fall":
    case "electrocution":
    case "fire":
    case "other":
      return key;
    case "struck_by":
    case "struckby":
      return "struck_by";
    case "caught_in_between":
    case "caught_inbetween":
      return "caught_inbetween";
    default:
      return "unmapped";
  }
}

export function safetyObservationCategoryFromConstructionIq(raw: unknown): SafetyObservationCategory | null {
  const value = trimmedCanonicalText(raw)?.toLocaleLowerCase("en-US");
  if (!value) return null;
  return value === "positive" || value === "negative" ? value : "unmapped";
}

/** Accept only the canonical UTC form emitted by Date#toISOString. */
export function canonicalUtcTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw !== raw.trim()) return null;
  const value = raw;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : null;
}

export type RiskDomain =
  | "design"
  | "rfi"
  | "quality"
  | "safety"
  | "subcontractor"
  | "submittal"
  | "coordination"
  | "cost"
  | "schedule";

export const RISK_DOMAINS: readonly RiskDomain[] = [
  "design",
  "rfi",
  "quality",
  "safety",
  "subcontractor",
  "submittal",
  "coordination",
  "cost",
  "schedule",
];

export const RISK_DOMAIN_LABEL: Record<RiskDomain, string> = {
  design: "Design",
  rfi: "RFI",
  quality: "Quality",
  safety: "Safety",
  subcontractor: "Subcontractor",
  submittal: "Submittal",
  coordination: "Coordination",
  cost: "Cost",
  schedule: "Schedule",
};

// ---------------------------------------------------------------------------
// Risk × Exposure × Momentum
// ---------------------------------------------------------------------------

export type MomentumDirection = "improving" | "stable" | "increasing" | "accelerating";

/**
 * The product's central triple. Deliberately NOT collapsed into one number by
 * default — an executive is meant to read the three independently. A composite
 * is available but opt-in, and its weights are shown wherever it appears.
 */
export interface RiskExposureMomentum {
  readonly risk: Measured<RiskDimension>;
  readonly exposure: Measured<ExposureDimension>;
  readonly momentum: Measured<MomentumDimension>;
}

/** How severe is the current condition? */
export interface RiskDimension {
  readonly severity: Severity;
  /** 0–100, application-derived. Null when the published coverage floor is not met. */
  readonly index: number | null;
  readonly highRiskOpen: number;
  readonly criticalOverdue: number;
  /** Present only when Construction IQ supplied a level for this scope. */
  readonly constructionIqLevel?: Severity;
}

/** What could this affect? */
export interface ExposureDimension {
  /** 0–100, application-derived. */
  readonly index: number | null;
  readonly locationsAffected: number;
  readonly companiesAffected: number;
  readonly projectsAffected: number;
  readonly confirmedCostImpact: number;
  readonly potentialCostExposure: number;
  readonly unquantifiedCostImpact: number;
  readonly scheduleLinkedItems: number;
  readonly criticalPathLinkedItems: number;
}

/** Where is this going? */
export interface MomentumDimension {
  readonly direction: MomentumDirection;
  readonly change1d: number | null;
  readonly change7d: number | null;
  readonly change28d: number | null;
  readonly rollingAverage7d: number | null;
  /** Second derivative: is the rate of change itself growing? */
  readonly acceleration: number | null;
  readonly consecutiveElevatedPeriods: number;
  readonly newHighRiskRate: number;
  readonly resolvedHighRiskRate: number;
}

// ---------------------------------------------------------------------------
// Source records
// ---------------------------------------------------------------------------

export type SourceRecordKind =
  | "issue"
  | "rfi"
  | "submittal"
  | "form"
  | "review"
  | "clash-group"
  | "change-order"
  | "schedule-activity";

export interface Hub {
  readonly id: string;
  readonly name: string;
  readonly region?: string;
}

export interface Project {
  readonly id: string;
  readonly hubId: string;
  readonly name: string;
  readonly status: string | null;
  /** Autodesk Hub Admin currentPhase; distinct from lifecycle status. */
  readonly currentPhase: string | null;
  readonly type: string | null;
  readonly classification: string | null;
  readonly businessUnitId: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly value: number | null;
  readonly currency: string | null;
  readonly memberCount: number | null;
  readonly companyCount: number | null;
  /** True when the signed-in Autodesk identity can actually reach this project. */
  readonly accessible: boolean;
  /** Services this project has data for, so the UI can say "no CIQ" honestly. */
  readonly availableDomains: readonly RiskDomain[];
}

export interface BusinessUnit {
  readonly id: string;
  readonly hubId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly path: string;
}

export interface Company {
  readonly id: string;
  readonly hubId: string;
  readonly name: string;
  /** ACC's CSI-style trade string, e.g. "Moisture Protection | Waterproofing". */
  readonly trade: string | null;
  readonly category: string | null;
  readonly status: string | null;
}

export interface LocationNode {
  readonly id: string;
  readonly projectId: string;
  readonly treeId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly order: number | null;
  /** Depth from the tree root, 0-based. ACC has no node *type*, only a tree. */
  readonly depth: number;
  /** Materialised "Building A > Level 04 > East" path, derived. */
  readonly path: string;
}

/**
 * A construction record that can carry risk. Deliberately flat and Autodesk-
 * agnostic: an issue, an RFI and a submittal all reduce to this for the analytics
 * that do not care which they are (aging, ownership, persistence, recurrence).
 */
export interface RiskRecord {
  readonly kind: SourceRecordKind;
  readonly id: string;
  readonly projectId: string;
  readonly displayId: string | null;
  readonly title: string;
  readonly status: string;
  readonly open: boolean;

  readonly domain: RiskDomain;
  /** Construction IQ's model prediction before any human override. */
  readonly constructionIqModelRisk: Severity;
  /** Autodesk-provided when Construction IQ classified it; else "none". */
  readonly constructionIqRisk: Severity;
  /** True when a human overrode Construction IQ's prediction. */
  readonly riskUserOverridden: boolean;

  /** Project-configured RFI category, kept separate from CIQ predictions. */
  readonly rfiCategory: string | null;

  /** Current Construction IQ issue-safety sidecars. These are categories, not risk levels. */
  readonly iqSafetyRiskCategory: SafetyRiskCategory | null;
  readonly iqSafetyRiskPredictedAt: string | null;
  readonly iqSafetyHazardCategory: string | null;
  readonly iqSafetyHazardPredictedAt: string | null;
  readonly iqSafetyObservationCategory: SafetyObservationCategory | null;
  readonly iqSafetyObservationPredictedAt: string | null;

  readonly typeName: string | null;
  readonly subtypeName: string | null;
  /** Project-scoped Autodesk identity from issues_issues.root_cause_id. */
  readonly rootCauseId: string | null;
  readonly rootCause: string | null;
  readonly rootCauseCategory: string | null;
  /** Construction IQ model prediction before any user override. */
  readonly iqRootCauseModel: string | null;
  /** Effective Construction IQ root cause after a source user_* override. */
  readonly iqRootCause: string | null;
  readonly iqRootCauseUserOverridden: boolean;
  readonly discipline: string | null;
  /** Keeps operational/project-configured discipline distinct from CIQ prediction. */
  readonly disciplineOrigin: "operational" | "construction-iq" | "unmapped" | null;
  /** Construction IQ model prediction before any user override. */
  readonly buildingComponentModel: string | null;
  /** Effective Construction IQ building component after a source user_* override. */
  readonly buildingComponent: string | null;
  readonly buildingComponentUserOverridden: boolean;

  readonly locationId: string | null;
  readonly locationPath: string | null;
  readonly companyId: string | null;
  /** How we attributed the company — direct assignment, or via the assignee. */
  readonly companyAttribution: CompanyAttribution;
  readonly assigneeId: string | null;
  /** Safe display label resolved server-side; raw source IDs are never user-facing labels. */
  readonly assigneeName: string | null;
  readonly assigneeType: "user" | "company" | "role" | null;
  readonly ownerId: string | null;
  readonly ownerName: string | null;

  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly dueDate: string | null;
  readonly closedAt: string | null;
  readonly respondedAt: string | null;

  /** Autodesk-provided on RFIs: Yes/No/Unknown, null when absent or disabled, unmapped when an unexpected value is retained. */
  readonly costImpact: TriState;
  readonly scheduleImpact: TriState;
  /** Construction IQ cost-impact classification on issues. */
  readonly iqCostImpact: Severity;

  readonly href?: string;
  /** Untouched source row, so nothing is lost and drill-down can show it. */
  readonly raw?: Readonly<Record<string, unknown>>;
}

/**
 * Issues carry no company field in ACC. Attribution therefore ranges from
 * certain to inferred, and the UI must say which.
 */
export type CompanyAttribution =
  | "direct" // assignee_type = company
  | "via-assignee-membership" // assignee user's project company
  | "via-owner-membership"
  | "unattributed";

/** RFI tri-state fields are nullable when the field is absent or disabled. */
export type TriState = "yes" | "no" | "unknown" | "unmapped" | null;

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

/**
 * ACC's relationship graph is user- and service-created links with no causal
 * semantics. We therefore never say "caused"; we say "linked" for confirmed
 * edges and "associated" for inferred ones, and we always show which.
 */
export type RelationshipConfidence = "confirmed" | "inferred" | "none";

export type RelationshipMethod =
  | "acc-relationship-service" // an actual edge in relationships_entity_relationship
  | "clash-group-issue-id" // clashes_assigned_clash_group.issue_id
  | "shared-document-lineage" // both records reference the same document
  | "shared-location-and-root-cause"
  | "shared-location-window";

export interface RiskRelationship {
  readonly id: string;
  readonly projectId: string;
  readonly from: EvidenceRef;
  readonly to: EvidenceRef;
  readonly confidence: RelationshipConfidence;
  readonly method: RelationshipMethod;
  /** Human-readable justification, shown in the UI next to the edge. */
  readonly evidence: string;
  /** True when Autodesk's own service created the link, not a person. */
  readonly serviceOwned: boolean;
  readonly createdAt: string | null;
  readonly snapshotDate: string;
  readonly deletedAt: string | null;
  readonly algorithmVersion: string;
  readonly provenance: MetricProvenance;
}

// ---------------------------------------------------------------------------
// Analytics outputs
// ---------------------------------------------------------------------------

export interface AttentionItem {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly domain: RiskDomain;
  readonly title: string;
  /** Review-priority tier derived from the additive attention score; never source risk severity. */
  readonly priority: Severity;
  readonly score: number;
  /** Every contributing term, so the ranking is never a black box. */
  readonly reasons: readonly AttentionReason[];
  readonly ageDays: number | null;
  /** Null when no prior observation exists; no fallback direction may be scored. */
  readonly momentum: MomentumDirection | null;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly assigneeId: string | null;
  readonly evidence: readonly EvidenceRef[];
  readonly recommendations: readonly Recommendation[];
  readonly provenance: MetricProvenance;
}

/** One term in the attention score, with the points it contributed. */
export interface AttentionReason {
  readonly code: string;
  readonly label: string;
  readonly points: number;
  readonly detail: string;
}

export interface Recommendation {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Deterministic rules are the default; AI is opt-in and labelled. */
  readonly origin: "deterministic-rule" | "ai-suggested";
  readonly ruleId?: string;
  readonly confidence?: "high" | "medium" | "low";
  readonly citedEvidence: readonly EvidenceRef[];
}

export interface ConcentrationBucket {
  readonly dimension: ConcentrationDimension;
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly shareOfTotal: number;
  readonly projectsAffected: number;
  readonly evidence: readonly EvidenceRef[];
  readonly provenance: MetricProvenance;
}

export type ConcentrationDimension =
  | "company"
  | "trade"
  | "discipline"
  | "root-cause"
  | "iq-root-cause"
  | "building-component"
  | "location"
  | "issue-type"
  | "project-type"
  | "project-phase"
  | "business-unit";

export interface RecurrenceGroup {
  readonly id: string;
  readonly signature: string;
  readonly label: string;
  readonly dimension: ConcentrationDimension;
  readonly occurrences: number;
  readonly projectsAffected: readonly string[];
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** Recurrence is not volume: this is repeats / total relevant events. */
  readonly recurrenceRate: number;
  readonly evidence: readonly EvidenceRef[];
  readonly provenance: MetricProvenance;
}

export interface BurnRate {
  readonly scopeId: string;
  readonly domain: RiskDomain | "all";
  readonly periodDays: number;
  readonly created: number;
  readonly resolved: number;
  readonly net: number;
  readonly backlog: number;
  readonly creationRatePerWeek: number;
  readonly resolutionRatePerWeek: number;
  /** resolved / created; < 1 means the backlog is growing. */
  readonly burnRatio: number | null;
  readonly provenance: MetricProvenance;
}

export interface Hotspot {
  readonly locationId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly path: string;
  readonly domains: readonly RiskDomain[];
  readonly domainCounts: Readonly<Partial<Record<RiskDomain, number>>>;
  readonly totalHighRisk: number;
  /** Multi-domain overlap is what makes a hotspot, not raw count. */
  readonly overlapScore: number;
  readonly evidence: readonly EvidenceRef[];
  readonly provenance: MetricProvenance;
}

export interface SnapshotRow {
  readonly snapshotDate: string;
  readonly scope: "hub" | "project" | "company";
  readonly scopeId: string;
  readonly domain: RiskDomain | "all";
  readonly metricId: string;
  readonly value: number;
  readonly valueKind: ValueKind;
}

// ---------------------------------------------------------------------------
// Ingestion bookkeeping
// ---------------------------------------------------------------------------

export interface IngestionJob {
  readonly id: string;
  readonly source: SourceSystem;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly projectId: string | null;
  readonly rowsProcessed: number;
  readonly failures: number;
  readonly warnings: readonly string[];
  /** Autodesk's own extraction timestamp, distinct from when we ingested. */
  readonly sourceExtractedAt: string | null;
  readonly status: "running" | "complete" | "failed" | "partial";
}

/**
 * A column we saw in an Autodesk extract and what we did with it. Malformed or
 * unrecognised Autodesk data is recorded here and surfaced, never dropped
 * silently.
 */
export interface ColumnReportRow {
  readonly table: string;
  readonly column: string;
  readonly mappedTo: string | null;
  readonly nonNullRows: number;
  readonly note: string | null;
}
