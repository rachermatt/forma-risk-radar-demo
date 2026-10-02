import {
  RISK_DOMAIN_LABEL,
  recordIdentityKey,
  type AttentionItem,
  type AttentionReason,
  type BurnRate,
  type BusinessUnit,
  type Company,
  type ConcentrationBucket,
  type ConcentrationDimension,
  type EvidenceRef,
  type Hotspot,
  type LocationNode,
  type MomentumDirection,
  type Project,
  type Recommendation,
  type RecurrenceGroup,
  type RiskDomain,
  type RiskRecord,
  type RiskRelationship,
  type Severity,
  type SourceSystem,
} from "../canonical/types";
import { ATTENTION_POINTS } from "./definitions";
import { ageDays, calculateBurnRate } from "./metrics";
import { derivedProvenance } from "./provenance";
import { selectCanonicalRelationships, selectRelationshipVersions } from "./relationship-conversion-evidence";

export interface AttentionContext {
  projectName: string;
  companyName?: string | null;
  asOf: string;
  projectMomentum: MomentumDirection | null;
  recurring?: boolean;
  hotspot?: boolean;
  safetyCategory?: string | null;
  safetyHazard?: boolean;
  negativeSafetyObservation?: boolean;
  rfiPriority?: string | null;
  rfiScoreBand?: 0 | 1 | 2 | null;
  submittalRequiredOnJobAt?: string | null;
  submittalLeadTimeDays?: number | null;
  submittalRevision?: number | null;
  stale?: boolean;
  clashLinked?: boolean;
  scheduleLinked?: boolean;
  criticalPathLinked?: boolean;
  scheduleSupportingEdgeCount?: number;
  costLinked?: boolean;
  rfiLinked?: boolean;
  userCreatedEdge?: boolean;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  none: 0,
  unmapped: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const PORTFOLIO_RECORD_INDICATOR_LABELS = Object.freeze({
  highCiqIssues: "Open issues Construction IQ rates High",
  highCiqRfis: "Open RFIs Construction IQ rates High",
  classifiedCiqIssues: "Open issues with CIQ classification",
  safetySignalIssues: "Open issues with safety signals",
  recordedWaterCauseIssues: "Open issues · recorded cause: Water Intrusion",
} as const);

export function isOpenHighCiqIssue(record: RiskRecord): boolean {
  return record.open && record.kind === "issue" && record.constructionIqRisk === "high";
}

export function isOpenHighCiqRfi(record: RiskRecord): boolean {
  return record.open && record.kind === "rfi" && record.constructionIqRisk === "high";
}

/** Construction IQ record-level risk is defined only for Issues and RFIs. */
export function isConstructionIqRiskApplicable(record: Pick<RiskRecord, "kind">): boolean {
  return record.kind === "issue" || record.kind === "rfi";
}

export function isOpenCiqClassifiedIssue(record: RiskRecord): boolean {
  return record.open && record.kind === "issue" &&
    ["low", "medium", "high"].includes(record.constructionIqRisk);
}

/** Supported issue-level safety sidecars; this is not an Autodesk safety score. */
export function hasSupportedSafetySignal(record: RiskRecord): boolean {
  if (record.kind !== "issue") return false;
  const riskCategory = record.iqSafetyRiskCategory?.trim() || null;
  const hazardCategory = record.iqSafetyHazardCategory?.trim() || null;
  const observationCategory = record.iqSafetyObservationCategory?.trim().toLowerCase() || null;
  return (riskCategory !== null && riskCategory !== "unmapped") ||
    hazardCategory !== null || observationCategory === "negative";
}

export function isOpenSafetySignalIssue(record: RiskRecord): boolean {
  return record.open && record.kind === "issue" && hasSupportedSafetySignal(record);
}

export function isOpenIssueWithRecordedCause(record: RiskRecord, cause: string): boolean {
  return record.open && record.kind === "issue" &&
    record.rootCause?.trim().toLocaleLowerCase("en-US") === cause.trim().toLocaleLowerCase("en-US");
}

function reason(code: string, label: string, points: number, detail: string): AttentionReason {
  return { code, label, points, detail };
}

function recommendationsFor(record: RiskRecord, reasons: readonly AttentionReason[]): readonly Recommendation[] {
  const evidence: EvidenceRef[] = [{
    kind: record.kind,
    id: record.id,
    projectId: record.projectId,
    label: record.displayId ?? record.title,
    ...(record.href ? { href: record.href } : {}),
  }];
  const output: Recommendation[] = [];
  const has = (code: string) => reasons.some((entry) => entry.code === code);
  if (has("UNASSIGNED") || has("NO_DUE_DATE") || has("OVERDUE")) {
    output.push({
      id: `ownership-${record.projectId}-${record.kind}-${record.id}`,
      title: "Confirm ownership and a recovery date",
      detail: "Validate a named owner, agree the next decision date, and review any blocking dependencies.",
      origin: "deterministic-rule",
      ruleId: "mitigation.ownership-overdue.v1",
      citedEvidence: evidence,
    });
  }
  if (isOpenIssueWithRecordedCause(record, "Water Intrusion")) {
    output.push({
      id: `water-${record.projectId}-${record.kind}-${record.id}`,
      title: "Inspect the adjacent envelope areas",
      detail: "Verify containment, inspect connected locations, and confirm corrective-action ownership before follow-on work.",
      origin: "deterministic-rule",
      ruleId: "mitigation.water-risk.v1",
      citedEvidence: evidence,
    });
  }
  if (has("RECURRING_SIGNATURE")) {
    output.push({
      id: `recurrence-${record.projectId}-${record.kind}-${record.id}`,
      title: "Review the prior corrective action",
      detail: "Compare the repeated records and check whether prior actions addressed the shared signature; the grouping itself does not establish causality.",
      origin: "deterministic-rule",
      ruleId: "mitigation.recurrence.v1",
      citedEvidence: evidence,
    });
  }
  if (output.length === 0) {
    output.push({
      id: `review-${record.projectId}-${record.kind}-${record.id}`,
      title: "Review the contributing evidence",
      detail: "Confirm the current condition with the project team and record the next action in Autodesk Forma.",
      origin: "deterministic-rule",
      ruleId: "mitigation.review.v1",
      citedEvidence: evidence,
    });
  }
  return output;
}

export function calculateAttentionItem(record: RiskRecord, context: AttentionContext): AttentionItem & { rawScore: number } {
  const reasons: AttentionReason[] = [];
  const operationalActionKind = record.kind === "issue" || record.kind === "rfi" || record.kind === "submittal";
  const age = record.open ? ageDays(record.createdAt, context.asOf) : null;
  const dueAt = record.dueDate ? new Date(record.dueDate).getTime() : null;
  const overdue = operationalActionKind && record.open && dueAt !== null && dueAt < new Date(context.asOf).getTime();
  const add = (code: keyof typeof ATTENTION_POINTS, label: string, detail: string, points: number = ATTENTION_POINTS[code]) => {
    reasons.push(reason(code, label, points, detail));
  };

  if (record.kind === "issue" && record.constructionIqRisk === "high") add("CIQ_QUALITY_HIGH", "Construction IQ rated High", "The synthetic Autodesk-shaped Construction IQ field classifies this issue as High quality risk.");
  if (record.kind === "issue" && record.constructionIqRisk === "medium") add("CIQ_QUALITY_MEDIUM", "Construction IQ rated Medium", "The synthetic Autodesk-shaped Construction IQ field classifies this issue as Medium quality risk.");
  if (record.kind === "rfi" && record.constructionIqRisk === "high") add("CIQ_RFI_HIGH", "Construction IQ rated High", "The synthetic Autodesk-shaped Construction IQ field classifies this RFI as High risk.");
  if (record.kind === "rfi" && context.rfiScoreBand === 2) reasons.push(reason("CIQ_RFI_SCORE_BAND", "RFI risk band 2", 6, "The documented companion score is rendered as an ordinal band, not a percentage."));
  if (record.kind === "rfi" && context.rfiScoreBand === 1) reasons.push(reason("CIQ_RFI_SCORE_BAND", "RFI risk band 1", 3, "The documented companion score is rendered as an ordinal band, not a percentage."));
  if (record.kind === "issue" && record.iqCostImpact === "high") add("CIQ_COST_IMPACT_HIGH", "High categorical cost impact", "The synthetic Autodesk-shaped field supplies a High categorical impact classification; no monetary amount is implied.");
  if (record.kind === "issue" && record.iqCostImpact === "medium") add("CIQ_COST_IMPACT_MEDIUM", "Medium categorical cost impact", "The synthetic Autodesk-shaped field supplies a Medium categorical impact classification; no monetary amount is implied.");
  if (context.safetyCategory && context.safetyCategory !== "other") add("SAFETY_RISK_CATEGORISED", "Categorised safety signal", `The synthetic Autodesk-shaped field classifies the safety signal as ${context.safetyCategory.replaceAll("_", " ")}.`);
  if (context.safetyCategory === "other") add("SAFETY_RISK_OTHER", "Uncategorised safety signal", "The synthetic Autodesk-shaped field supplies a safety signal in the broad other category.");
  if (context.safetyHazard) add("SAFETY_HAZARD_PRESENT", "Safety hazard present", "A synthetic Autodesk-shaped Construction IQ safety-hazard sidecar is present.");
  if (context.negativeSafetyObservation) add("SAFETY_OBSERVATION_NEGATIVE", "Negative safety observation", "The synthetic Autodesk-shaped field classifies this as a negative safety observation.");
  if (overdue) {
    const approximate = record.kind === "submittal";
    add(
      "OVERDUE",
      approximate ? "Approximate past due" : "Past due",
      `${approximate ? "Approximate: the submittal state-aware due-date mapping is pending validation. " : ""}The mapped due date passed ${Math.max(1, ageDays(record.dueDate!, context.asOf))} days ago.`,
    );
    const overdueAge = Math.min(10, Math.floor(ageDays(record.dueDate!, context.asOf) / 7));
    if (overdueAge > 0) reasons.push(reason("OVERDUE_AGE", "Overdue duration", overdueAge, `${overdueAge} point${overdueAge === 1 ? "" : "s"} for completed weeks past due.`));
  }
  if (age !== null) {
    const openAgePoints = Math.min(8, Math.floor(age / 14));
    if (openAgePoints > 0) reasons.push(reason("OPEN_AGE", "Open age", openAgePoints, `Open for ${age} days; this is age since creation, not time in status.`));
  }
  if (operationalActionKind && (!record.assigneeId || !record.assigneeType)) add("UNASSIGNED", "No named owner", "No assignee is present on the synthetic source-shaped record; this does not establish that the item is being ignored.");
  if (operationalActionKind && record.open && !record.dueDate) add("NO_DUE_DATE", "No due date", "The open record has no due date recorded.");
  if (operationalActionKind && context.stale) add("STALE", "No recent update", "The last recorded update is more than 30 days old.");
  if (record.kind === "rfi" && record.costImpact === "yes") add("RFI_COST_IMPACT_YES", "Cost impact flagged Yes", "The synthetic Autodesk-shaped RFI cost-impact field is Yes; no monetary amount is available.");
  if (record.kind === "rfi" && record.costImpact === "unknown") add("RFI_COST_IMPACT_UNKNOWN", "Cost impact unknown", "The RFI cost-impact flag remains Unknown.");
  if (record.kind === "rfi" && record.scheduleImpact === "yes") add("RFI_SCHEDULE_IMPACT_YES", "Schedule impact flagged Yes", "The synthetic Autodesk-shaped RFI schedule-impact field is Yes.");
  if (record.kind === "rfi" && record.scheduleImpact === "unknown") add("RFI_SCHEDULE_IMPACT_UNKNOWN", "Schedule impact unknown", "The RFI schedule-impact flag remains Unknown.");
  if (record.kind === "rfi" && context.rfiPriority?.toLowerCase() === "high") add("RFI_PRIORITY_HIGH", "High RFI priority", "The source RFI priority is High.");
  if (record.kind === "submittal" && record.open && context.submittalRequiredOnJobAt && context.submittalLeadTimeDays !== null && context.submittalLeadTimeDays !== undefined) {
    const procurementNeed = new Date(context.submittalRequiredOnJobAt).getTime() - context.submittalLeadTimeDays * 86_400_000;
    if (Number.isFinite(procurementNeed) && procurementNeed < new Date(context.asOf).getTime()) {
      add("SUBMITTAL_PROCUREMENT_BREACH", "Procurement need date passed", "Required-on-job date minus lead time is before this snapshot. Lead time is provisionally interpreted as days and must be validated during live onboarding.");
    }
  }
  if (record.kind === "submittal" && context.submittalRevision !== null && context.submittalRevision !== undefined && context.submittalRevision > 1) {
    const points = Math.min(12, Math.floor(context.submittalRevision - 1) * ATTENTION_POINTS.SUBMITTAL_RESUBMISSION);
    add("SUBMITTAL_RESUBMISSION", "Repeated submittal revision", `Revision ${context.submittalRevision} adds ${points} points, capped at 12.`, points);
  }
  if (context.clashLinked) add("CLASH_LINKED", "Linked to coordination evidence", "A confirmed synthetic clash-group to issue bridge is present.");
  if (context.scheduleLinked) add("SCHEDULE_LINKED", "Linked to schedule activity", "A confirmed synthetic relationship edge reaches a schedule activity; causality is not asserted.");
  if (context.criticalPathLinked) add("CRITICAL_PATH_LINKED", "Critical-path activity linked", `A confirmed synthetic edge reaches an activity whose source-shaped schedule-file field is marked critical. ${context.scheduleSupportingEdgeCount ?? 0} confirmed risk-to-activity ${context.scheduleSupportingEdgeCount === 1 ? "edge supports" : "edges support"} this project-level schedule signal.`);
  if (context.costLinked) add("COST_EDGE", "Linked to a cost record", "A confirmed relationship edge reaches a cost entity; no causal or monetary attribution is asserted.");
  if (context.rfiLinked) add("RFI_EDGE", "Issue and RFI linked", "A confirmed relationship edge connects the records; direction is not asserted.");
  if (context.userCreatedEdge && (context.scheduleLinked || context.costLinked || context.rfiLinked)) add("USER_CREATED_EDGE_BONUS", "Human-created relationship", "A person deliberately created at least one supporting relationship edge.");
  if (context.hotspot) add("HOTSPOT_MEMBER", "Multi-domain hotspot", "The location is in the top decile of overlap within its project.");
  if (context.recurring) add("RECURRING_SIGNATURE", "Recurring signature", "At least three similar records occurred during the configured recurrence window.");
  if (context.projectMomentum === "increasing" || context.projectMomentum === "accelerating") add("PROJECT_MOMENTUM_WORSENING", "Project momentum worsening", `The project risk trend is ${context.projectMomentum}.`);
  if (record.riskUserOverridden && SEVERITY_RANK[record.constructionIqRisk] < SEVERITY_RANK[record.constructionIqModelRisk]) {
    add("CIQ_USER_OVERRIDE_DOWNGRADE", "Human override lowered risk", "A human override lowered the model classification and is given precedence.");
  }

  const rawScore = reasons.reduce((sum, entry) => sum + entry.points, 0);
  const score = Math.min(100, Math.max(0, rawScore));
  const evidence: EvidenceRef[] = [{
    kind: record.kind,
    id: record.id,
    projectId: record.projectId,
    label: record.displayId ?? record.title,
    ...(record.href ? { href: record.href } : {}),
  }];
  return {
    id: `attention-${record.projectId}-${record.kind}-${record.id}`,
    projectId: record.projectId,
    projectName: context.projectName,
    domain: record.domain,
    title: record.title,
    priority: score >= 75 ? "critical" : score >= 55 ? "high" : score >= 30 ? "medium" : "low",
    score,
    rawScore,
    reasons,
    ageDays: age,
    momentum: context.projectMomentum,
    companyId: record.companyId,
    companyName: context.companyName ?? null,
    assigneeId: record.assigneeId,
    evidence,
    recommendations: recommendationsFor(record, reasons),
    provenance: derivedProvenance({
      sourceSystem: "demo-generator",
      sourceDataset: "demo-risk-records",
      sourceRecordId: record.id,
      projectId: record.projectId,
      timestamp: context.asOf,
      definitionId: "attention.score",
    }),
  };
}

export function actionabilityIndex(records: readonly RiskRecord[], asOf: string): number | null {
  const population = records.filter((record) =>
    record.open && isConstructionIqRiskApplicable(record) && ["high", "medium"].includes(record.constructionIqRisk)
  );
  if (!population.length) return null;
  const unassigned = population.filter((record) => !record.assigneeId || !record.assigneeType).length / population.length;
  const noDueDate = population.filter((record) => !record.dueDate).length / population.length;
  const stale = population.filter((record) => {
    const stamp = record.updatedAt ?? record.createdAt;
    return ageDays(stamp, asOf) > 30;
  }).length / population.length;
  return Math.round(1000 * (0.5 * unassigned + 0.3 * noDueDate + 0.2 * stale)) / 10;
}

export const RECORDED_ROOT_CAUSE_NORMALIZATION_VERSION = "1.0.0";

export type RecurrenceDimension = "root-cause" | "iq-root-cause" | "location" | "company" | "building-component";

export const RECURRENCE_DIMENSIONS: readonly RecurrenceDimension[] = [
  "root-cause",
  "iq-root-cause",
  "location",
  "company",
  "building-component",
];

const RECORDED_ROOT_CAUSE_ALIASES: Readonly<Record<string, string>> = {
  "water ingress": "water intrusion",
  "documentation incomplete": "incomplete documentation",
};

function normalizedSimilarityValue(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/&/gu, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  return normalized || null;
}

/**
 * Versioned cross-project dictionary for project-configured issue causes.
 * Autodesk root-cause ids are only stable inside one project.
 */
export function recordedRootCauseNormalizedKey(value: string | null): string | null {
  const normalized = normalizedSimilarityValue(value);
  if (!normalized) return null;
  return RECORDED_ROOT_CAUSE_ALIASES[normalized] ?? normalized;
}

function normalizedRootCauseLabel(key: string): string {
  return key.split(" ").map((part) => part ? part[0]!.toLocaleUpperCase("en-US") + part.slice(1) : part).join(" ");
}

/** A URL- and analytics-stable key that never merges operational and CIQ disciplines. */
export function disciplineIdentityKey(record: Pick<RiskRecord, "discipline" | "disciplineOrigin">): string | null {
  const discipline = normalizedSimilarityValue(record.discipline);
  if (!discipline) return null;
  return `${record.disciplineOrigin ?? "unmapped"}\u001f${discipline}`;
}

export function disciplineIdentityLabel(record: Pick<RiskRecord, "discipline" | "disciplineOrigin">): string | null {
  if (!record.discipline) return null;
  const origin = record.disciplineOrigin === "construction-iq"
    ? "CIQ predicted"
    : record.disciplineOrigin === "operational"
      ? "Operational / project-configured"
      : "Source unmapped";
  return `${record.discipline} · ${origin}`;
}

/**
 * Exact configured recurrence identity. Recorded issue causes use their
 * project-scoped Autodesk id in a single-project scope and the versioned
 * normalisation dictionary only when the scope spans projects.
 */
export function recurrenceSignatureFor(
  record: RiskRecord,
  dimension: RecurrenceDimension,
  crossProject: boolean,
): string | null {
  if (dimension === "root-cause") {
    if (!record.rootCauseId || !record.rootCause) return null;
    if (!crossProject) return `project-root\u001f${record.projectId}\u001f${record.rootCauseId}`;
    const normalized = recordedRootCauseNormalizedKey(record.rootCause);
    return normalized ? `normalized-root\u001f${RECORDED_ROOT_CAUSE_NORMALIZATION_VERSION}\u001f${normalized}` : null;
  }
  if (dimension === "iq-root-cause") {
    const normalized = normalizedSimilarityValue(record.iqRootCause);
    return normalized ? `iq-root\u001f${normalized}` : null;
  }
  if (dimension === "location") return record.locationId
    ? `location\u001f${record.projectId}\u001f${record.locationId}`
    : null;
  if (dimension === "company") return record.companyId;
  const normalized = normalizedSimilarityValue(record.buildingComponent);
  return normalized ? `component\u001f${normalized}` : null;
}

export interface RecurrencePopulationStats {
  readonly relevantEvents: number;
  readonly distinctSignatures: number;
  readonly excludedEvents: number;
  readonly crossProject: boolean;
}

export function recurrencePopulationStats(
  records: readonly RiskRecord[],
  dimension: RecurrenceDimension,
  asOf: string,
  windowDays = 180,
): RecurrencePopulationStats {
  const asOfTime = new Date(asOf).getTime();
  if (!Number.isFinite(asOfTime)) throw new RangeError("recurrencePopulationStats requires a valid asOf timestamp.");
  if (!Number.isFinite(windowDays) || windowDays <= 0) throw new RangeError("recurrencePopulationStats requires a positive windowDays value.");
  const windowStart = asOfTime - windowDays * 86_400_000;
  const windowRecords = records.filter((record) => {
    const createdAt = new Date(record.createdAt).getTime();
    return createdAt >= windowStart && createdAt <= asOfTime;
  });
  const crossProject = new Set(records.map((record) => record.projectId)).size > 1;
  const signatures = windowRecords
    .map((record) => recurrenceSignatureFor(record, dimension, crossProject))
    .filter((signature): signature is string => Boolean(signature));
  return {
    relevantEvents: signatures.length,
    distinctSignatures: new Set(signatures).size,
    excludedEvents: windowRecords.length - signatures.length,
    crossProject,
  };
}

export function concentration(
  records: readonly RiskRecord[],
  dimension: ConcentrationDimension,
  companies: readonly Company[],
  calculatedAt: string,
  sourceSystem: SourceSystem = "forma-risk-radar",
  context: {
    projects?: readonly Pick<Project, "id" | "hubId" | "type" | "currentPhase" | "businessUnitId">[];
    businessUnits?: readonly Pick<BusinessUnit, "id" | "hubId" | "name" | "path">[];
  } = {},
): readonly ConcentrationBucket[] {
  const eligibleRecords = concentrationEligibleRecords(records, dimension);
  const companyMap = new Map(companies.map((company) => [company.id, company]));
  const projectMap = new Map((context.projects ?? []).map((project) => [project.id, project]));
  const businessUnitMap = new Map((context.businessUnits ?? []).map((unit) => [`${unit.hubId}\u001f${unit.id}`, unit]));
  const crossProject = new Set(eligibleRecords.map((record) => record.projectId)).size > 1;
  const entries = eligibleRecords.map((record): { key: string; label: string; record: RiskRecord } => {
    if (dimension === "company") return record.companyId && companyMap.has(record.companyId)
      ? { key: record.companyId, label: companyMap.get(record.companyId)!.name, record }
      : { key: "unattributed", label: "Unattributed", record };
    if (dimension === "trade") {
      const trade = record.companyId ? companyMap.get(record.companyId)?.trade?.split("|")[0]?.trim() : null;
      return trade ? { key: trade.toLowerCase(), label: trade, record } : { key: "unattributed", label: "Unattributed / no trade recorded", record };
    }
    if (dimension === "discipline") {
      const key = disciplineIdentityKey(record);
      return key
        ? { key, label: disciplineIdentityLabel(record)!, record }
        : { key: "unattributed", label: "Unattributed", record };
    }
    if (dimension === "root-cause") {
      if (!record.rootCauseId || !record.rootCause) return { key: "unattributed", label: "Unattributed", record };
      if (!crossProject) return { key: `project-root\u001f${record.projectId}\u001f${record.rootCauseId}`, label: record.rootCause, record };
      const normalized = recordedRootCauseNormalizedKey(record.rootCause);
      return normalized
        ? { key: `normalized-root\u001f${RECORDED_ROOT_CAUSE_NORMALIZATION_VERSION}\u001f${normalized}`, label: normalizedRootCauseLabel(normalized), record }
        : { key: "unattributed", label: "Unattributed", record };
    }
    if (dimension === "iq-root-cause") {
      const normalized = normalizedSimilarityValue(record.iqRootCause);
      return normalized ? { key: `iq-root\u001f${normalized}`, label: record.iqRootCause!, record } : { key: "unattributed", label: "Unattributed", record };
    }
    if (dimension === "building-component") {
      const normalized = normalizedSimilarityValue(record.buildingComponent);
      return normalized ? { key: `component\u001f${normalized}`, label: record.buildingComponent!, record } : { key: "unattributed", label: "Unattributed", record };
    }
    if (dimension === "location") return record.locationId && record.locationPath
      ? { key: `${record.projectId}\u001f${record.locationId}`, label: record.locationPath, record }
      : { key: "unattributed", label: "Unattributed", record };
    if (dimension === "issue-type") return record.kind === "issue" && record.typeName
      ? { key: `${record.projectId}\u001f${record.typeName.toLocaleLowerCase("en-US")}`, label: record.typeName, record }
      : { key: "unattributed", label: record.kind === "issue" ? "Unattributed / no issue type" : "Not an Issue", record };
    const project = projectMap.get(record.projectId);
    if (dimension === "project-type") return project?.type
      ? { key: project.type.toLocaleLowerCase("en-US"), label: project.type, record }
      : { key: "unattributed", label: "Unattributed / no project type", record };
    if (dimension === "project-phase") return project?.currentPhase
      ? { key: project.currentPhase.toLocaleLowerCase("en-US"), label: project.currentPhase, record }
      : { key: "unattributed", label: "Unattributed / no current phase", record };
    if (dimension === "business-unit" && project?.businessUnitId) {
      const unit = businessUnitMap.get(`${project.hubId}\u001f${project.businessUnitId}`);
      return unit
        ? { key: unit.id, label: unit.path || unit.name, record }
        : { key: "unattributed", label: "Unattributed / unresolved business unit", record };
    }
    if (dimension === "business-unit") return { key: "unattributed", label: "Unattributed / no business unit", record };
    return { key: "unattributed", label: "Unattributed", record };
  });
  const counts = new Map<string, { label: string; records: RiskRecord[] }>();
  for (const entry of entries) {
    const bucket = counts.get(entry.key) ?? { label: entry.label, records: [] };
    bucket.records.push(entry.record);
    counts.set(entry.key, bucket);
  }
  const attributableTotal = entries.filter((entry) => entry.key !== "unattributed").length;
  return [...counts.entries()].map(([key, bucket]) => ({
    dimension,
    key,
    label: bucket.label,
    count: bucket.records.length,
    shareOfTotal: key === "unattributed" || attributableTotal === 0 ? 0 : bucket.records.length / attributableTotal,
    projectsAffected: new Set(bucket.records.map((record) => record.projectId)).size,
    evidence: bucket.records.map((record) => ({ kind: record.kind, id: record.id, projectId: record.projectId, label: record.displayId ?? record.title })),
    provenance: derivedProvenance({ sourceSystem, sourceDataset: "canonical-risk-records", timestamp: calculatedAt, definitionId: `concentration.${dimension}` }),
  })).sort((a, b) => {
    if (a.key === "unattributed") return 1;
    if (b.key === "unattributed") return -1;
    return b.count - a.count || a.label.localeCompare(b.label);
  });
}

export function concentrationEligibleRecords(
  records: readonly RiskRecord[],
  dimension: ConcentrationDimension,
): readonly RiskRecord[] {
  if (dimension === "issue-type" || dimension === "root-cause") return records.filter((record) => record.kind === "issue");
  if (dimension === "iq-root-cause" || dimension === "discipline" || dimension === "building-component") {
    return records.filter((record) => record.kind === "issue" || record.kind === "rfi");
  }
  return records;
}

export function recurrenceGroups(
  records: readonly RiskRecord[],
  dimension: RecurrenceDimension,
  asOf: string,
  windowDays = 180,
  sourceSystem: SourceSystem = "forma-risk-radar",
): readonly RecurrenceGroup[] {
  const asOfTime = new Date(asOf).getTime();
  if (!Number.isFinite(asOfTime)) throw new RangeError("recurrenceGroups requires a valid asOf timestamp.");
  if (!Number.isFinite(windowDays) || windowDays <= 0) throw new RangeError("recurrenceGroups requires a positive windowDays value.");
  const windowStart = asOfTime - windowDays * 86_400_000;
  const crossProject = new Set(records.map((record) => record.projectId)).size > 1;
  const relevant = records
    .filter((record) => {
      const createdAt = new Date(record.createdAt).getTime();
      return createdAt >= windowStart && createdAt <= asOfTime;
    })
    .map((record) => ({ record, signature: recurrenceSignatureFor(record, dimension, crossProject) }))
    .filter((item): item is { record: RiskRecord; signature: string } => Boolean(item.signature));
  const groups = new Map<string, RiskRecord[]>();
  for (const item of relevant) groups.set(item.signature, [...(groups.get(item.signature) ?? []), item.record]);
  return [...groups.entries()].filter(([, items]) => items.length >= 2).map(([signature, items]) => {
    const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      id: `recurrence-${dimension}-${encodeURIComponent(signature)}`,
      signature,
      label: dimension === "location"
        ? items[0]!.locationPath ?? "Unknown location"
        : dimension === "root-cause"
          ? items[0]!.rootCause ?? "Unknown recorded cause"
          : dimension === "iq-root-cause"
            ? items[0]!.iqRootCause ?? "Unknown CIQ-predicted cause"
            : dimension === "building-component"
              ? items[0]!.buildingComponent ?? "Unknown component"
              : signature,
      dimension: dimension as ConcentrationDimension,
      occurrences: items.length,
      projectsAffected: [...new Set(items.map((item) => item.projectId))],
      firstSeen: sorted[0]!.createdAt,
      lastSeen: sorted.at(-1)!.createdAt,
      recurrenceRate: relevant.length ? (items.length - 1) / relevant.length : 0,
      evidence: items.map((item) => ({ kind: item.kind, id: item.id, projectId: item.projectId, label: item.displayId ?? item.title })),
      provenance: derivedProvenance({ sourceSystem, sourceDataset: "canonical-risk-records", timestamp: asOf, definitionId: `recurrence.${dimension}` }),
    };
  }).sort((a, b) => b.occurrences - a.occurrences);
}

/** Recomputes every supported recurrence dimension from the supplied record scope. */
export function recurrenceGroupsAcrossDimensions(
  records: readonly RiskRecord[],
  asOf: string,
  windowDays = 180,
  sourceSystem: SourceSystem = "forma-risk-radar",
): readonly RecurrenceGroup[] {
  return RECURRENCE_DIMENSIONS.flatMap((dimension) =>
    recurrenceGroups(records, dimension, asOf, windowDays, sourceSystem)
  );
}

/** Exact population for the catalogued 90-day attention recurrence term. */
export function attentionRecurringRecordKeys(
  records: readonly RiskRecord[],
  asOf: string,
  sourceSystem: SourceSystem = "forma-risk-radar",
): ReadonlySet<string> {
  return new Set(
    recurrenceGroupsAcrossDimensions(records, asOf, 90, sourceSystem)
      .filter((group) => group.occurrences >= 3)
      .flatMap((group) => group.evidence.map(recordIdentityKey)),
  );
}

/** Human-readable queue summary for the source-supported impact categories. */
export function attentionExposureSummary(record: RiskRecord): string {
  const signals: string[] = [];
  if (
    (record.kind === "rfi" && record.costImpact === "yes") ||
    (record.kind === "issue" && record.iqCostImpact === "high")
  ) {
    signals.push("Cost confirmed");
  } else if (
    (record.kind === "rfi" && record.costImpact === "unknown") ||
    (record.kind === "issue" && record.iqCostImpact === "medium")
  ) {
    signals.push("Cost potential");
  }
  if (record.kind === "rfi" && record.scheduleImpact === "yes") signals.push("Schedule Yes");
  else if (record.kind === "rfi" && record.scheduleImpact === "unknown") signals.push("Schedule potential");
  return signals.join(" · ") || "No direct impact flag";
}

export function burnRateFromRecords(
  records: readonly RiskRecord[],
  asOf: string,
  periodDays = 28,
  domain: RiskDomain | "all" = "all",
  scopeId = "hub",
  sourceSystem: SourceSystem = "forma-risk-radar",
): BurnRate {
  const { from, throughExclusive } = burnWindowBounds(asOf, periodDays);
  const selected = burnEligibleRecords(records, domain);
  const inWindow = (value: string | null): boolean => {
    if (!value) return false;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) && timestamp >= from && timestamp < throughExclusive;
  };
  const created = selected.filter((record) => inWindow(record.createdAt)).length;
  const resolved = selected.filter((record) => inWindow(burnResolvedAt(record))).length;
  const backlog = selected.filter((record) => {
    const createdAt = new Date(record.createdAt).getTime();
    if (!Number.isFinite(createdAt) || createdAt >= throughExclusive) return false;
    const resolvedAt = burnResolvedAt(record);
    if (!resolvedAt) return record.open;
    const resolvedTimestamp = new Date(resolvedAt).getTime();
    return Number.isFinite(resolvedTimestamp) && resolvedTimestamp >= throughExclusive;
  }).length;
  return {
    ...calculateBurnRate(scopeId, domain, periodDays, created, resolved, backlog),
    provenance: derivedProvenance({ sourceSystem, sourceDataset: "canonical-risk-records", timestamp: asOf, definitionId: "burn.rate" }),
  };
}

const BURN_RECORD_KINDS = new Set<RiskRecord["kind"]>([
  "issue",
  "rfi",
  "submittal",
  "clash-group",
  "form",
]);

export function burnEligibleRecords(
  records: readonly RiskRecord[],
  domain: RiskDomain | "all" = "all",
): readonly RiskRecord[] {
  return records.filter((record) =>
    BURN_RECORD_KINDS.has(record.kind) && (domain === "all" || record.domain === domain)
  );
}

export function burnResolvedAt(record: RiskRecord): string | null {
  const normalizedStatus = record.status.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (normalizedStatus === "draft" || normalizedStatus === "void") return null;
  return record.kind === "submittal" || record.kind === "form" ? record.respondedAt : record.closedAt;
}

export function burnGrowthRecommendation(
  records: readonly RiskRecord[],
  asOf: string,
  periodDays: number,
  scopeId = "hub",
): Recommendation | null {
  const burn = burnRateFromRecords(records, asOf, periodDays, "all", scopeId);
  if (burn.net <= 0) return null;
  const { from, throughExclusive } = burnWindowBounds(asOf, periodDays);
  const inWindow = (value: string | null): boolean => {
    if (!value) return false;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) && timestamp >= from && timestamp < throughExclusive;
  };
  const cited = new Map<string, EvidenceRef>();
  for (const record of burnEligibleRecords(records)) {
    if (!inWindow(record.createdAt) && !inWindow(burnResolvedAt(record))) continue;
    cited.set(recordIdentityKey(record), {
      kind: record.kind,
      id: record.id,
      projectId: record.projectId,
      label: record.displayId ?? record.title,
      ...(record.href ? { href: record.href } : {}),
    });
  }
  return {
    id: `burn-growth-${scopeId}-${asOf.slice(0, 10)}-${periodDays}`,
    title: "Set a short-term backlog recovery target",
    detail: `${burn.created} eligible records were created and ${burn.resolved} resolved in this period (net +${burn.net}). Review the highest-growth category, verify ownership, and prioritize aged or exposed items.`,
    origin: "deterministic-rule",
    ruleId: "mitigation.burn-growth.v1",
    citedEvidence: [...cited.values()],
  };
}

export function burnWindowBounds(asOf: string, periodDays: number): { from: number; throughExclusive: number } {
  if (!Number.isInteger(periodDays) || periodDays <= 0) throw new RangeError("Burn period must be a positive integer number of days.");
  const asOfDay = new Date(asOf);
  if (!Number.isFinite(asOfDay.getTime())) throw new RangeError("Burn calculation requires a valid as-of timestamp.");
  asOfDay.setUTCHours(0, 0, 0, 0);
  const throughExclusive = asOfDay.getTime() + 86_400_000;
  return { from: throughExclusive - periodDays * 86_400_000, throughExclusive };
}

export interface ScheduleExposureAnalytics {
  /** Open records with an effective Autodesk High or Medium classification. */
  eligibleRiskRecords: readonly RiskRecord[];
  /** Distinct eligible records with at least one confirmed schedule edge. */
  scheduleLinkedRiskRecords: readonly RiskRecord[];
  /** Distinct eligible records linked to at least one critical-path activity. */
  criticalPathLinkedRiskRecords: readonly RiskRecord[];
  /** Raw confirmed edge volume, retained independently for the coverage gate. */
  confirmedScheduleEdgeCount: number;
}

/**
 * Resolve schedule exposure through canonical record identities. Multiple edges
 * may support one exposed risk, but they must never inflate the item counts.
 */
export function scheduleExposureFromRecords(
  records: readonly RiskRecord[],
  relationships: readonly RiskRelationship[],
): ScheduleExposureAnalytics {
  const recordsByIdentity = new Map(records.map((record) => [recordIdentityKey(record), record]));
  const eligibleRiskRecords = [...new Map(records
    .filter((record) =>
      record.kind !== "schedule-activity" &&
      record.open &&
      isConstructionIqRiskApplicable(record) &&
      (record.constructionIqRisk === "high" || record.constructionIqRisk === "medium")
    )
    .map((record) => [recordIdentityKey(record), record] as const)).values()];
  const eligibleByIdentity = new Map(eligibleRiskRecords.map((record) => [recordIdentityKey(record), record]));
  const confirmedScheduleEdges = selectRelationshipVersions(relationships, { includeNone: false }).filter((edge) =>
    edge.confidence === "confirmed" &&
    (edge.from.kind === "schedule-activity" || edge.to.kind === "schedule-activity")
  );
  const linkedRiskKeys = new Set<string>();
  const criticalPathLinkedRiskKeys = new Set<string>();

  for (const edge of confirmedScheduleEdges) {
    const endpoints = [edge.from, edge.to];
    const criticalPathLinked = endpoints
      .filter((endpoint) => endpoint.kind === "schedule-activity")
      .some((endpoint) => {
        const activity = recordsByIdentity.get(recordIdentityKey(endpoint));
        return activity?.kind === "schedule-activity" &&
          (activity.raw?.is_critical_path === true || activity.raw?.is_critical === true);
      });

    for (const endpoint of endpoints) {
      if (endpoint.kind === "schedule-activity") continue;
      const key = recordIdentityKey(endpoint);
      if (!eligibleByIdentity.has(key)) continue;
      linkedRiskKeys.add(key);
      if (criticalPathLinked) criticalPathLinkedRiskKeys.add(key);
    }
  }

  return {
    eligibleRiskRecords,
    scheduleLinkedRiskRecords: eligibleRiskRecords.filter((record) => linkedRiskKeys.has(recordIdentityKey(record))),
    criticalPathLinkedRiskRecords: eligibleRiskRecords.filter((record) => criticalPathLinkedRiskKeys.has(recordIdentityKey(record))),
    confirmedScheduleEdgeCount: confirmedScheduleEdges.length,
  };
}

export interface BurnHistoryBucket {
  startAt: string;
  endAt: string;
  created: number;
  resolved: number;
  provenance: import("../canonical/types").MetricProvenance;
}

/** Weekly display buckets over the exact same population and half-open window as the summary. */
export function burnHistoryFromRecords(
  records: readonly RiskRecord[],
  asOf: string,
  periodDays: number,
  domain: RiskDomain | "all" = "all",
  sourceSystem: SourceSystem = "forma-risk-radar",
): readonly BurnHistoryBucket[] {
  const day = 86_400_000;
  const { from, throughExclusive } = burnWindowBounds(asOf, periodDays);
  const population = burnEligibleRecords(records, domain);
  return Array.from({ length: Math.ceil(periodDays / 7) }, (_, index) => {
    const start = from + index * 7 * day;
    const end = Math.min(start + 7 * day, throughExclusive);
    const inBucket = (value: string | null): boolean => {
      if (!value) return false;
      const timestamp = new Date(value).getTime();
      return timestamp >= start && timestamp < end;
    };
    return {
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      created: population.filter((record) => inBucket(record.createdAt)).length,
      resolved: population.filter((record) => inBucket(burnResolvedAt(record))).length,
      provenance: derivedProvenance({ sourceSystem, sourceDataset: "canonical-risk-records", timestamp: asOf, definitionId: "burn.weekly-flow" }),
    };
  });
}

export function hotspots(
  records: readonly RiskRecord[],
  projectNames: ReadonlyMap<string, string>,
  calculatedAt: string,
  sourceSystem: SourceSystem = "forma-risk-radar",
  locationNodes: readonly LocationNode[] = [],
): readonly Hotspot[] {
  const identityKey = (projectId: string, locationId: string) => `${projectId}\u001f${locationId}`;
  const nodesByIdentity = new Map(
    locationNodes.map((node) => [identityKey(node.projectId, node.id), node] as const),
  );
  const grouped = new Map<string, {
    locationId: string;
    projectId: string;
    path: string;
    records: RiskRecord[];
  }>();
  const addRecord = (record: RiskRecord, locationId: string, path: string) => {
    const key = identityKey(record.projectId, locationId);
    const bucket = grouped.get(key) ?? {
      locationId,
      projectId: record.projectId,
      path,
      records: [],
    };
    bucket.records.push(record);
    grouped.set(key, bucket);
  };
  const population = records.filter((item) =>
    item.open && isConstructionIqRiskApplicable(item) &&
    ["high", "medium"].includes(item.constructionIqRisk) && item.locationId
  );
  for (const record of population) {
    let node = nodesByIdentity.get(identityKey(record.projectId, record.locationId!));
    if (!node) {
      const fallbackPath = record.locationPath?.trim();
      if (fallbackPath) addRecord(record, record.locationId!, fallbackPath);
      continue;
    }
    const visited = new Set<string>();
    while (node && !visited.has(identityKey(node.projectId, node.id))) {
      visited.add(identityKey(node.projectId, node.id));
      addRecord(record, node.id, node.path);
      node = node.parentId
        ? nodesByIdentity.get(identityKey(record.projectId, node.parentId))
        : undefined;
    }
  }
  const domainCount = Object.keys(RISK_DOMAIN_LABEL).length;
  return [...grouped.values()].map((bucket) => {
    const items = bucket.records;
    const domains = [...new Set(items.map((item) => item.domain))];
    const domainCounts = Object.fromEntries(domains.map((domain) => [domain, items.filter((item) => item.domain === domain).length]));
    const total = items.length;
    const breadth = domainCount > 1 ? (domains.length - 1) / (domainCount - 1) : 0;
    const diversity = total ? 1 - domains.reduce((sum, domain) => sum + ((domainCounts[domain] ?? 0) / total) ** 2, 0) : 0;
    const cappedVolume = Math.min(total, 20) / 20;
    const overlapScore = 100 * (0.5 * breadth + 0.3 * diversity + 0.2 * cappedVolume);
    return {
      locationId: bucket.locationId,
      projectId: bucket.projectId,
      projectName: projectNames.get(bucket.projectId) ?? "Unknown project",
      path: bucket.path,
      domains,
      domainCounts,
      totalHighRisk: total,
      overlapScore: Math.round(overlapScore * 10) / 10,
      evidence: items.map((item) => ({ kind: item.kind, id: item.id, projectId: item.projectId, label: item.displayId ?? item.title })),
      provenance: derivedProvenance({ sourceSystem, sourceDataset: "canonical-risk-records", projectId: bucket.projectId, timestamp: calculatedAt, definitionId: "hotspot.location-overlap" }),
    };
  }).sort((a, b) => b.overlapScore - a.overlapScore);
}

export function severityLabel(severity: Severity): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}
