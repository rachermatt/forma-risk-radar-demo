import {
  recordIdentityKey,
  type EvidenceRef,
  type RiskRecord,
} from "../canonical/types";
import {
  PORTFOLIO_RECORD_INDICATOR_LABELS,
  isOpenCiqClassifiedIssue,
  isOpenHighCiqIssue,
  isOpenHighCiqRfi,
  isOpenIssueWithRecordedCause,
  isOpenSafetySignalIssue,
} from "../risk/analytics";
import { derivedProvenance } from "../risk/provenance";
import { companyIdsWithHighRiskSignals } from "./scope";
import type { DemoCompanyCiqSignal, DemoDataset, DemoLineageEntry, ProjectRiskSummary } from "./types";

export interface PortfolioIndicator {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly detail: string;
  readonly evidence: readonly EvidenceRef[];
  readonly lineage: DemoLineageEntry;
}

export interface PortfolioIndicatorOptions {
  readonly data: Pick<DemoDataset, "asOf" | "records" | "ciqSourceCoverage">;
  readonly projects: readonly ProjectRiskSummary[];
  readonly records: readonly RiskRecord[];
  readonly companySignals: readonly DemoCompanyCiqSignal[];
  readonly recordScopeActive: boolean;
}

function evidenceFromRecords(records: readonly RiskRecord[]): readonly EvidenceRef[] {
  const evidence = new Map<string, EvidenceRef>();
  for (const record of records) {
    evidence.set(recordIdentityKey(record), {
      projectId: record.projectId,
      kind: record.kind,
      id: record.id,
      label: record.displayId ?? record.title,
      ...(record.href ? { href: record.href } : {}),
    });
  }
  return [...evidence.values()];
}

function uniqueEvidence(entries: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return [...new Map(entries.map((entry) => [recordIdentityKey(entry), entry])).values()];
}

function isOverdue(record: RiskRecord, asOf: string): boolean {
  if (!record.open || !record.dueDate || (record.kind !== "issue" && record.kind !== "rfi" && record.kind !== "submittal")) return false;
  const dueAt = new Date(record.dueDate).getTime();
  return Number.isFinite(dueAt) && dueAt < new Date(asOf).getTime();
}

export function isCriticalOverdueIndicatorRecord(record: RiskRecord, asOf: string): boolean {
  if (!isOverdue(record, asOf)) return false;
  return ((record.kind === "issue" || record.kind === "rfi") && (record.constructionIqRisk === "critical" || record.constructionIqRisk === "high")) ||
    (record.kind === "submittal" && typeof record.raw?.revision === "number" && record.raw.revision >= 2);
}

export function buildPortfolioIndicators(options: PortfolioIndicatorOptions): readonly PortfolioIndicator[] {
  const { data, projects, records, companySignals, recordScopeActive } = options;
  const visibleProjectIds = new Set(projects.map((summary) => summary.project.id));
  const visibleCoverage = (projectIds: readonly string[]) => new Set(
    projectIds.filter((projectId) => visibleProjectIds.has(projectId)),
  );
  const issueQualityCoverage = visibleCoverage(data.ciqSourceCoverage.issueQualityProjectIds);
  const rfiRiskCoverage = visibleCoverage(data.ciqSourceCoverage.rfiRiskProjectIds);
  const issueSafetyCoverage = visibleCoverage(data.ciqSourceCoverage.issueSafetyProjectIds);
  const coverageDetail = (covered: ReadonlySet<string>, label: string) =>
    `${covered.size}/${projects.length} visible projects have an extracted ${label} source.`;
  const qualifyingProjects = projects.filter((summary) =>
    summary.risk.value.severity === "critical" || summary.risk.value.severity === "high"
  );
  const increasingProjects = projects.filter((summary) => (summary.momentum.value.change7d ?? 0) > 0);
  const highCiqIssues = records.filter((record) => issueQualityCoverage.has(record.projectId) && isOpenHighCiqIssue(record));
  const highCiqRfis = records.filter((record) => rfiRiskCoverage.has(record.projectId) && isOpenHighCiqRfi(record));
  const classifiedCiqIssues = records.filter((record) => issueQualityCoverage.has(record.projectId) && isOpenCiqClassifiedIssue(record));
  const safetySignalIssues = records.filter((record) => issueSafetyCoverage.has(record.projectId) && isOpenSafetySignalIssue(record));
  const waterCauseIssues = records.filter((record) => isOpenIssueWithRecordedCause(record, "Water Intrusion"));
  const companyIds = companyIdsWithHighRiskSignals(records, companySignals, visibleProjectIds);
  const companyRecordEvidence = records.filter((record) =>
    record.companyId !== null && companyIds.has(record.companyId) && record.open &&
    (record.kind === "issue" || record.kind === "rfi") &&
    (record.constructionIqRisk === "critical" || record.constructionIqRisk === "high")
  );
  const overdueRecords = records.filter((record) =>
    recordScopeActive ? isOverdue(record, data.asOf) : isCriticalOverdueIndicatorRecord(record, data.asOf)
  );

  const definitions: readonly {
    id: string;
    label: string;
    value: number | null;
    detail: string;
    definitionId: string;
    sourceDataset: string;
    evidence: readonly EvidenceRef[];
    inputs: unknown;
  }[] = [
    {
      id: "scoped:indicator:projects-monitored",
      label: "Projects monitored",
      value: projects.length,
      detail: "Production project metadata rows in the current scope.",
      definitionId: "indicator.projects.monitored",
      sourceDataset: "filtered-project-metadata",
      evidence: [],
      inputs: { projectIds: projects.map((summary) => summary.project.id), classification: "production" },
    },
    {
      id: "scoped:indicator:projects-attention",
      label: "Projects requiring attention",
      value: recordScopeActive ? null : qualifyingProjects.length,
      detail: recordScopeActive ? "Suppressed for record-level filters." : "Visible projects whose application-derived condition is High or Critical.",
      definitionId: "indicator.projects.requiring-attention",
      sourceDataset: "filtered-project-risk-summaries",
      evidence: recordScopeActive ? [] : uniqueEvidence(qualifyingProjects.flatMap((summary) => summary.calculation.risk.evidenceRecords)),
      inputs: { suppressed: recordScopeActive, projectIds: qualifyingProjects.map((summary) => summary.project.id), severities: ["critical", "high"] },
    },
    {
      id: "scoped:indicator:high-ciq-issues",
      label: PORTFOLIO_RECORD_INDICATOR_LABELS.highCiqIssues,
      value: issueQualityCoverage.size ? highCiqIssues.length : null,
      detail: issueQualityCoverage.size ? `Open Issues with effective Autodesk Construction IQ quality classification High; unclassified is unknown. ${coverageDetail(issueQualityCoverage, "Issue quality-classification")}` : "N/A: no visible project has an extracted Construction IQ Issue quality-classification source.",
      definitionId: "risk.quality.high-open",
      sourceDataset: "filtered-canonical-issues+iq_issues_quality_risks",
      evidence: evidenceFromRecords(highCiqIssues),
      inputs: { predicate: "open issue AND effective Construction IQ risk = high", coveredProjectIds: [...issueQualityCoverage] },
    },
    {
      id: "scoped:indicator:high-ciq-rfis",
      label: PORTFOLIO_RECORD_INDICATOR_LABELS.highCiqRfis,
      value: rfiRiskCoverage.size ? highCiqRfis.length : null,
      detail: rfiRiskCoverage.size ? `Open RFIs with effective Autodesk Construction IQ RFI classification High; unclassified is unknown. ${coverageDetail(rfiRiskCoverage, "RFI risk-classification")}` : "N/A: no visible project has an extracted Construction IQ RFI risk-classification source.",
      definitionId: "risk.rfi.high-open",
      sourceDataset: "filtered-canonical-rfis+iq_rfis_high_risk",
      evidence: evidenceFromRecords(highCiqRfis),
      inputs: { predicate: "open RFI AND effective Construction IQ risk = high", coveredProjectIds: [...rfiRiskCoverage] },
    },
    {
      id: "scoped:indicator:classified-ciq-issues",
      label: PORTFOLIO_RECORD_INDICATOR_LABELS.classifiedCiqIssues,
      value: issueQualityCoverage.size ? classifiedCiqIssues.length : null,
      detail: issueQualityCoverage.size ? `Denominator context: open Issues with a Low, Medium, or High Construction IQ classification. ${coverageDetail(issueQualityCoverage, "Issue quality-classification")}` : "N/A: no visible project has an extracted Construction IQ Issue quality-classification source.",
      definitionId: "indicator.quality.classified-open",
      sourceDataset: "filtered-canonical-issues+iq_issues_quality_risks",
      evidence: evidenceFromRecords(classifiedCiqIssues),
      inputs: { predicate: "open issue AND effective Construction IQ risk in low|medium|high", coveredProjectIds: [...issueQualityCoverage] },
    },
    {
      id: "scoped:indicator:safety-signal-issues",
      label: PORTFOLIO_RECORD_INDICATOR_LABELS.safetySignalIssues,
      value: issueSafetyCoverage.size ? safetySignalIssues.length : null,
      detail: issueSafetyCoverage.size ? `Application-derived union of supported safety risk, hazard, and negative-observation sidecars; not an Autodesk safety score. ${coverageDetail(issueSafetyCoverage, "Issue safety-sidecar")}` : "N/A: no visible project has an extracted Construction IQ Issue safety-sidecar source.",
      definitionId: "risk.safety.signal-count",
      sourceDataset: "filtered-iq-issue-safety-sidecars",
      evidence: evidenceFromRecords(safetySignalIssues),
      inputs: { predicate: "open issue with safety risk category OR hazard category OR negative observation", coveredProjectIds: [...issueSafetyCoverage] },
    },
    {
      id: "scoped:indicator:recorded-water-cause",
      label: PORTFOLIO_RECORD_INDICATOR_LABELS.recordedWaterCauseIssues,
      value: waterCauseIssues.length,
      detail: "Open Issues whose recorded project-configured root-cause label is Water Intrusion; not Autodesk Water Risk.",
      definitionId: "indicator.issue.recorded-root-cause-open",
      sourceDataset: "filtered-canonical-issues",
      evidence: evidenceFromRecords(waterCauseIssues),
      inputs: { predicate: "open issue AND recorded root cause = Water Intrusion", identityScope: "project" },
    },
    {
      id: "scoped:indicator:companies-high-risk-signals",
      label: "Companies with high-risk signals",
      value: companyIds.size,
      detail: "Companies of any Autodesk category with open High risk evidence or a visible High company-quality signal; not a grade.",
      definitionId: "indicator.company.high-risk-signal-count",
      sourceDataset: "filtered-canonical-records+company-quality-change-log",
      evidence: evidenceFromRecords(companyRecordEvidence),
      inputs: {
        companyIds: [...companyIds],
        aggregateSignalRows: companySignals.filter((signal) =>
          visibleProjectIds.has(signal.projectId) && signal.quality?.dailyRisk.toLowerCase() === "high"
        ).map((signal) => ({ projectId: signal.projectId, companyId: signal.companyId, snapshotDate: signal.snapshotDate })),
      },
    },
    {
      id: "scoped:indicator:risk-increased-7d",
      label: "Risk increased · 7 days",
      value: recordScopeActive ? null : increasingProjects.length,
      detail: recordScopeActive ? "Suppressed for record-level filters." : "Projects with an available positive 7-day application-derived risk-index change.",
      definitionId: "momentum.projects.increased-7d",
      sourceDataset: "filtered-project-risk-series",
      evidence: recordScopeActive ? [] : uniqueEvidence(increasingProjects.flatMap((summary) => summary.calculation.risk.evidenceRecords)),
      inputs: { suppressed: recordScopeActive, projectChanges: increasingProjects.map((summary) => ({ projectId: summary.project.id, change7d: summary.momentum.value.change7d })) },
    },
    {
      id: "scoped:indicator:overdue",
      label: recordScopeActive ? "Overdue matching records" : "Critical overdue risk items",
      value: overdueRecords.length,
      detail: recordScopeActive
        ? "Open matching records whose due date precedes the dashboard as-of time. Submittal due-date mapping is approximate pending state-aware validation."
        : "Open overdue High/Critical records plus overdue Submittals at revision 2 or above, per the application rule. Submittal due-date mapping is approximate pending state-aware validation.",
      definitionId: recordScopeActive ? "indicator.records.overdue-filtered" : "risk.critical-overdue",
      sourceDataset: "filtered-canonical-risk-records",
      evidence: evidenceFromRecords(overdueRecords),
      inputs: { asOf: data.asOf, recordScopeActive },
    },
  ];

  return definitions.map((definition) => {
    const provenance = derivedProvenance({
      sourceSystem: "demo-generator",
      sourceDataset: definition.sourceDataset,
      timestamp: data.asOf,
      definitionId: definition.definitionId,
    });
    const lineage: DemoLineageEntry = {
      id: definition.id,
      category: "portfolio",
      label: definition.label,
      value: definition.value === null
        ? { value: null, unavailableReason: definition.detail }
        : { value: definition.value },
      provenance,
      evidence: definition.evidence,
      inputs: definition.inputs,
    };
    return { ...definition, lineage };
  });
}
