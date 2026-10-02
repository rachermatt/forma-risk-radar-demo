import { recordIdentityKey, type ConcentrationDimension, type EvidenceRef, type RiskRecord } from "../canonical/types";
import {
  actionabilityIndex,
  burnEligibleRecords,
  burnRateFromRecords,
  concentration,
  concentrationEligibleRecords,
  hotspots,
  RECURRENCE_DIMENSIONS,
  recurrenceGroups,
} from "../risk/analytics";
import { derivedProvenance } from "../risk/provenance";
import { buildSafetyObservationBalance, safetyObservationSourceAvailabilityForProjects } from "../risk/safety-observation";
import { buildCostImpactRiskView } from "../risk/cost-impact-view";
import { buildRelationshipConversionEvidence } from "../risk/relationship-conversion-evidence";
import { buildRfiCauseIntelligence, rfiCauseSourceAvailabilityForProjects } from "../risk/rfi-cause-intelligence";
import { buildRiskVelocityEvidence } from "../risk/risk-velocity";
import { aggregateFilledSeriesByDate } from "../risk/metrics";
import { buildPortfolioIndicators } from "./portfolio-indicators";
import { hasRecordLevelFilters, type DashboardScopeFilters, type ScopedDashboardData } from "./scope";
import { formRecordMatchesSignal, formSignalIdentityKey, type DemoDataset, type DemoLineageEntry } from "./types";

export interface ScopedLineageOptions {
  filters: DashboardScopeFilters;
  rangeDays: number;
  /** Inclusive UTC day anchoring the selected history window. Defaults to the dataset as-of. */
  rangeAsOf?: string;
  /** False when the requested burn window begins before retained source history. */
  rangeCoverageComplete?: boolean;
  concentrationDimension: Extract<ConcentrationDimension, "company" | "trade" | "root-cause" | "iq-root-cause" | "discipline" | "location" | "building-component" | "issue-type" | "project-type" | "project-phase" | "business-unit">;
}

export function resolveVisibleLineageSelection(
  visible: readonly DemoLineageEntry[],
  selectedId: string,
): DemoLineageEntry | null {
  return visible.find((entry) => entry.id === selectedId) ?? visible[0] ?? null;
}

function mean(values: readonly (number | null)[]): number | null {
  const available = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
}

function evidenceForRecords(records: readonly RiskRecord[]): readonly EvidenceRef[] {
  const unique = new Map<string, EvidenceRef>();
  for (const record of records) {
    unique.set(recordIdentityKey(record), {
      kind: record.kind,
      id: record.id,
      projectId: record.projectId,
      label: record.displayId ?? record.title,
      ...(record.href ? { href: record.href } : {}),
    });
  }
  return [...unique.values()];
}

function scopedProvenance(data: DemoDataset, definitionId: string, projectId?: string) {
  return derivedProvenance({
    sourceSystem: "demo-generator",
    sourceDataset: "filtered-canonical-risk-records",
    timestamp: data.asOf,
    definitionId,
    ...(projectId ? { projectId } : {}),
  });
}

/**
 * Build a lineage registry for values recalculated in the browser from the
 * active URL scope. Baseline lineage remains immutable; these entries explain
 * the exact filtered population currently rendered.
 */
export function buildScopedLineage(
  data: DemoDataset,
  scoped: ScopedDashboardData,
  options: ScopedLineageOptions,
): readonly DemoLineageEntry[] {
  const { filters, rangeDays, concentrationDimension } = options;
  const rangeAsOf = options.rangeAsOf ?? data.asOf;
  const rangeCoverageComplete = options.rangeCoverageComplete ?? true;
  const recordScopeActive = hasRecordLevelFilters(filters);
  const scopeInputs = {
    filters,
    projectIds: scoped.projects.map((summary) => summary.project.id),
    selectionRecordKeys: scoped.records.map(recordIdentityKey),
  };
  const scopedRecordKeys = new Set(scoped.records.map(recordIdentityKey));
  const projectRiskEvidence = recordScopeActive ? [] : scoped.projects.flatMap((summary) => summary.calculation.risk.evidenceRecords);
  const projectExposureEvidence = recordScopeActive ? [] : scoped.projects.flatMap((summary) => summary.calculation.exposure.evidenceRecords);
  const projectValues = recordScopeActive ? [] : scoped.projects.map((summary) => ({
    projectId: summary.project.id,
    value: summary.risk.value.index,
  }));
  const exposureValues = filters.domain || recordScopeActive ? [] : scoped.projects.map((summary) => ({
    projectId: summary.project.id,
    value: summary.exposure.value.index,
  }));
  const momentumValues = (recordScopeActive ? [] : scoped.projects)
    .filter((summary) => summary.momentum.value.change7d !== null)
    .map((summary) => ({ projectId: summary.project.id, value: summary.momentum.value.change7d! }));

  const entries: DemoLineageEntry[] = [
    {
      id: "scoped:portfolio:risk",
      category: "portfolio",
      label: "Current filtered portfolio risk",
      value: recordScopeActive ? { index: null, unavailableReason: "Project snapshots cannot be retrospectively record-filtered" } : { index: mean(projectValues.map((entry) => entry.value)), projectCount: projectValues.length },
      provenance: scopedProvenance(data, "risk.portfolio.filtered-mean-project-index"),
      evidence: projectRiskEvidence,
      inputs: { ...scopeInputs, aggregation: recordScopeActive ? "suppressed for record-level filter scope" : "arithmetic mean of visible project/domain condition point estimates", projectValues },
    },
    {
      id: "scoped:portfolio:exposure",
      category: "portfolio",
      label: "Current filtered portfolio exposure",
      value: filters.domain || recordScopeActive
        ? { index: null, unavailableReason: recordScopeActive ? "Project snapshots cannot be retrospectively record-filtered" : "No validated domain-level exposure index" }
        : { index: mean(exposureValues.map((entry) => entry.value)), projectCount: exposureValues.length },
      provenance: scopedProvenance(data, "exposure.portfolio.filtered-mean-project-index"),
      evidence: filters.domain || recordScopeActive ? [] : projectExposureEvidence,
      inputs: { ...scopeInputs, aggregation: recordScopeActive ? "suppressed for record-level filter scope" : filters.domain ? "suppressed for domain scope" : "arithmetic mean of visible project exposure indexes", projectValues: exposureValues },
    },
    {
      id: "scoped:portfolio:momentum",
      category: "portfolio",
      label: "Current filtered portfolio momentum",
      value: recordScopeActive ? { change7d: null, unavailableReason: "Project history cannot be retrospectively record-filtered" } : { change7d: mean(momentumValues.map((entry) => entry.value)), projectCount: momentumValues.length },
      provenance: scopedProvenance(data, "momentum.portfolio.filtered-mean-project-change"),
      evidence: projectRiskEvidence,
      inputs: { ...scopeInputs, aggregation: recordScopeActive ? "suppressed for record-level filter scope" : "arithmetic mean of visible project 7-day changes", projectValues: momentumValues },
    },
  ];
  entries.push(...buildPortfolioIndicators({
    data,
    projects: scoped.projects,
    records: scoped.records,
    companySignals: scoped.companyCiqSignals,
    recordScopeActive,
  }).map((indicator) => indicator.lineage));
  const safetyBalance = buildSafetyObservationBalance(
    scoped.records,
    data.asOf,
    20,
    safetyObservationSourceAvailabilityForProjects(
      scoped.projects.map((summary) => summary.project.id),
      data.ciqSourceCoverage.issueSafetyObservationProjectIds,
    ),
  );
  entries.push({
    id: "scoped:safety:observation-balance",
    category: "analytics",
    label: "Filtered safety observation balance",
    value: {
      positive: safetyBalance.sourceCoverage.available ? safetyBalance.positive : null,
      negative: safetyBalance.sourceCoverage.available ? safetyBalance.negative : null,
      classified: safetyBalance.sourceCoverage.available ? safetyBalance.classified : null,
      positiveShare: safetyBalance.positiveShare,
      unavailableReason: !safetyBalance.sourceCoverage.available
        ? safetyBalance.sourceCoverage.unavailableReason
        : safetyBalance.positiveShare === null
        ? `Share suppressed below ${safetyBalance.minimumForShare} classified observations`
        : null,
    },
    provenance: safetyBalance.provenance,
    evidence: safetyBalance.evidence,
    inputs: { ...scopeInputs, minimumForShare: safetyBalance.minimumForShare, sourceCoverage: safetyBalance.sourceCoverage },
  });

  for (const summary of scoped.projects) {
    const records = scoped.records.filter((record) => record.projectId === summary.project.id);
    const domainCalculation = filters.domain
      ? data.projects.find((candidate) => candidate.project.id === summary.project.id)
        ?.domainSummaries.find((candidate) => candidate.domain === filters.domain)?.calculation
      : null;
    const actionabilityPopulation = records.filter((record) => record.open && (record.kind === "issue" || record.kind === "rfi") && ["high", "medium"].includes(record.constructionIqRisk));
    entries.push(
      {
        id: `scoped:project:${summary.project.id}:condition`,
        category: "project",
        label: `${summary.project.name} filtered condition`,
        value: recordScopeActive ? { index: null, unavailableReason: "Project snapshot cannot be retrospectively record-filtered" } : summary.risk.value,
        provenance: scopedProvenance(data, filters.domain ? "risk.domain.condition" : "risk.index.filtered", summary.project.id),
        evidence: recordScopeActive ? [] : summary.calculation.risk.evidenceRecords,
        inputs: { ...scopeInputs, projectId: summary.project.id, domain: filters.domain ?? "all", calculation: recordScopeActive ? "suppressed" : domainCalculation ?? summary.calculation.risk },
      },
      {
        id: `scoped:project:${summary.project.id}:actionability`,
        category: "project",
        label: `${summary.project.name} filtered actionability`,
        value: actionabilityIndex(records, data.asOf),
        provenance: scopedProvenance(data, "actionability.index.filtered-records", summary.project.id),
        evidence: evidenceForRecords(actionabilityPopulation),
        inputs: { ...scopeInputs, projectId: summary.project.id, eligibleRecordKeys: actionabilityPopulation.map(recordIdentityKey) },
      },
    );
    if (rangeCoverageComplete) {
      const burn = burnRateFromRecords(records, rangeAsOf, rangeDays, filters.domain ?? "all", summary.project.id, "demo-generator");
      entries.push({
        id: `scoped:project:${summary.project.id}:burn:${rangeDays}d`,
        category: "analytics",
        label: `${summary.project.name} filtered burn rate`,
        value: burn,
        provenance: burn.provenance,
        evidence: evidenceForRecords(burnEligibleRecords(records, filters.domain ?? "all")),
        inputs: { ...scopeInputs, projectId: summary.project.id, periodDays: rangeDays, rangeAsOf, domain: filters.domain ?? "all" },
      });
    }
    if (!recordScopeActive && summary.ciqQuality) {
      entries.push({
        id: `scoped:ciq-project-quality:${summary.project.id}`,
        category: "project",
        label: `${summary.project.name} Construction IQ quality risk`,
        value: summary.ciqQuality.value,
        provenance: summary.ciqQuality.provenance,
        evidence: [],
        inputs: { ...scopeInputs, projectId: summary.project.id, observedAt: summary.ciqQuality.value.observedAt, forwardFilled: summary.ciqQuality.value.forwardFilled },
      });
    }
  }

  for (const signal of scoped.companyCiqSignals) {
    if (signal.quality) entries.push({
      id: `scoped:ciq-company-quality:${signal.projectId}:${signal.companyId}`,
      category: "analytics",
      label: "Company Construction IQ quality risk",
      value: signal.quality,
      provenance: signal.quality.provenance,
      evidence: [],
      inputs: { ...scopeInputs, companyId: signal.companyId, projectId: signal.projectId, snapshotDate: signal.snapshotDate, observedAt: signal.quality.observedAt, forwardFilled: signal.quality.forwardFilled },
    });
    if (signal.safety) entries.push({
      id: `scoped:ciq-company-safety:${signal.projectId}:${signal.companyId}`,
      category: "analytics",
      label: "Company Construction IQ safety risk",
      value: signal.safety,
      provenance: signal.safety.provenance,
      evidence: [],
      inputs: { ...scopeInputs, companyId: signal.companyId, projectId: signal.projectId, snapshotDate: signal.snapshotDate, observedAt: signal.safety.observedAt, forwardFilled: signal.safety.forwardFilled, scale: "undocumented" },
    });
  }

  if (rangeCoverageComplete) {
    const portfolioBurn = burnRateFromRecords(scoped.records, rangeAsOf, rangeDays, filters.domain ?? "all", "hub", "demo-generator");
    entries.push({
      id: `scoped:portfolio:burn:${rangeDays}d`,
      category: "analytics",
      label: "Current filtered portfolio burn rate",
      value: portfolioBurn,
      provenance: portfolioBurn.provenance,
      evidence: evidenceForRecords(burnEligibleRecords(scoped.records, filters.domain ?? "all")),
      inputs: { ...scopeInputs, periodDays: rangeDays, rangeAsOf, domain: filters.domain ?? "all" },
    });
  }

  const projectNames = new Map(scoped.projects.map((summary) => [summary.project.id, summary.project.name]));
  for (const hotspot of hotspots(scoped.records, projectNames, data.asOf, "demo-generator", data.locations)) {
    entries.push({
      id: `scoped:hotspot:${hotspot.projectId}:${hotspot.locationId}`,
      category: "analytics",
      label: `${hotspot.path} filtered overlap`,
      value: { overlapScore: hotspot.overlapScore, domainCounts: hotspot.domainCounts },
      provenance: hotspot.provenance,
      evidence: hotspot.evidence,
      inputs: { ...scopeInputs, projectId: hotspot.projectId, domains: hotspot.domains, totalHighRisk: hotspot.totalHighRisk },
    });
  }

  const concentrationPopulation = concentrationEligibleRecords(scoped.records.filter((record) =>
    record.open && (record.kind === "issue" || record.kind === "rfi") && (filters.severity ? true : record.constructionIqRisk === "high")
  ), concentrationDimension);
  for (const bucket of concentration(concentrationPopulation, concentrationDimension, data.companies, data.asOf, "demo-generator", { projects: scoped.projects.map((summary) => summary.project), businessUnits: data.businessUnits })) {
    entries.push({
      id: `scoped:concentration:${concentrationDimension}:${bucket.key}`,
      category: "analytics",
      label: `${bucket.label} filtered concentration`,
      value: { count: bucket.count, shareOfTotal: bucket.shareOfTotal, projectsAffected: bucket.projectsAffected },
      provenance: bucket.provenance,
      evidence: bucket.evidence,
      inputs: { ...scopeInputs, dimension: concentrationDimension, eligiblePopulation: concentrationPopulation.length },
    });
  }

  for (const dimension of RECURRENCE_DIMENSIONS) {
    for (const group of recurrenceGroups(scoped.records, dimension, data.asOf, 180, "demo-generator")) {
      entries.push({
        id: `scoped:${group.id}`,
        category: "analytics",
        label: `${group.label} filtered recurrence`,
        value: { occurrences: group.occurrences, recurrenceRate: group.recurrenceRate },
        provenance: group.provenance,
        evidence: group.evidence,
        inputs: { ...scopeInputs, dimension, windowDays: 180 },
      });
    }
  }

  for (const signal of data.formSignals.filter((candidate) => projectNames.has(candidate.projectId))) {
    const matching = scoped.records.filter((record) => formRecordMatchesSignal(record, signal));
    if (!matching.length) continue;
    const current = matching.filter((record) => record.raw?.period_bucket === "current");
    const previous = matching.filter((record) => record.raw?.period_bucket === "previous");
    const activityChange = previous.length
      ? Math.round((1_000 * (current.length - previous.length)) / previous.length) / 10
      : null;
    entries.push({
      id: `scoped:form:${formSignalIdentityKey(signal)}`,
      category: "form",
      label: `${signal.templateName} filtered activity`,
      value: {
        inspections: current.length,
        applicationDefinedExceptions: current.filter((record) => record.raw?.application_defined_exception === true).length,
        activityChange,
      },
      provenance: scopedProvenance(data, "form.activity.filtered", signal.projectId),
      evidence: evidenceForRecords(matching),
      inputs: { ...scopeInputs, projectId: signal.projectId, templateId: signal.templateId, layoutUid: signal.layoutUid, templateName: signal.templateName, currentRecordKeys: current.map(recordIdentityKey), previousRecordKeys: previous.map(recordIdentityKey) },
    });
  }

  for (const item of scoped.attention) {
    entries.push({
      id: `scoped:attention:${item.id}`,
      category: "attention",
      label: `${item.title} filtered attention score`,
      value: { score: item.score, rawScore: item.rawScore, priority: item.priority },
      provenance: item.provenance,
      evidence: item.evidence,
      inputs: { ...scopeInputs, reasons: item.reasons },
    });
  }

  const persistentRecords = scoped.records.filter((record) => {
    const ageDays = (new Date(data.asOf).getTime() - new Date(record.createdAt).getTime()) / 86_400_000;
    const severity = record.constructionIqRisk;
    return record.open && (record.kind === "issue" || record.kind === "rfi") && ageDays > 30 && (severity === "critical" || severity === "high");
  });
  entries.push({
    id: "scoped:persistence:over-30d",
    category: "analytics",
    label: "Current filtered persistent risk",
    value: { count: persistentRecords.length },
    provenance: scopedProvenance(data, "persistence.filtered-open-high-over-30d"),
    evidence: evidenceForRecords(persistentRecords),
    inputs: { ...scopeInputs, thresholdDays: 30, eligibleSeverities: ["critical", "high"] },
  });

  const projectLabels = Object.fromEntries(scoped.projects.map((summary) => [summary.project.id, summary.project.name]));
  const costImpact = buildCostImpactRiskView(scoped.records, {
    asOf: data.asOf,
    sourceSystem: "demo-generator",
    projectLabels,
  });
  entries.push({
    id: "scoped:cost-impact:summary",
    category: "analytics",
    label: "Current filtered cost-impact categories",
    value: { denominator: costImpact.denominator, unquantifiedSignalCount: costImpact.unquantifiedSignalCount, rfiUnknownCount: costImpact.rfiUnknownCount },
    provenance: costImpact.provenance,
    evidence: costImpact.buckets.flatMap((bucket) => bucket.evidence),
    inputs: { ...scopeInputs, eligibleKinds: ["issue", "rfi"], currentOpenOnly: true },
  });
  for (const bucket of costImpact.buckets) entries.push({
    id: `scoped:cost-impact:${bucket.category}`,
    category: "analytics",
    label: bucket.label,
    value: { count: bucket.count, share: bucket.share, denominator: costImpact.denominator },
    provenance: bucket.provenance,
    evidence: bucket.evidence,
    inputs: { ...scopeInputs, category: bucket.category, contributorKeys: bucket.contributors.map((item) => item.identityKey) },
  });

  const rfiCauses = buildRfiCauseIntelligence({
    records: scoped.records,
    asOf: data.asOf,
    sourceSystem: "demo-generator",
    projectLabels,
    sourceAvailability: rfiCauseSourceAvailabilityForProjects(
      scoped.projects.map((summary) => summary.project.id),
      data.ciqSourceCoverage.rfiCauseProjectIds,
    ),
  });
  entries.push({
    id: "scoped:rfi-causes:coverage",
    category: "analytics",
    label: "Current filtered RFI cause coverage",
    value: { totalRfis: rfiCauses.totalRfis, ciqAttributed: rfiCauses.ciqAttributed, operationalAttributed: rfiCauses.operationalAttributed },
    provenance: rfiCauses.provenance,
    evidence: rfiCauses.groups.flatMap((group) => group.evidence),
    inputs: {
      ...scopeInputs,
      sourcesKeptSeparate: ["iq_rfis_root_cause", "rfis_rfis.category"],
      sourceCoverage: rfiCauses.sourceCoverage,
    },
  });
  for (const group of rfiCauses.groups) entries.push({
    id: `scoped:rfi-cause:${encodeURIComponent(group.key)}`,
    category: "analytics",
    label: `${group.label} · ${group.origin}`,
    value: { count: group.count, denominator: group.denominator, share: group.share, openAge: group.openAge, responseDuration: group.responseDuration, projectsAffected: group.projectsAffected, companiesAffected: group.companiesAffected, recurrence: group.recurrence },
    provenance: group.metricProvenance,
    evidence: group.evidence,
    inputs: { ...scopeInputs, sourceOrigin: group.origin, sourceLabel: group.label, contributorKeys: group.contributors.map((item) => item.identityKey) },
  });

  const velocity = buildRiskVelocityEvidence(scoped.projects.map((summary) => summary.momentum), {
    asOf: data.asOf,
    sourceSystem: "demo-generator",
    sourceDataset: "project-risk-snapshots",
    series: !recordScopeActive && !filters.domain
      ? aggregateFilledSeriesByDate(scoped.projects.map((summary) => summary.trend))
      : undefined,
    available: !recordScopeActive && !filters.domain,
    unavailableReason: recordScopeActive
      ? "Project snapshot history cannot be retrospectively record-filtered."
      : filters.domain
        ? "Validated daily domain history is unavailable."
        : undefined,
  });
  for (const metric of velocity.metrics) entries.push({
    id: `scoped:velocity:${metric.id}`,
    category: "analytics",
    label: metric.label,
    value: { value: metric.value, unit: metric.unit, availability: metric.availability, coverageCount: metric.coverageCount, populationCount: metric.populationCount, unavailableReason: metric.unavailableReason ?? velocity.unavailableReason },
    provenance: metric.provenance,
    evidence: velocity.state === "available" ? metric.evidence : [],
    inputs: { ...scopeInputs, aggregation: metric.id === "newHighRiskRate" || metric.id === "resolvedHighRiskRate" ? "sum of project weekly rates" : "mean of covered project snapshot values" },
  });

  const conversion = buildRelationshipConversionEvidence(scoped.relationships, { records: scoped.records });
  entries.push({
    id: "scoped:relationships:conversion-evidence",
    category: "analytics",
    label: "Current filtered relationship conversion evidence",
    value: { stages: conversion.stages, unclassifiedEdgeCount: conversion.unclassifiedEdgeCount },
    provenance: scopedProvenance(data, "relationships.conversion-evidence.filtered"),
    evidence: conversion.contributors.flatMap((item) => [item.edge.from, item.edge.to]).filter((item) => scopedRecordKeys.has(recordIdentityKey(item))),
    inputs: { ...scopeInputs, minimumEdgeCount: conversion.minimumEdgeCount, directionAndCausalityAsserted: false },
  });

  return entries;
}
