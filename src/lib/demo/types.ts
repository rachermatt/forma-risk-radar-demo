import type {
  AttentionItem,
  BurnRate,
  BusinessUnit,
  ColumnReportRow,
  Company,
  ConcentrationBucket,
  EvidenceRef,
  Hotspot,
  Hub,
  IngestionJob,
  LocationNode,
  Measured,
  MetricProvenance,
  MomentumDimension,
  Project,
  RecurrenceGroup,
  RiskDimension,
  RiskDomain,
  RiskExposureMomentum,
  RiskRecord,
  RiskRelationship,
  Severity,
} from "../canonical/types";
import type {
  ExposureIndexInput,
  FilledSeriesPoint,
  Per100ActiveResult,
  RiskIndexInput,
} from "../risk/metrics";

export interface DemoCalculationTrace<TInputs> {
  definitionId: string;
  inputs: TInputs;
  value: number | null;
  coverage: number;
  availableWeight: number;
  missing: readonly string[];
  suppressed: boolean;
  evidenceRecordKeys: readonly string[];
  evidenceRecords: readonly EvidenceRef[];
}

export type RiskRankingCohort = "ciq-covered" | "ciq-unavailable";

export interface DemoRiskRankingTrace {
  inputs: RiskIndexInput;
  value: number | null;
  coverage: number;
  availableWeight: number;
  missing: readonly string[];
  suppressed: boolean;
  eligible: boolean;
  exclusionReason: "ciq-unavailable" | "low-sample" | "insufficient-coverage" | null;
  cohort: RiskRankingCohort;
}

export interface DemoRiskNormalizations {
  highRiskPer100: Per100ActiveResult;
  overduePer100: Per100ActiveResult;
  safetySignalsPer100: Per100ActiveResult | null;
}

export interface DemoDomainCalculationTrace {
  formula: "risk.domain.condition";
  asOf: string;
  previousAsOf: string;
  openRecords: number;
  classifiedOpenRecords: number;
  severityPoints: number;
  /** Every active record in this exact project/domain population. */
  overdueDenominatorRecords: number;
  overdueRecords: number;
  coverage: number;
  currentIndex: number | null;
  previousIndex: number | null;
}

export interface DomainSummary {
  domain: RiskDomain;
  label: string;
  severity: Severity;
  index: number | null;
  highRiskOpen: number;
  overdue: number;
  criticalOverdue: number;
  momentum: number | null;
  available: boolean;
  source: "autodesk" | "derived";
  evidence: readonly EvidenceRef[];
  calculation: DemoDomainCalculationTrace;
}

export interface ProjectRiskSummary {
  project: Project;
  code: string;
  descriptor: string;
  risk: Measured<RiskDimension>;
  exposure: Measured<{
    index: number | null;
    locationsAffected: number;
    companiesAffected: number;
    projectsAffected: number;
    confirmedCostImpact: number;
    potentialCostExposure: number;
    unquantifiedCostImpact: number;
    scheduleLinkedItems: number;
    criticalPathLinkedItems: number;
  }>;
  momentum: Measured<MomentumDimension>;
  ciqQuality: Measured<{
    level: Severity;
    observedAt: string;
    forwardFilled: boolean;
  }> | null;
  dimensions: RiskExposureMomentum;
  trend: readonly FilledSeriesPoint[];
  domainSummaries: readonly DomainSummary[];
  coverage: { covered: number; total: number; notApplicable: number };
  burnRate: BurnRate;
  actionabilityIndex: number | null;
  ciqObservedAt: string | null;
  ciqForwardFilled: boolean;
  narrative: string;
  calculation: {
    risk: DemoCalculationTrace<RiskIndexInput> & {
      normalizations: DemoRiskNormalizations;
      ranking: DemoRiskRankingTrace;
    };
    exposure: DemoCalculationTrace<ExposureIndexInput>;
  };
}

export interface DemoFormSignal {
  projectId: string;
  templateId: string;
  layoutUid: string;
  templateName: string;
  domain: "quality" | "safety";
  period: string;
  inspections: number;
  applicationDefinedExceptions: number;
  activityChange: number;
  note: string;
  evidence: readonly EvidenceRef[];
  provenance: MetricProvenance;
}

export type DemoFormSignalIdentity = Pick<DemoFormSignal, "projectId" | "templateId" | "layoutUid">;

export function formSignalIdentityKey(signal: DemoFormSignalIdentity): string {
  return [signal.projectId, signal.templateId, signal.layoutUid].map(encodeURIComponent).join(":");
}

export function formRecordMatchesSignal(
  record: RiskRecord,
  signal: DemoFormSignalIdentity,
): boolean {
  return record.kind === "form" &&
    record.projectId === signal.projectId &&
    record.raw?.template_id === signal.templateId &&
    record.raw?.layout_uid === signal.layoutUid;
}

export interface DemoCompanyCiqSignal {
  companyId: string;
  projectId: string;
  snapshotDate: string;
  quality: {
    dailyRisk: string;
    dailyIndicator: number | null;
    observedAt: string;
    forwardFilled: boolean;
    provenance: MetricProvenance;
  } | null;
  safety: {
    dailyRisk: number;
    dailyIndicator: number | null;
    observedAt: string;
    forwardFilled: boolean;
    provenance: MetricProvenance;
  } | null;
  notApplicable: boolean;
}

export interface DemoLineageEntry {
  id: string;
  category: "portfolio" | "project" | "domain" | "attention" | "analytics" | "form";
  label: string;
  value: unknown;
  provenance: MetricProvenance;
  evidence: readonly EvidenceRef[];
  inputs: unknown;
}

export interface DemoCiqSourceCoverage {
  /** Projects with an extracted Issue quality-classification source. */
  issueQualityProjectIds: readonly string[];
  /** Projects with an extracted RFI high-risk-classification source. */
  rfiRiskProjectIds: readonly string[];
  /** Projects with an extracted RFI root-cause source. */
  rfiCauseProjectIds: readonly string[];
  /** Projects with an extracted Issue safety-risk source. */
  issueSafetyRiskProjectIds: readonly string[];
  /** Projects with an extracted Issue safety-hazard source. */
  issueSafetyHazardProjectIds: readonly string[];
  /** Projects with an extracted Issue safety-observation source. */
  issueSafetyObservationProjectIds: readonly string[];
  /** Union used only for indicators that accept any supported Issue safety sidecar. */
  issueSafetyProjectIds: readonly string[];
}

export interface DemoDataset {
  mode: "demo";
  asOf: string;
  coverageStart: string;
  hub: Hub;
  portfolio: RiskExposureMomentum;
  projects: readonly ProjectRiskSummary[];
  companies: readonly Company[];
  businessUnits: readonly BusinessUnit[];
  locations: readonly LocationNode[];
  records: readonly RiskRecord[];
  attention: readonly (AttentionItem & { rawScore: number })[];
  concentrations: Readonly<Record<"company" | "trade" | "root-cause" | "discipline", readonly ConcentrationBucket[]>>;
  recurrence: readonly RecurrenceGroup[];
  hotspots: readonly Hotspot[];
  relationships: readonly RiskRelationship[];
  portfolioTrend: readonly FilledSeriesPoint[];
  burnHistory: readonly { week: string; created: number; resolved: number; backlog: number }[];
  formSignals: readonly DemoFormSignal[];
  companyCiqSignals: readonly DemoCompanyCiqSignal[];
  ciqSourceCoverage: DemoCiqSourceCoverage;
  lineage: readonly DemoLineageEntry[];
  ingestion: IngestionJob;
  columnReport: readonly ColumnReportRow[];
  disclosures: readonly string[];
  portfolioCalculation: {
    risk: DemoCalculationTrace<{
      aggregation: "arithmetic-mean-of-project-risk-index";
      projectIndexes: readonly { projectId: string; value: number }[];
    }>;
    exposure: DemoCalculationTrace<{
      aggregation: "arithmetic-mean-of-project-exposure-index";
      projectIndexes: readonly { projectId: string; value: number }[];
    }>;
    momentum: {
      definitionId: string;
      aggregation: "arithmetic-mean-of-project-risk-series";
      projectIds: readonly string[];
      evidenceRecordKeys: readonly string[];
      evidenceRecords: readonly EvidenceRef[];
    };
  };
}
