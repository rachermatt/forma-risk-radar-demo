import {
  recordIdentityKey,
  RISK_DOMAINS,
  SEVERITY_ORDER,
  type AttentionItem,
  type Company,
  type MomentumDirection,
  type RiskDomain,
  type RiskRecord,
  type RiskRelationship,
  type Severity,
} from "../canonical/types";
import { disciplineIdentityKey, isConstructionIqRiskApplicable, RECURRENCE_DIMENSIONS, recurrenceGroups, recurrenceSignatureFor, scheduleExposureFromRecords } from "../risk/analytics";
import { costImpactCategoryForRecord, type CostImpactCategory } from "../risk/cost-impact-view";
import { selectAuthorizedRelationships } from "../risk/relationship-conversion-evidence";
import { RISK_CONFIGURATION_ID } from "../risk/definitions";
import type { DemoCompanyCiqSignal, DemoDataset, ProjectRiskSummary } from "./types";

export interface DashboardScopeFilters {
  hubId?: string | null;
  projectId?: string | null;
  businessUnitId?: string | null;
  projectType?: string | null;
  projectPhase?: string | null;
  domain?: RiskDomain | null;
  severity?: Severity | null;
  momentum?: MomentumDirection | null;
  companyId?: string | null;
  trade?: string | null;
  discipline?: string | null;
  location?: string | null;
  rootCause?: string | null;
  iqRootCause?: string | null;
  status?: string | null;
  persistence?: "persistent" | "non-persistent" | null;
  recurrence?: "recurring" | "non-recurring" | null;
  costExposure?: CostImpactCategory | null;
  scheduleExposure?: "flagged" | "potential" | "linked" | "explicit-negative" | "unavailable" | "unmapped" | null;
}

export interface ScopedDashboardData {
  projects: readonly ProjectRiskSummary[];
  records: readonly RiskRecord[];
  attention: readonly (AttentionItem & { rawScore: number })[];
  relationships: readonly RiskRelationship[];
  relationshipCoverage: {
    /** Edges discarded because at least one source record is not in the authorized population. */
    excludedDanglingCount: number;
    /** Authorized edges outside the active project/record filters. */
    excludedByScopeCount: number;
  };
  companyCiqSignals: readonly DemoCompanyCiqSignal[];
}

export interface DashboardQueryReader {
  get(name: string): string | null;
}

/** Parse URL filters against their declared or dataset-backed value sets. */
export function dashboardScopeFiltersFromQuery(
  data: Pick<DemoDataset, "hub" | "projects" | "companies" | "records">,
  query: DashboardQueryReader,
): DashboardScopeFilters {
  const selected = <T extends string>(name: string, values: readonly T[]): T | null => {
    const value = query.get(name);
    return value !== null && values.includes(value as T) ? value as T : null;
  };
  const projectIds = data.projects.map((summary) => summary.project.id);
  const businessUnits = data.projects.flatMap((summary) => summary.project.businessUnitId ? [summary.project.businessUnitId] : []);
  const projectTypes = data.projects.flatMap((summary) => summary.project.type ? [summary.project.type] : []);
  const projectPhases = data.projects.flatMap((summary) => summary.project.currentPhase ? [summary.project.currentPhase] : []);
  const companyIds = data.companies.map((company) => company.id);
  const trades = [UNATTRIBUTED_TRADE_FILTER, ...data.companies.flatMap((company) => company.trade ? [company.trade] : [])];
  const disciplines = data.records.flatMap((record) => {
    const key = disciplineIdentityKey(record);
    return key ? [key] : [];
  });
  const recordValues = (key: "locationPath" | "rootCause" | "iqRootCause" | "status") =>
    data.records.flatMap((record) => record[key] ? [record[key]!] : []);
  return {
    hubId: selected("hub", [data.hub.id]),
    projectId: selected("filterProject", projectIds),
    businessUnitId: selected("businessUnit", businessUnits),
    projectType: selected("projectType", projectTypes),
    projectPhase: selected("projectPhase", projectPhases),
    domain: selected("domain", RISK_DOMAINS),
    severity: selected("severity", SEVERITY_ORDER.filter((severity) => severity !== "critical")),
    momentum: selected("momentum", ["accelerating", "increasing", "stable", "improving"] as const),
    companyId: selected("company", companyIds),
    trade: selected("trade", trades),
    discipline: selected("discipline", disciplines),
    location: selected("location", recordValues("locationPath")),
    rootCause: selected("rootCause", recordValues("rootCause")),
    iqRootCause: selected("iqRootCause", recordValues("iqRootCause")),
    status: selected("status", recordValues("status")),
    persistence: selected("persistence", ["persistent", "non-persistent"] as const),
    recurrence: selected("recurrence", ["recurring", "non-recurring"] as const),
    costExposure: selected("costExposure", ["confirmed", "potential", "explicit-negative", "unclassified", "unmapped"] as const),
    scheduleExposure: selected("scheduleExposure", ["flagged", "potential", "linked", "explicit-negative", "unavailable", "unmapped"] as const),
  };
}

export function hasRecordLevelFilters(filters: DashboardScopeFilters): boolean {
  return Boolean(
    filters.severity || filters.companyId || filters.trade || filters.discipline || filters.location || filters.rootCause ||
    filters.iqRootCause || filters.status || filters.persistence || filters.recurrence || filters.costExposure || filters.scheduleExposure
  );
}

export const UNATTRIBUTED_TRADE_FILTER = "__unattributed__";

export function selectSignedMomentumMovers(
  projects: readonly ProjectRiskSummary[],
): { increase: ProjectRiskSummary | null; improvement: ProjectRiskSummary | null } {
  const withPrior = projects.filter((project) => project.momentum.value.change7d !== null);
  return {
    increase: [...withPrior]
      .filter((project) => project.momentum.value.change7d! > 0)
      .sort((left, right) => right.momentum.value.change7d! - left.momentum.value.change7d!)[0] ?? null,
    improvement: [...withPrior]
      .filter((project) => project.momentum.value.change7d! < 0)
      .sort((left, right) => left.momentum.value.change7d! - right.momentum.value.change7d!)[0] ?? null,
  };
}

export function companyIdsWithHighRiskSignals(
  records: readonly RiskRecord[],
  companySignals: readonly DemoCompanyCiqSignal[],
  visibleProjectIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const companyIds = new Set(records
    .filter((record) => record.open && record.companyId &&
      (record.kind === "issue" || record.kind === "rfi") &&
      (record.constructionIqRisk === "critical" || record.constructionIqRisk === "high"))
    .map((record) => record.companyId!));
  for (const signal of companySignals) {
    if (
      visibleProjectIds.has(signal.projectId) &&
      signal.quality?.dailyRisk.toLowerCase() === "high"
    ) companyIds.add(signal.companyId);
  }
  return companyIds;
}

function momentumDirection(change: number | null): MomentumDirection | null {
  if (change === null) return null;
  if (change >= 6) return "accelerating";
  if (change > 3) return "increasing";
  if (change < -3) return "improving";
  return "stable";
}

/**
 * Resolve the effective source risk classification. A human override is
 * already reflected on RiskRecord; attention priority is deliberately not a
 * severity because ownership and due-date factors must not rewrite risk.
 */
export function effectiveRecordSeverity(
  record: RiskRecord,
  attention: readonly (AttentionItem & { rawScore: number })[],
): Severity {
  void attention;
  return record.constructionIqRisk;
}

/** A drill-down can only resolve inside the already-scoped project set. */
export function resolveScopedProject(
  projects: readonly ProjectRiskSummary[],
  projectId: string | null,
): ProjectRiskSummary | null {
  if (!projectId) return null;
  return projects.find((project) => project.project.id === projectId) ?? null;
}

/**
 * Apply the URL filter model once so every view, search result, drawer, badge,
 * and relationship edge consumes the same bounded population.
 */
export function scopeDashboardData(
  data: Pick<DemoDataset, "asOf" | "hub" | "projects" | "companies" | "records" | "attention" | "relationships" | "recurrence" | "companyCiqSignals">,
  filters: DashboardScopeFilters,
): ScopedDashboardData {
  const authorizedRelationshipSelection = selectAuthorizedRelationships(data.relationships, data.records, { asOf: data.asOf, algorithmVersion: RISK_CONFIGURATION_ID });
  const activeRelationships = authorizedRelationshipSelection.relationships;
  const matchingProjects = data.projects.filter((summary) => {
    if (filters.hubId && summary.project.hubId !== filters.hubId) return false;
    if (filters.projectId && summary.project.id !== filters.projectId) return false;
    if (filters.businessUnitId && summary.project.businessUnitId !== filters.businessUnitId) return false;
    if (filters.projectType && summary.project.type !== filters.projectType) return false;
    if (filters.projectPhase && summary.project.currentPhase !== filters.projectPhase) return false;

    const domainSummary = filters.domain
      ? summary.domainSummaries.find((entry) => entry.domain === filters.domain)
      : null;
    if (filters.domain && !domainSummary?.available) return false;
    const domainChange = domainSummary?.momentum ?? null;
    const domainMomentum = momentumDirection(domainChange);
    const projectMomentum = filters.domain
      ? domainMomentum
      : summary.momentum.value.change7d === null
        ? null
        : summary.momentum.value.direction;
    return !filters.momentum || projectMomentum === filters.momentum;
  });

  const projects = filters.domain ? matchingProjects.map((summary): ProjectRiskSummary => {
    const domain = summary.domainSummaries.find((entry) => entry.domain === filters.domain)!;
    const change = domain.momentum;
    const direction = momentumDirection(change);
    const risk = {
      ...summary.risk,
      value: {
        index: domain.index,
        severity: domain.severity,
        highRiskOpen: domain.highRiskOpen,
        criticalOverdue: domain.criticalOverdue,
      },
      provenance: {
        ...summary.risk.provenance,
        sourceDataset: "demo-domain-summaries",
        definitionId: "risk.domain.condition",
      },
      evidence: domain.evidence,
    };
    const momentum = {
      ...summary.momentum,
      value: {
        ...summary.momentum.value,
        // MomentumDimension retains a non-null direction for compatibility,
        // while change7d is the availability signal used by every scoped UI.
        // Never expose this fallback when the domain has no prior observation.
        direction: direction ?? summary.momentum.value.direction,
        change1d: null,
        change7d: change,
        change28d: null,
        rollingAverage7d: null,
        acceleration: null,
        consecutiveElevatedPeriods: 0,
        newHighRiskRate: 0,
        resolvedHighRiskRate: 0,
      },
      provenance: {
        ...summary.momentum.provenance,
        sourceDataset: "demo-domain-summaries",
        definitionId: "momentum.direction",
      },
      evidence: domain.evidence,
    };
    return {
      ...summary,
      risk,
      momentum,
      dimensions: { ...summary.dimensions, risk, momentum },
      calculation: {
        ...summary.calculation,
        risk: {
          ...summary.calculation.risk,
          value: domain.index,
          evidenceRecordKeys: domain.evidence.map(recordIdentityKey),
          evidenceRecords: domain.evidence,
          ranking: {
            ...summary.calculation.risk.ranking,
            value: null,
            eligible: false,
            exclusionReason: "insufficient-coverage",
          },
        },
      },
      narrative: `${domain.label} domain condition in the active filter scope.`,
    };
  }) : matchingProjects;

  let projectIds = new Set(projects.map((summary) => summary.project.id));
  const companiesById = new Map<string, Company>(data.companies.map((company) => [company.id, company]));
  const scheduleLinkedRiskIds = new Set(
    scheduleExposureFromRecords(data.records, activeRelationships).scheduleLinkedRiskRecords.map(recordIdentityKey),
  );
  const persistent = (record: RiskRecord): boolean => {
    if (!isConstructionIqRiskApplicable(record)) return false;
    const created = new Date(record.createdAt).getTime();
    const ageDays = (new Date(data.asOf).getTime() - created) / 86_400_000;
    const severity = effectiveRecordSeverity(record, data.attention);
    return record.open && Number.isFinite(ageDays) && ageDays > 30 && (severity === "critical" || severity === "high");
  };
  let records = data.records.filter((record) => {
    if (!projectIds.has(record.projectId)) return false;
    if (filters.domain && record.domain !== filters.domain) return false;
    if (filters.severity && (!isConstructionIqRiskApplicable(record) || effectiveRecordSeverity(record, data.attention) !== filters.severity)) return false;
    if (filters.companyId && record.companyId !== filters.companyId) return false;
    const trade = companiesById.get(record.companyId ?? "")?.trade?.trim() || null;
    if (filters.trade === UNATTRIBUTED_TRADE_FILTER && trade !== null) return false;
    if (filters.trade && filters.trade !== UNATTRIBUTED_TRADE_FILTER && trade !== filters.trade) return false;
    if (filters.discipline && disciplineIdentityKey(record) !== filters.discipline) return false;
    if (filters.location && record.locationPath !== filters.location) return false;
    if (filters.rootCause && record.rootCause !== filters.rootCause) return false;
    if (filters.iqRootCause && record.iqRootCause !== filters.iqRootCause) return false;
    if (filters.status && record.status !== filters.status) return false;
    if (filters.persistence) {
      if (!isConstructionIqRiskApplicable(record)) return false;
      const severity = effectiveRecordSeverity(record, data.attention);
      if (!record.open || (severity !== "critical" && severity !== "high")) return false;
      if (persistent(record) !== (filters.persistence === "persistent")) return false;
    }
    const costExposure = costImpactCategoryForRecord(record);
    if (filters.costExposure && costExposure !== filters.costExposure) return false;
    const identity = recordIdentityKey(record);
    if (filters.scheduleExposure) {
      const rfiWith = (value: RiskRecord["scheduleImpact"]) => record.open && record.kind === "rfi" && record.scheduleImpact === value;
      const matchesScheduleEvidence = filters.scheduleExposure === "linked"
        ? scheduleLinkedRiskIds.has(identity)
        : filters.scheduleExposure === "flagged"
          ? rfiWith("yes")
          : filters.scheduleExposure === "potential"
            ? rfiWith("unknown")
            : filters.scheduleExposure === "explicit-negative"
              ? rfiWith("no")
              : filters.scheduleExposure === "unavailable"
                ? rfiWith(null)
                : rfiWith("unmapped");
      if (!matchesScheduleEvidence) return false;
    }
    return true;
  });
  if (filters.recurrence) {
    const crossProject = new Set(records.map((record) => record.projectId)).size > 1;
    const recurringIds = new Set(
      RECURRENCE_DIMENSIONS
        .flatMap((dimension) => recurrenceGroups(records, dimension, data.asOf, 180, "demo-generator"))
        .flatMap((group) => group.evidence.map(recordIdentityKey)),
    );
    const recurrenceEligibleIds = new Set(records.filter((record) => RECURRENCE_DIMENSIONS.some((dimension) =>
      recurrenceSignatureFor(record, dimension, crossProject) !== null
    )).map(recordIdentityKey));
    records = records.filter((record) => {
      const identity = recordIdentityKey(record);
      return recurrenceEligibleIds.has(identity) && recurringIds.has(identity) === (filters.recurrence === "recurring");
    });
  }
  const hasRecordFilters = hasRecordLevelFilters(filters);
  const aggregateOnlyCompanyScope = Boolean(filters.companyId || filters.trade) && !(
    filters.severity || filters.discipline || filters.location || filters.rootCause || filters.iqRootCause ||
    filters.status || filters.persistence || filters.recurrence || filters.costExposure || filters.scheduleExposure
  );
  const matchingSignalProjectIds = new Set(aggregateOnlyCompanyScope ? data.companyCiqSignals.filter((signal) => {
    if (filters.companyId && signal.companyId !== filters.companyId) return false;
    const trade = companiesById.get(signal.companyId)?.trade?.trim() || null;
    if (filters.trade === UNATTRIBUTED_TRADE_FILTER) return trade === null;
    return !filters.trade || trade === filters.trade;
  }).map((signal) => signal.projectId) : []);
  const scopedProjects = hasRecordFilters
    ? projects.filter((summary) => records.some((record) => record.projectId === summary.project.id) || matchingSignalProjectIds.has(summary.project.id))
    : projects;
  projectIds = new Set(scopedProjects.map((summary) => summary.project.id));
  records = records.filter((record) => projectIds.has(record.projectId));
  const recordIds = new Set(records.map(recordIdentityKey));

  const attention = data.attention.filter((item) => {
    if (!projectIds.has(item.projectId)) return false;
    if (filters.domain && item.domain !== filters.domain) return false;
    return item.evidence.some((evidence) => recordIds.has(recordIdentityKey(evidence)));
  });

  const relationships = activeRelationships.filter((edge) => {
    if (!projectIds.has(edge.projectId)) return false;
    const fromVisible = recordIds.has(recordIdentityKey(edge.from));
    const toVisible = recordIds.has(recordIdentityKey(edge.to));
    if (fromVisible && toVisible) return true;
    if (edge.from.kind !== "schedule-activity" && edge.to.kind !== "schedule-activity") return false;
    const riskEndpoint = edge.from.kind === "schedule-activity" ? edge.to : edge.from;
    return recordIds.has(recordIdentityKey(riskEndpoint));
  });
  const companySignalFiltersUnsupported = Boolean(
    filters.severity || filters.discipline || filters.location || filters.rootCause || filters.iqRootCause ||
    filters.status || filters.persistence || filters.recurrence || filters.costExposure || filters.scheduleExposure,
  );
  const companyCiqSignals = companySignalFiltersUnsupported ? [] : data.companyCiqSignals.filter((signal) => {
    if (!projectIds.has(signal.projectId)) return false;
    if (filters.companyId && signal.companyId !== filters.companyId) return false;
    const trade = companiesById.get(signal.companyId)?.trade?.trim() || null;
    if (filters.trade === UNATTRIBUTED_TRADE_FILTER && trade !== null) return false;
    if (filters.trade && filters.trade !== UNATTRIBUTED_TRADE_FILTER && trade !== filters.trade) return false;
    if (filters.domain === "quality" && !signal.quality) return false;
    if (filters.domain === "safety" && !signal.safety) return false;
    if (filters.domain && filters.domain !== "quality" && filters.domain !== "safety" && filters.domain !== "subcontractor") return false;
    return true;
  });

  return {
    projects: scopedProjects,
    records,
    attention,
    relationships,
    relationshipCoverage: {
      excludedDanglingCount: authorizedRelationshipSelection.excludedDanglingCount,
      excludedByScopeCount: activeRelationships.length - relationships.length,
    },
    companyCiqSignals,
  };
}
