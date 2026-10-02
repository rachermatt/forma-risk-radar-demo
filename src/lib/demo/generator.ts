import type {
  BusinessUnit,
  Company,
  EvidenceRef,
  ExposureDimension,
  Measured,
  MomentumDimension,
  Project,
  RiskDimension,
  RiskDomain,
  RiskRecord,
  RiskRelationship,
  Severity,
} from "../canonical/types";
import {
  RISK_DOMAIN_LABEL,
  RISK_DOMAINS,
  recordIdentityKey,
  safetyObservationCategoryFromConstructionIq,
  safetyRiskCategoryFromConstructionIq,
  sameRecordIdentity,
  trimmedCanonicalText,
} from "../canonical/types";
import {
  actionabilityIndex,
  attentionRecurringRecordKeys,
  burnEligibleRecords,
  burnRateFromRecords,
  calculateAttentionItem,
  concentration,
  hasSupportedSafetySignal,
  hotspots,
  isConstructionIqRiskApplicable,
  RECURRENCE_DIMENSIONS,
  recurrenceGroups,
  scheduleExposureFromRecords,
} from "../risk/analytics";
import { RISK_CONFIGURATION_ID } from "../risk/definitions";
import {
  calculateExposureIndex,
  aggregateFilledSeriesByDate,
  calculateMomentum,
  calculateRiskIndex,
  forwardFillDailySeries,
  per100Active,
  riskDimension,
  severityFromRiskIndex,
  type ObservedSeriesPoint,
} from "../risk/metrics";
import { autodeskProvenance, derivedProvenance, measured } from "../risk/provenance";
import { RISK_DISCLOSURES } from "../risk/disclosures";
import {
  formRecordMatchesSignal,
  formSignalIdentityKey,
  type DemoDataset,
  type DemoLineageEntry,
  type DomainSummary,
  type ProjectRiskSummary,
} from "./types";
import { buildDemoLocationNodes, demoLocationIdentityKey } from "./locations";

export const DEMO_AS_OF = "2026-09-08T12:00:00.000Z";
export const DEMO_COVERAGE_START = "2026-03-12";
const DAY_MS = 86_400_000;

interface Scenario {
  id: string;
  code: string;
  name: string;
  descriptor: string;
  type: string;
  city: string;
  value: number;
  recordCount: number;
  /** Synthetic population target used to exercise the published cross-project ranking guard. */
  rankingActiveIssueTarget: number | null;
  /** Data-shaping target only; displayed counts are recalculated from records. */
  highRiskOpen: number;
  /** Data-shaping target only; displayed counts are recalculated from due dates. */
  criticalOverdue: number;
  ciqQuality: Severity;
  /** Extracted iq_issues_quality_risks coverage; independent of other IQ tables. */
  issueQualityCovered: boolean;
  /** Extracted iq_rfis_high_risk coverage; independent of Issue IQ tables. */
  rfiRiskCovered: boolean;
  /** Extracted iq_rfis_root_cause coverage; independent of RFI risk classification. */
  rfiCauseCovered: boolean;
  issueSafetyRiskCovered: boolean;
  issueSafetyHazardCovered: boolean;
  issueSafetyObservationCovered: boolean;
  safetyCovered: boolean;
  submittalCovered: boolean;
  momentum: "accelerating" | "increasing" | "stable" | "improving";
  change7d: number;
  change28d: number;
  headline: string;
  rootCause: string;
  location: string;
  primaryDomain: RiskDomain;
  companyIndex: number;
}

const scenarios: readonly Scenario[] = [
  {
    id: "project-riverline",
    code: "RLTH",
    name: "Riverline Transit Hub",
    descriptor: "Active · Infrastructure",
    type: "Infrastructure-Transportation Building",
    city: "New York",
    value: 685_000_000,
    recordCount: 12,
    rankingActiveIssueTarget: 24,
    highRiskOpen: 9,
    criticalOverdue: 3,
    ciqQuality: "high",
    issueQualityCovered: true,
    rfiRiskCovered: true,
    rfiCauseCovered: true,
    issueSafetyRiskCovered: true,
    issueSafetyHazardCovered: true,
    issueSafetyObservationCovered: true,
    safetyCovered: true,
    submittalCovered: true,
    momentum: "accelerating",
    change7d: 17,
    change28d: 26,
    headline: "Critical-path RFIs are compounding at the concourse handoff.",
    rootCause: "Design Coordination",
    location: "Concourse > Level B1 > East Platform",
    primaryDomain: "rfi",
    companyIndex: 0,
  },
  {
    id: "project-harbor-point",
    code: "HPMC",
    name: "Harbor Point Medical Center",
    descriptor: "Active · Healthcare",
    type: "Healthcare",
    city: "Boston",
    value: 438_000_000,
    recordCount: 11,
    rankingActiveIssueTarget: 24,
    highRiskOpen: 8,
    criticalOverdue: 2,
    ciqQuality: "high",
    issueQualityCovered: true,
    rfiRiskCovered: true,
    rfiCauseCovered: true,
    issueSafetyRiskCovered: true,
    issueSafetyHazardCovered: true,
    issueSafetyObservationCovered: true,
    safetyCovered: true,
    submittalCovered: true,
    momentum: "increasing",
    change7d: 12,
    change28d: 19,
    headline: "Waterproofing risk is recurring across the patient tower envelope.",
    rootCause: "Water Intrusion",
    location: "Patient Tower > Level 06 > East Envelope",
    primaryDomain: "quality",
    companyIndex: 1,
  },
  {
    id: "project-atlas",
    code: "ART",
    name: "Atlas Residential Tower",
    descriptor: "Active · Residential",
    type: "Residential",
    city: "Chicago",
    value: 267_000_000,
    recordCount: 10,
    rankingActiveIssueTarget: 24,
    highRiskOpen: 6,
    criticalOverdue: 0,
    ciqQuality: "medium",
    issueQualityCovered: true,
    rfiRiskCovered: true,
    rfiCauseCovered: false,
    issueSafetyRiskCovered: true,
    issueSafetyHazardCovered: false,
    issueSafetyObservationCovered: true,
    safetyCovered: true,
    submittalCovered: false,
    momentum: "increasing",
    change7d: 5,
    change28d: 11,
    headline: "Facade closeout issues are spreading across three upper levels.",
    rootCause: "Incomplete Documentation",
    location: "Tower A > Level 31 > North Facade",
    primaryDomain: "design",
    companyIndex: 1,
  },
  {
    id: "project-northgate",
    code: "NGA",
    name: "Northgate Academy",
    descriptor: "Active · Institutional",
    type: "Institutional",
    city: "Philadelphia",
    value: 94_000_000,
    recordCount: 9,
    rankingActiveIssueTarget: 24,
    highRiskOpen: 4,
    criticalOverdue: 0,
    ciqQuality: "medium",
    issueQualityCovered: true,
    rfiRiskCovered: true,
    rfiCauseCovered: true,
    issueSafetyRiskCovered: true,
    issueSafetyHazardCovered: true,
    issueSafetyObservationCovered: false,
    safetyCovered: true,
    submittalCovered: false,
    momentum: "increasing",
    change7d: 8,
    change28d: 18,
    headline: "A medium-severity envelope pattern is accelerating before close-in.",
    rootCause: "Water Intrusion",
    location: "Academic Wing > Level 02 > East Classrooms",
    primaryDomain: "quality",
    companyIndex: 1,
  },
  {
    id: "project-cedar",
    code: "CVA",
    name: "Cedar Valley Ambulatory Center",
    descriptor: "Active · Healthcare",
    type: "Healthcare",
    city: "Nashville",
    value: 121_000_000,
    recordCount: 8,
    rankingActiveIssueTarget: 24,
    highRiskOpen: 3,
    criticalOverdue: 0,
    ciqQuality: "medium",
    issueQualityCovered: true,
    rfiRiskCovered: false,
    rfiCauseCovered: true,
    issueSafetyRiskCovered: false,
    issueSafetyHazardCovered: true,
    issueSafetyObservationCovered: true,
    safetyCovered: true,
    submittalCovered: false,
    momentum: "stable",
    change7d: 1,
    change28d: 3,
    headline: "Quality risk is stable, with a small cluster at the imaging suite.",
    rootCause: "Installation Quality",
    location: "Clinical Wing > Level 01 > Imaging Suite",
    primaryDomain: "quality",
    companyIndex: 2,
  },
  {
    id: "project-meridian",
    code: "MDC",
    name: "Meridian Data Campus",
    descriptor: "Active · Commercial",
    type: "Commercial",
    city: "Ashburn",
    value: 512_000_000,
    recordCount: 9,
    rankingActiveIssueTarget: 24,
    highRiskOpen: 4,
    criticalOverdue: 1,
    ciqQuality: "none",
    issueQualityCovered: false,
    rfiRiskCovered: true,
    rfiCauseCovered: false,
    issueSafetyRiskCovered: true,
    issueSafetyHazardCovered: false,
    issueSafetyObservationCovered: true,
    safetyCovered: true,
    submittalCovered: false,
    momentum: "increasing",
    change7d: 4,
    change28d: 7,
    headline: "Unassigned commissioning issues are approaching energized work.",
    rootCause: "Commissioning Readiness",
    location: "Building C > Data Hall 3 > Electrical Gallery",
    primaryDomain: "schedule",
    companyIndex: 3,
  },
  {
    id: "project-parkline",
    code: "PLO",
    name: "Parkline Offices",
    descriptor: "Active · Commercial",
    type: "Commercial",
    city: "Austin",
    value: 183_000_000,
    recordCount: 8,
    rankingActiveIssueTarget: 24,
    highRiskOpen: 2,
    criticalOverdue: 0,
    ciqQuality: "low",
    issueQualityCovered: true,
    rfiRiskCovered: true,
    rfiCauseCovered: true,
    issueSafetyRiskCovered: true,
    issueSafetyHazardCovered: true,
    issueSafetyObservationCovered: false,
    safetyCovered: true,
    submittalCovered: false,
    momentum: "improving",
    change7d: -8,
    change28d: -15,
    headline: "Resolution has exceeded new risk for three consecutive weeks.",
    rootCause: "Workmanship",
    location: "Office Tower > Level 08 > Core",
    primaryDomain: "quality",
    companyIndex: 4,
  },
  {
    id: "project-union",
    code: "UJL",
    name: "Union Justice Laboratory",
    descriptor: "Active · Institutional",
    type: "Institutional",
    city: "Washington",
    value: 156_000_000,
    recordCount: 7,
    rankingActiveIssueTarget: 24,
    highRiskOpen: 2,
    criticalOverdue: 0,
    ciqQuality: "none",
    issueQualityCovered: false,
    rfiRiskCovered: false,
    rfiCauseCovered: false,
    issueSafetyRiskCovered: false,
    issueSafetyHazardCovered: false,
    issueSafetyObservationCovered: false,
    safetyCovered: false,
    submittalCovered: false,
    momentum: "stable",
    change7d: 0,
    change28d: 2,
    headline: "CIQ coverage is not available; operational signals remain visible.",
    rootCause: "Code Compliance",
    location: "Laboratory Wing > Level 03 > Evidence Processing",
    primaryDomain: "design",
    companyIndex: 5,
  },
  {
    id: "project-seaport",
    code: "SRH",
    name: "Seaport Research Hall",
    descriptor: "Active · Institutional",
    type: "Institutional",
    city: "San Diego",
    value: 212_000_000,
    recordCount: 8,
    rankingActiveIssueTarget: null,
    highRiskOpen: 2,
    criticalOverdue: 0,
    ciqQuality: "low",
    issueQualityCovered: true,
    rfiRiskCovered: false,
    rfiCauseCovered: true,
    issueSafetyRiskCovered: false,
    issueSafetyHazardCovered: true,
    issueSafetyObservationCovered: true,
    safetyCovered: true,
    submittalCovered: true,
    momentum: "improving",
    change7d: -5,
    change28d: -9,
    headline: "The MEP coordination backlog is shrinking after focused review.",
    rootCause: "Design Coordination",
    location: "Research Wing > Level 04 > Wet Lab",
    primaryDomain: "coordination",
    companyIndex: 0,
  },
  {
    id: "project-lakeshore",
    code: "LMC",
    name: "Lakeshore Mixed-Use Commons",
    descriptor: "Active · Residential",
    type: "Residential",
    city: "Seattle",
    value: 324_000_000,
    recordCount: 8,
    rankingActiveIssueTarget: null,
    highRiskOpen: 3,
    criticalOverdue: 0,
    ciqQuality: "medium",
    issueQualityCovered: true,
    rfiRiskCovered: true,
    rfiCauseCovered: false,
    issueSafetyRiskCovered: true,
    issueSafetyHazardCovered: false,
    issueSafetyObservationCovered: false,
    safetyCovered: true,
    submittalCovered: false,
    momentum: "stable",
    change7d: 2,
    change28d: 5,
    headline: "Risk is broadly stable, with ownership gaps in the retail podium.",
    rootCause: "Incomplete Documentation",
    location: "Podium > Level 02 > Retail East",
    primaryDomain: "rfi",
    companyIndex: 6,
  },
] as const;

const companies: readonly Company[] = [
  { id: "company-apex-mep", hubId: "hub-demo", name: "Apex MEP Partners", trade: "HVAC | Mechanical Systems", category: "Subcontractor", status: "active" },
  { id: "company-bluewater", hubId: "hub-demo", name: "Bluewater Envelope", trade: "Moisture Protection | Waterproofing", category: "Subcontractor", status: "active" },
  { id: "company-northstar", hubId: "hub-demo", name: "Northstar Interiors", trade: "Finishes | Drywall", category: "Subcontractor", status: "active" },
  { id: "company-voltage", hubId: "hub-demo", name: "Voltage Systems", trade: "Electrical | Mission Critical", category: "Subcontractor", status: "active" },
  { id: "company-keystone", hubId: "hub-demo", name: "Keystone Structures", trade: "Metals | Structural Steel / Framing", category: "Subcontractor", status: "active" },
  { id: "company-civic", hubId: "hub-demo", name: "Civic Design Group", trade: null, category: "Architect", status: "active" },
  { id: "company-cascade", hubId: "hub-demo", name: "Cascade Construction", trade: "General Contractor", category: "General Contractor", status: "active" },
];

const businessUnits: readonly BusinessUnit[] = [
  { id: "buildings", hubId: "hub-demo", parentId: null, name: "Buildings", path: "Buildings" },
  { id: "infrastructure", hubId: "hub-demo", parentId: null, name: "Infrastructure", path: "Infrastructure" },
];

interface FormSignalScenario {
  projectId: string;
  templateId: string;
  layoutUid: string;
  templateName: string;
  domain: "quality" | "safety";
  currentCount: number;
  previousCount: number;
  currentExceptions: number;
  note: string;
}

const formSignalScenarios: readonly FormSignalScenario[] = [
  {
    projectId: "project-harbor-point",
    templateId: "template-envelope-inspection-active",
    layoutUid: "layout-envelope-field",
    templateName: "Building Envelope Inspection",
    domain: "quality",
    currentCount: 6,
    previousCount: 8,
    currentExceptions: 2,
    note: "Exceptions use the configured response dictionary; Autodesk Forms does not publish a conformance score.",
  },
  {
    projectId: "project-riverline",
    templateId: "template-pre-task-safety-plan",
    layoutUid: "layout-pre-task-main",
    templateName: "Pre-task Safety Plan",
    domain: "safety",
    currentCount: 8,
    previousCount: 9,
    currentExceptions: 1,
    note: "Activity change is a leading indicator and does not establish causation.",
  },
  {
    projectId: "project-northgate",
    templateId: "template-waterproofing-observation",
    layoutUid: "layout-waterproofing-main",
    templateName: "Waterproofing Observation",
    domain: "quality",
    currentCount: 5,
    previousCount: 8,
    currentExceptions: 3,
    note: "Question identity may fragment across template revisions until live validation is complete.",
  },
  {
    projectId: "project-harbor-point",
    templateId: "template-envelope-inspection-turnover",
    layoutUid: "layout-envelope-turnover",
    templateName: "Building Envelope Inspection",
    domain: "quality",
    currentCount: 3,
    previousCount: 4,
    currentExceptions: 1,
    note: "A distinct template and layout can share a display name; source identity keeps its activity separate.",
  },
] as const;

function dateBefore(days: number): string {
  return new Date(new Date(DEMO_AS_OF).getTime() - days * DAY_MS).toISOString();
}

function projectFromScenario(scenario: Scenario): Project {
  const domains = RISK_DOMAINS.filter((domain) =>
    (domain !== "safety" || scenario.safetyCovered) &&
    (domain !== "submittal" || scenario.submittalCovered)
  );
  return {
    id: scenario.id,
    hubId: "hub-demo",
    name: scenario.name,
    status: "active",
    currentPhase: scenario.recordCount > 20 ? "Construction" : "Preconstruction",
    type: scenario.type,
    classification: "production",
    businessUnitId: scenario.id.includes("riverline") ? "infrastructure" : "buildings",
    startDate: "2025-02-01",
    endDate: "2027-09-30",
    city: scenario.city,
    country: "United States",
    value: scenario.value,
    currency: "USD",
    memberCount: 80 + scenario.recordCount * 3,
    companyCount: 15 + scenario.companyIndex,
    accessible: true,
    availableDomains: domains,
  };
}

const recordTitles: Readonly<Record<RiskDomain, readonly string[]>> = {
  design: ["Incomplete door hardware coordination", "Code review comments remain unresolved", "Design release missing interface details"],
  rfi: ["RFI response needed before overhead rough-in", "Structural opening dimension unresolved", "Equipment clearance requires design confirmation"],
  quality: ["Water intrusion at curtain wall transition", "Envelope sealant adhesion failure", "Repeated slab edge repair"],
  safety: ["Unprotected access near active work", "Ladder setup observation requires review", "Housekeeping route obstruction"],
  subcontractor: ["Cross-project recurrence requires trade review", "Company-attributed backlog is increasing"],
  submittal: ["Submittal review exceeds required-on-job date", "Resubmission cycle approaching procurement need"],
  coordination: ["Clash-linked issue remains open", "MEP clearance conflict at shared corridor"],
  cost: ["Potential cost impact remains unquantified", "Change relationship requires commercial review"],
  schedule: ["Risk record linked to near-term activity", "Critical-path handoff has unresolved dependency"],
};

function makeRecord(scenario: Scenario, index: number): RiskRecord {
  const availableDomains = projectFromScenario(scenario).availableDomains;
  const domains: RiskDomain[] = [
    scenario.primaryDomain,
    ...availableDomains.filter((domain) => domain !== scenario.primaryDomain),
  ];
  const domain = domains[index % domains.length]!;
  const kind: RiskRecord["kind"] = domain === "rfi" ? "rfi" : domain === "submittal" ? "submittal" : domain === "coordination" ? "clash-group" : domain === "schedule" ? "schedule-activity" : "issue";
  const riskCiqCovered = kind === "issue"
    ? scenario.issueQualityCovered
    : kind === "rfi"
      ? scenario.rfiRiskCovered
      : false;
  const causeCiqCovered = kind === "issue"
    ? scenario.issueQualityCovered
    : kind === "rfi"
      ? scenario.rfiCauseCovered
      : false;
  const open = index < Math.ceil(scenario.recordCount * 0.72);
  const candidateRisk: Severity = index < scenario.highRiskOpen ? "high" : index < scenario.highRiskOpen + 2 ? "medium" : index % 4 === 0 ? "low" : "none";
  const modelCiqRisk: Severity = !riskCiqCovered ? "none" : kind === "issue"
    ? candidateRisk
    : kind === "rfi"
      ? candidateRisk === "high" ? "high" : candidateRisk === "none" ? "none" : "low"
      : "none";
  const hasIssueOverride = kind === "issue" && modelCiqRisk === "high" && index % 5 === 0;
  const constructionIqRisk: Severity = hasIssueOverride ? "low" : modelCiqRisk;
  const hasCostEnumDrift = kind === "rfi" && scenario.id === "project-harbor-point" && index === 2;
  const rfiCostImpact = kind === "rfi" ? (hasCostEnumDrift ? "unmapped" : index % 3 === 0 ? "yes" : index % 3 === 1 ? "unknown" : "no") : null;
  const rfiScheduleImpact = kind === "rfi" ? (index % 2 === 0 ? "yes" : "unknown") : null;
  const iqCostImpact: Severity = scenario.issueQualityCovered && kind === "issue" && modelCiqRisk === "high" && index % 2 === 0 ? "high" : scenario.issueQualityCovered && kind === "issue" && modelCiqRisk === "medium" ? "medium" : "none";
  const company = companies[(scenario.companyIndex + index) % companies.length]!;
  const sourceUnassigned = index % 3 !== 0 || scenario.id === "project-meridian";
  const directCompanyAssignment = kind === "issue" && scenario.id !== "project-meridian" && index % 7 === 0;
  const userAssigned = !directCompanyAssignment && !sourceUnassigned;
  const ownerAttributed = !directCompanyAssignment && !userAssigned && index % 5 === 1;
  const companyAttribution = directCompanyAssignment
    ? "direct"
    : userAssigned
      ? "via-assignee-membership"
      : ownerAttributed
        ? "via-owner-membership"
        : "unattributed";
  const companyId = companyAttribution === "unattributed" ? null : company.id;
  const assigneeId = directCompanyAssignment
    ? company.id
    : userAssigned
      ? `user-${index + 1}`
      : null;
  const assigneeName = directCompanyAssignment
    ? company.name
    : userAssigned
      ? `Synthetic project member ${index + 1}`
      : null;
  const assigneeType = directCompanyAssignment ? "company" : userAssigned ? "user" : null;
  const ownerId = ownerAttributed ? `user-owner-${index}` : null;
  const ownerName = ownerAttributed ? `Synthetic record owner ${index + 1}` : null;
  const createdDays = 6 + ((index * 13 + scenario.companyIndex * 7) % 96);
  const dueDaysAgo = index < scenario.criticalOverdue ? 14 + index * 5 : -12 - index;
  const titlePool = recordTitles[domain];
  const baseTitle = titlePool[index % titlePool.length]!;
  const title = scenario.rootCause === "Water Intrusion" && index < 3 ? `Water intrusion recurrence — ${scenario.location.split(" > ").at(-1)}` : baseTitle;
  const locationPath = index % 3 === 0
    ? scenario.location
    : scenario.location.replace(/East|North/g, index % 2 ? "West" : "South");
  const locationKey = locationPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  const rootCause = kind === "issue" ? scenario.rootCause : null;
  const rootCauseId = rootCause ? `${scenario.id}-root-cause-${slug(rootCause)}` : null;
  const discipline = domain === "rfi" || domain === "coordination"
    ? (index % 2 ? "Mechanical" : "Architectural")
    : null;
  const disciplineOrigin = discipline
    ? (kind === "rfi" && scenario.rfiCauseCovered && index % 4 < 2 ? "construction-iq" as const : "operational" as const)
    : null;
  const rfiCategory = kind === "rfi" ? trimmedCanonicalText(scenario.rootCause) : null;
  const iqRootCauseModel = causeCiqCovered
    ? trimmedCanonicalText(scenario.rootCause === "Water Intrusion" ? "Documentation Incomplete" : scenario.rootCause)
    : null;
  const iqRootCauseUserOverridden = kind === "issue" && iqRootCauseModel !== null && index % 6 === 0;
  const iqRootCause = iqRootCauseUserOverridden
    ? (iqRootCauseModel === "Other" ? "Design Coordination" : "Other")
    : iqRootCauseModel;
  const buildingComponentModel = causeCiqCovered
    ? trimmedCanonicalText(scenario.rootCause === "Water Intrusion" ? "Building Envelope" : domain === "rfi" ? "Mechanical Systems" : "Interior Construction")
    : null;
  const buildingComponentUserOverridden = kind === "issue" && buildingComponentModel !== null && index % 7 === 0;
  const buildingComponent = buildingComponentUserOverridden
    ? (buildingComponentModel === "Building Envelope" ? "Roofing" : "Building Envelope")
    : buildingComponentModel;
  const safetyPrediction = kind === "issue" && domain === "safety"
    ? dateBefore(Math.max(0, createdDays - 1))
    : null;
  const iqSafetyRiskCategory = safetyPrediction && scenario.issueSafetyRiskCovered
    ? safetyRiskCategoryFromConstructionIq(index % 2 ? "other" : "caught_inbetween")
    : null;
  const iqSafetyHazardCategory = safetyPrediction && scenario.issueSafetyHazardCovered && index % 3 === 0
    ? trimmedCanonicalText("ladder")
    : null;
  const iqSafetyObservationCategory = safetyPrediction && scenario.issueSafetyObservationCovered
    ? safetyObservationCategoryFromConstructionIq(index % 2 === 0 ? "negative" : "positive")
    : null;
  return {
    kind,
    id: `${scenario.code.toLowerCase()}-${kind}-${index + 1}`,
    projectId: scenario.id,
    displayId: `${kind === "rfi" ? "RFI" : kind === "submittal" ? "SUB" : "ISS"}-${210 + index}`,
    title,
    status: open ? (index % 2 ? "open" : "in_progress") : "closed",
    open,
    domain,
    constructionIqModelRisk: modelCiqRisk,
    constructionIqRisk,
    riskUserOverridden: hasIssueOverride,
    rfiCategory,
    iqSafetyRiskCategory,
    iqSafetyRiskPredictedAt: iqSafetyRiskCategory ? safetyPrediction : null,
    iqSafetyHazardCategory,
    iqSafetyHazardPredictedAt: iqSafetyHazardCategory ? safetyPrediction : null,
    iqSafetyObservationCategory,
    iqSafetyObservationPredictedAt: iqSafetyObservationCategory ? safetyPrediction : null,
    typeName: domain === "quality" ? "Quality" : domain === "safety" ? "Safety" : "Coordination",
    subtypeName: scenario.rootCause,
    rootCauseId,
    rootCause,
    rootCauseCategory: domain === "design" || domain === "rfi" ? "Design" : "Execution",
    iqRootCauseModel,
    iqRootCause,
    iqRootCauseUserOverridden,
    discipline,
    disciplineOrigin,
    buildingComponentModel,
    buildingComponent,
    buildingComponentUserOverridden,
    locationId: kind === "submittal" ? null : `${scenario.id}-location-${locationKey}`,
    locationPath: kind === "submittal" ? null : locationPath,
    companyId,
    companyAttribution,
    assigneeId,
    assigneeName,
    assigneeType,
    ownerId,
    ownerName,
    createdAt: dateBefore(createdDays),
    updatedAt: dateBefore(index % 3 === 0 ? 42 : Math.max(1, createdDays - 4)),
    dueDate: index % 5 === 2 ? null : dateBefore(dueDaysAgo),
    closedAt: open ? null : dateBefore(Math.max(1, index % 10)),
    respondedAt: (kind === "rfi" || kind === "submittal") && !open ? dateBefore(Math.max(2, index % 12)) : null,
    costImpact: rfiCostImpact,
    scheduleImpact: rfiScheduleImpact,
    iqCostImpact,
    raw: {
      bim360_project_id: scenario.id,
      issue_id: kind === "issue" ? `${scenario.code.toLowerCase()}-${kind}-${index + 1}` : null,
      id: kind !== "issue" ? `${scenario.code.toLowerCase()}-${kind}-${index + 1}` : null,
      status: open ? "open" : "closed",
      assignee_id: assigneeId,
      assignee_type: assigneeType,
      owner_id: ownerId,
      root_cause_id: rootCauseId,
      risk: riskCiqCovered && modelCiqRisk !== "none" ? modelCiqRisk : null,
      user_risk: hasIssueOverride ? "low" : null,
      category_name: rfiCategory,
      root_cause: iqRootCauseModel,
      user_root_cause: iqRootCauseUserOverridden ? iqRootCause : null,
      building_component: buildingComponentModel,
      user_building_component: buildingComponentUserOverridden ? buildingComponent : null,
      discipline: disciplineOrigin === "operational" ? discipline : null,
      iq_discipline: disciplineOrigin === "construction-iq" ? discipline : null,
      safety_risk_category: iqSafetyRiskCategory,
      safety_risk_predicted_at: iqSafetyRiskCategory ? safetyPrediction : null,
      safety_hazard_category: iqSafetyHazardCategory,
      safety_hazard_predicted_at: iqSafetyHazardCategory ? safetyPrediction : null,
      safety_observation_category: iqSafetyObservationCategory,
      safety_observation_predicted_at: iqSafetyObservationCategory ? safetyPrediction : null,
      cost_impact: kind === "rfi" ? (hasCostEnumDrift ? "Pending validation" : rfiCostImpact) : null,
      schedule_impact: kind === "rfi" ? rfiScheduleImpact : null,
      priority: kind === "rfi" ? (index % 2 === 0 ? "High" : "Normal") : null,
      score: kind === "rfi" ? index % 3 : null,
      required_on_job_date: kind === "submittal" ? dateBefore(-14 - (index % 10)) : null,
      lead_time: kind === "submittal" ? 30 : null,
      revision: kind === "submittal" ? 2 + (index % 3) : null,
      is_critical: kind === "schedule-activity" && scenario.id === "project-riverline",
      source_shape: "synthetic mirror of Data Connector fields",
    },
  };
}

function makeRankingPopulationIssue(scenario: Scenario, index: number): RiskRecord {
  const id = `${scenario.code.toLowerCase()}-issue-baseline-${index + 1}`;
  const locationKey = scenario.location
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return {
    kind: "issue",
    id,
    projectId: scenario.id,
    displayId: `ISS-${610 + index}`,
    title: "Routine field observation — ranking population baseline",
    status: "open",
    open: true,
    domain: "quality",
    constructionIqModelRisk: "none",
    constructionIqRisk: "none",
    riskUserOverridden: false,
    rfiCategory: null,
    iqSafetyRiskCategory: null,
    iqSafetyRiskPredictedAt: null,
    iqSafetyHazardCategory: null,
    iqSafetyHazardPredictedAt: null,
    iqSafetyObservationCategory: null,
    iqSafetyObservationPredictedAt: null,
    typeName: "Quality",
    subtypeName: "Routine observation",
    rootCauseId: null,
    rootCause: null,
    rootCauseCategory: null,
    iqRootCauseModel: null,
    iqRootCause: null,
    iqRootCauseUserOverridden: false,
    discipline: null,
    disciplineOrigin: null,
    buildingComponentModel: null,
    buildingComponent: null,
    buildingComponentUserOverridden: false,
    locationId: `${scenario.id}-location-${locationKey}`,
    locationPath: scenario.location,
    companyId: null,
    companyAttribution: "unattributed",
    assigneeId: null,
    assigneeName: null,
    assigneeType: null,
    ownerId: null,
    ownerName: null,
    createdAt: dateBefore(1 + (index % 5)),
    updatedAt: dateBefore(index % 2),
    dueDate: dateBefore(-30 - (index % 14)),
    closedAt: null,
    respondedAt: null,
    costImpact: null,
    scheduleImpact: null,
    iqCostImpact: "none",
    raw: {
      bim360_project_id: scenario.id,
      issue_id: id,
      id: null,
      status: "open",
      assignee_id: null,
      assignee_type: null,
      owner_id: null,
      risk: null,
      user_risk: null,
      safety_risk_category: null,
      safety_hazard_category: null,
      safety_observation_category: null,
      safety_observation_predicted_at: null,
      cost_impact: null,
      schedule_impact: null,
      priority: null,
      score: null,
      source_shape: "synthetic active-issue population for ranking normalization",
    },
  };
}

function makeSafetyObservationRecord(index: number): RiskRecord {
  const ciqCoveredScenarios = scenarios.filter((candidate) => candidate.issueSafetyObservationCovered);
  const scenario = ciqCoveredScenarios[index % ciqCoveredScenarios.length]!;
  const category = index % 3 === 0 ? "negative" : "positive";
  const observedDaysAgo = (index * 5) % 28;
  const id = `${scenario.code.toLowerCase()}-safety-observation-${index + 1}`;
  return {
    kind: "issue",
    id,
    projectId: scenario.id,
    displayId: `SAFE-${710 + index}`,
    title: `${category === "positive" ? "Positive" : "Negative"} safety observation — synthetic balance fixture`,
    status: "closed",
    open: false,
    domain: "safety",
    constructionIqModelRisk: "none",
    constructionIqRisk: "none",
    riskUserOverridden: false,
    rfiCategory: null,
    iqSafetyRiskCategory: null,
    iqSafetyRiskPredictedAt: null,
    iqSafetyHazardCategory: null,
    iqSafetyHazardPredictedAt: null,
    iqSafetyObservationCategory: category,
    iqSafetyObservationPredictedAt: dateBefore(observedDaysAgo),
    typeName: "Safety",
    subtypeName: "Safety Observation",
    rootCauseId: null,
    rootCause: null,
    rootCauseCategory: null,
    iqRootCauseModel: null,
    iqRootCause: null,
    iqRootCauseUserOverridden: false,
    discipline: null,
    disciplineOrigin: null,
    buildingComponentModel: null,
    buildingComponent: null,
    buildingComponentUserOverridden: false,
    locationId: `${scenario.id}-location-${slug(scenario.location)}`,
    locationPath: scenario.location,
    companyId: null,
    companyAttribution: "unattributed",
    assigneeId: null,
    assigneeName: null,
    assigneeType: null,
    ownerId: null,
    ownerName: null,
    createdAt: dateBefore(observedDaysAgo + 1),
    updatedAt: dateBefore(observedDaysAgo),
    dueDate: null,
    closedAt: dateBefore(observedDaysAgo),
    respondedAt: null,
    costImpact: null,
    scheduleImpact: null,
    iqCostImpact: "none",
    raw: {
      bim360_project_id: scenario.id,
      issue_id: id,
      status: "closed",
      safety_observation_category: category,
      safety_observation_predicted_at: dateBefore(observedDaysAgo),
      risk: null,
      user_risk: null,
      cost_impact: null,
      schedule_impact: null,
      priority: null,
      score: null,
      source_shape: "synthetic mirror of iq_issues_safety_observations joined to issues",
    },
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function makeFormRecord(
  signal: FormSignalScenario,
  index: number,
  period: "current" | "previous",
): RiskRecord {
  const scenario = scenarios.find((candidate) => candidate.id === signal.projectId);
  if (!scenario) throw new Error(`Missing synthetic project ${signal.projectId}.`);
  const daysAgo = period === "current" ? 2 + index * 3 : 31 + index * 3;
  const createdAt = dateBefore(daysAgo);
  const exception = period === "current"
    ? index < signal.currentExceptions
    : index % 4 === 0;
  const locationPath = scenario.location;
  const company = companies[(scenario.companyIndex + index) % companies.length]!;
  const templateKey = slug(signal.templateId);
  const layoutKey = slug(signal.layoutUid);
  const id = `${scenario.code.toLowerCase()}-form-${templateKey}-${layoutKey}-${period}-${index + 1}`;
  return {
    kind: "form",
    id,
    projectId: scenario.id,
    displayId: `FORM-${310 + index}`,
    title: `${signal.templateName} — ${period === "current" ? "current" : "prior"} period`,
    status: "submitted",
    open: false,
    domain: signal.domain,
    constructionIqModelRisk: "none",
    constructionIqRisk: "none",
    riskUserOverridden: false,
    rfiCategory: null,
    iqSafetyRiskCategory: null,
    iqSafetyRiskPredictedAt: null,
    iqSafetyHazardCategory: null,
    iqSafetyHazardPredictedAt: null,
    iqSafetyObservationCategory: null,
    iqSafetyObservationPredictedAt: null,
    typeName: "Form",
    subtypeName: signal.templateName,
    rootCauseId: null,
    rootCause: null,
    rootCauseCategory: null,
    iqRootCauseModel: null,
    iqRootCause: null,
    iqRootCauseUserOverridden: false,
    discipline: null,
    disciplineOrigin: null,
    buildingComponentModel: null,
    buildingComponent: null,
    buildingComponentUserOverridden: false,
    locationId: `${scenario.id}-location-${slug(locationPath)}`,
    locationPath,
    companyId: company.id,
    companyAttribution: "via-owner-membership",
    assigneeId: null,
    assigneeName: null,
    assigneeType: null,
    ownerId: `user-form-owner-${scenario.code.toLowerCase()}-${company.id}`,
    ownerName: `Synthetic form owner · ${company.name}`,
    createdAt,
    updatedAt: createdAt,
    dueDate: null,
    closedAt: null,
    respondedAt: createdAt,
    costImpact: null,
    scheduleImpact: null,
    iqCostImpact: "none",
    raw: {
      bim360_project_id: scenario.id,
      form_id: id,
      native_form_id: id,
      template_id: signal.templateId,
      layout_uid: signal.layoutUid,
      last_submitted_at: createdAt,
      template_name: signal.templateName,
      period_bucket: period,
      application_defined_exception: exception,
      status: "submitted",
      risk: null,
      user_risk: null,
      cost_impact: null,
      schedule_impact: null,
      priority: null,
      score: null,
      source_shape: "synthetic mirror of Forms Data Connector fields",
    },
  };
}

function makeReviewRecord(scenario: Scenario, index: number): RiskRecord {
  const open = index % 3 !== 2;
  const createdAt = dateBefore(18 + index * 9);
  const locationPath = scenario.location;
  const company = companies[(scenario.companyIndex + 5) % companies.length]!;
  const id = `${scenario.code.toLowerCase()}-review-${index + 1}`;
  return {
    kind: "review",
    id,
    projectId: scenario.id,
    displayId: `REV-${410 + index}`,
    title: `Design package review — ${scenario.location.split(" > ")[0]}`,
    status: open ? "in_review" : "closed",
    open,
    domain: "design",
    constructionIqModelRisk: "none",
    constructionIqRisk: "none",
    riskUserOverridden: false,
    rfiCategory: null,
    iqSafetyRiskCategory: null,
    iqSafetyRiskPredictedAt: null,
    iqSafetyHazardCategory: null,
    iqSafetyHazardPredictedAt: null,
    iqSafetyObservationCategory: null,
    iqSafetyObservationPredictedAt: null,
    typeName: "Design review",
    subtypeName: "Coordination package",
    rootCauseId: null,
    rootCause: null,
    rootCauseCategory: null,
    iqRootCauseModel: null,
    iqRootCause: null,
    iqRootCauseUserOverridden: false,
    discipline: "Architectural",
    disciplineOrigin: "operational",
    buildingComponentModel: null,
    buildingComponent: null,
    buildingComponentUserOverridden: false,
    locationId: `${scenario.id}-location-${slug(locationPath)}`,
    locationPath,
    companyId: company.id,
    companyAttribution: "via-owner-membership",
    assigneeId: `user-reviewer-${index + 1}`,
    assigneeName: `Synthetic reviewer ${index + 1}`,
    assigneeType: "user",
    ownerId: `user-review-owner-${index + 1}`,
    ownerName: `Synthetic review owner ${index + 1}`,
    createdAt,
    updatedAt: dateBefore(3 + index),
    dueDate: dateBefore(-10 - index),
    closedAt: open ? null : dateBefore(5),
    respondedAt: null,
    costImpact: null,
    scheduleImpact: null,
    iqCostImpact: "none",
    raw: {
      bim360_project_id: scenario.id,
      review_id: id,
      round_number: 1 + index,
      sequence_id: index + 1,
      status: open ? "in_review" : "closed",
      risk: null,
      user_risk: null,
      cost_impact: null,
      schedule_impact: null,
      priority: null,
      score: null,
      source_shape: "synthetic mirror of Reviews Data Connector fields",
    },
  };
}

function ordinal(severity: Severity): number | null {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  if (severity === "low") return 1;
  return null;
}

function recordTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isActiveAt(record: RiskRecord, asOf: string): boolean {
  const asOfTimestamp = new Date(asOf).getTime();
  const createdAt = recordTimestamp(record.createdAt);
  const closedAt = recordTimestamp(
    record.kind === "submittal" || record.kind === "form" ? record.respondedAt : record.closedAt,
  );
  return createdAt !== null && createdAt <= asOfTimestamp &&
    (closedAt === null || closedAt > asOfTimestamp);
}

function isClassifiedSeverity(severity: Severity): boolean {
  return severity === "critical" || severity === "high" ||
    severity === "medium" || severity === "low";
}

function isEffectiveHigh(record: RiskRecord): boolean {
  return record.constructionIqRisk === "critical" ||
    record.constructionIqRisk === "high";
}

function isOverdueAt(record: RiskRecord, asOf: string): boolean {
  if (record.kind !== "issue" && record.kind !== "rfi" && record.kind !== "submittal") return false;
  const dueAt = recordTimestamp(record.dueDate);
  return dueAt !== null && dueAt < new Date(asOf).getTime();
}

function isCriticalOverdueAt(record: RiskRecord, asOf: string): boolean {
  if (!isOverdueAt(record, asOf)) return false;
  if (isEffectiveHigh(record)) return true;
  return record.kind === "submittal" &&
    typeof record.raw?.revision === "number" && record.raw.revision >= 2;
}

function evidenceFromRecords(
  records: readonly RiskRecord[],
  asOf = DEMO_AS_OF,
  maximum = 4,
): readonly EvidenceRef[] {
  const unique = [...new Map(records.map((record) => [recordIdentityKey(record), record])).values()];
  const ranked = unique.sort((left, right) => {
    const score = (record: RiskRecord) =>
      (isEffectiveHigh(record) ? 100 : record.constructionIqRisk === "medium" ? 60 : record.constructionIqRisk === "low" ? 25 : 0) +
      (isCriticalOverdueAt(record, asOf) ? 50 : isOverdueAt(record, asOf) ? 20 : 0) +
      (hasSupportedSafetySignal(record) ? 10 : 0);
    return score(right) - score(left) || left.id.localeCompare(right.id);
  });
  return ranked.slice(0, maximum).map((record) => ({
    kind: record.kind,
    id: record.id,
    projectId: record.projectId,
    label: record.displayId ?? record.title,
  }));
}

function allEvidenceFromRecords(
  records: readonly RiskRecord[],
  asOf = DEMO_AS_OF,
): readonly EvidenceRef[] {
  return evidenceFromRecords(records, asOf, Number.MAX_SAFE_INTEGER);
}

function trendObservations(index: number, scenario: Scenario): readonly ObservedSeriesPoint[] {
  const end = new Date(`${DEMO_AS_OF.slice(0, 10)}T00:00:00.000Z`).getTime();
  const start = new Date(`${DEMO_COVERAGE_START}T00:00:00.000Z`).getTime();
  const totalDays = Math.floor((end - start) / DAY_MS);
  const offsets = new Set<number>([0, 7, 14, 21, 28, totalDays]);
  for (let offset = 35; offset < totalDays; offset += 7) offsets.add(offset);

  const valueAtOffset = (offset: number): number => {
    let value: number;
    if (offset <= 7) {
      value = index - scenario.change7d * (offset / 7);
    } else if (offset <= 28) {
      const atSeven = index - scenario.change7d;
      const atTwentyEight = index - scenario.change28d;
      value = atSeven + (atTwentyEight - atSeven) * ((offset - 7) / 21);
    } else {
      const baseline = index - scenario.change28d;
      const wave = Math.sin((offset - 28 + scenario.companyIndex * 5) / 18) * 2;
      const historicalDrift = scenario.momentum === "accelerating"
        ? -Math.min(8, (offset - 28) / 24)
        : scenario.momentum === "improving"
          ? Math.min(6, (offset - 28) / 30)
          : 0;
      value = baseline + wave + historicalDrift;
    }
    return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
  };

  return [...offsets]
    .map((offset) => ({
      date: new Date(end - offset * DAY_MS).toISOString().slice(0, 10),
      value: valueAtOffset(offset),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function domainConditionAt(records: readonly RiskRecord[], asOf: string): {
  index: number | null;
  openRecords: number;
  classifiedOpenRecords: number;
  severityPoints: number;
  overdueDenominatorRecords: number;
  overdueRecords: number;
  coverage: number;
} {
  const openRecords = records.filter((record) => isActiveAt(record, asOf));
  const classified = openRecords.filter((record) =>
    isConstructionIqRiskApplicable(record) && isClassifiedSeverity(record.constructionIqRisk)
  );
  const severityPoints = classified.reduce((sum, record) => {
    if (record.constructionIqRisk === "critical" || record.constructionIqRisk === "high") return sum + 1;
    if (record.constructionIqRisk === "medium") return sum + 0.6;
    return sum + 0.25;
  }, 0);
  const overdueRecords = openRecords.filter((record) => isOverdueAt(record, asOf)).length;
  const severityShare = classified.length ? severityPoints / classified.length : null;
  const overdueShare = openRecords.length ? overdueRecords / openRecords.length : null;
  const availableWeight = (severityShare === null ? 0 : 0.75) + (overdueShare === null ? 0 : 0.25);
  const coverage = availableWeight;
  const index = severityShare === null && overdueShare === null
    ? null
    : Math.round(1000 * (0.75 * (severityShare ?? 0) + 0.25 * (overdueShare ?? 0))) / 10;
  return { index, openRecords: openRecords.length, classifiedOpenRecords: classified.length, severityPoints, overdueDenominatorRecords: openRecords.length, overdueRecords, coverage };
}

function domainSummaries(
  project: Project,
  projectRecords: readonly RiskRecord[],
): readonly DomainSummary[] {
  const currentAsOf = DEMO_AS_OF;
  const previousAsOf = new Date(new Date(DEMO_AS_OF).getTime() - 7 * DAY_MS).toISOString();
  return RISK_DOMAINS.map((domain) => {
    const available = project.availableDomains.includes(domain);
    const records = projectRecords.filter((record) => record.domain === domain);
    const hasDomainCiqClassification = (record: RiskRecord): boolean =>
      isConstructionIqRiskApplicable(record) && isClassifiedSeverity(record.constructionIqRisk);
    const current = domainConditionAt(records, currentAsOf);
    const previous = domainConditionAt(records, previousAsOf);
    const highRiskRecords = records.filter((record) => record.open && isEffectiveHigh(record) && hasDomainCiqClassification(record));
    const overdueRecords = records.filter((record) => record.open && isOverdueAt(record, currentAsOf));
    const criticalOverdue = records.filter((record) =>
      record.open && isCriticalOverdueAt(record, currentAsOf)
    ).length;
    const index = available ? current.index : null;
    const severity = !available || index === null
      ? "none"
      : severityFromRiskIndex(index, criticalOverdue, "none", current.openRecords);
    const contributingRecords = records.filter((record) => isActiveAt(record, currentAsOf));
    return {
      domain,
      label: RISK_DOMAIN_LABEL[domain],
      severity,
      index,
      highRiskOpen: highRiskRecords.length,
      overdue: overdueRecords.length,
      criticalOverdue,
      momentum: available && current.index !== null && previous.index !== null
        ? Math.round((current.index - previous.index) * 10) / 10
        : null,
      available,
      source: contributingRecords.some(hasDomainCiqClassification)
        ? "autodesk"
        : "derived",
      evidence: allEvidenceFromRecords(contributingRecords, currentAsOf),
      calculation: {
        formula: "risk.domain.condition",
        asOf: currentAsOf,
        previousAsOf,
        openRecords: current.openRecords,
        classifiedOpenRecords: current.classifiedOpenRecords,
        severityPoints: current.severityPoints,
        overdueDenominatorRecords: current.overdueDenominatorRecords,
        overdueRecords: current.overdueRecords,
        coverage: current.coverage,
        currentIndex: current.index,
        previousIndex: previous.index,
      },
    };
  });
}

function buildProjectSummary(scenario: Scenario, records: readonly RiskRecord[], relationships: readonly RiskRelationship[]): ProjectRiskSummary {
  const projectRecords = records.filter((record) => record.projectId === scenario.id);
  const project = projectFromScenario(scenario);
  const openRecords = projectRecords.filter((record) => record.open);
  const openIssues = openRecords.filter((record) => record.kind === "issue");
  const highRiskRecords = openRecords.filter(isEffectiveHigh);
  const highRiskIssues = openIssues.filter(isEffectiveHigh);
  const overduePopulation = openRecords.filter((record) =>
    record.kind === "issue" || record.kind === "rfi" || record.kind === "submittal"
  );
  const overdueRecords = overduePopulation.filter((record) => isOverdueAt(record, DEMO_AS_OF));
  const criticalOverdueRecords = openRecords.filter((record) =>
    isCriticalOverdueAt(record, DEMO_AS_OF)
  );
  const safetySignalRecords = openIssues.filter(hasSupportedSafetySignal);
  const classifiedRfis = projectRecords.filter((record) =>
    record.kind === "rfi" && isClassifiedSeverity(record.constructionIqRisk)
  );
  const highRiskRfis = classifiedRfis.filter(isEffectiveHigh);
  const persistentHighRisk = highRiskRecords.filter((record) =>
    new Date(DEMO_AS_OF).getTime() - new Date(record.createdAt).getTime() > 30 * DAY_MS
  );
  const highRiskDensity = per100Active(highRiskIssues.length, openIssues.length);
  const overdueDensity = per100Active(overdueRecords.length, overduePopulation.length);
  const safetyDensity = project.availableDomains.includes("safety") && safetySignalRecords.length >= 5
    ? per100Active(safetySignalRecords.length, openIssues.length)
    : null;
  const riskInputs = {
    constructionIqQuality: ordinal(scenario.ciqQuality),
    highRiskPer100: scenario.issueQualityCovered ? highRiskDensity.value : null,
    overduePer100: overdueDensity.value,
    safetySignalsPer100: safetyDensity?.value ?? null,
    rfiHighShare: scenario.rfiRiskCovered ? (classifiedRfis.length ? highRiskRfis.length / classifiedRfis.length : null) : null,
    persistenceOver30Share: scenario.issueQualityCovered || scenario.rfiRiskCovered ? (highRiskRecords.length
      ? persistentHighRisk.length / highRiskRecords.length
      : null) : null,
  };
  const riskResult = calculateRiskIndex(riskInputs);
  const rankingInputs = {
    ...riskInputs,
    highRiskPer100: scenario.issueQualityCovered ? highRiskDensity.rankingValue : null,
    overduePer100: overdueDensity.rankingValue,
    safetySignalsPer100: safetyDensity?.rankingValue ?? null,
  };
  const rankingRiskResult = calculateRiskIndex(rankingInputs);
  const rankingHasLowSample = [highRiskDensity, overdueDensity, safetyDensity]
    .some((normalization) => normalization?.lowSample === true);
  const rankingCiqCovered = scenario.ciqQuality !== "none";
  const rankingEligible = rankingCiqCovered && !rankingHasLowSample && !rankingRiskResult.suppressed;
  const index = riskResult.value;
  const severity = severityFromRiskIndex(
    riskResult.value,
    criticalOverdueRecords.length,
    scenario.ciqQuality,
    highRiskRecords.length,
  );
  const riskValue = riskDimension(
    index,
    severity,
    highRiskRecords.length,
    criticalOverdueRecords.length,
    scenario.ciqQuality,
  );
  const projectRelationships = relationships.filter((edge) => edge.projectId === scenario.id);
  const scheduleExposure = scheduleExposureFromRecords(projectRecords, projectRelationships);
  const riskPopulation = scheduleExposure.eligibleRiskRecords;
  const allLocations = new Set(projectRecords.map((record) => record.locationId).filter(Boolean));
  const allCompanies = new Set(projectRecords.map((record) => record.companyId).filter(Boolean));
  const locations = new Set(riskPopulation.map((record) => record.locationId).filter(Boolean)).size;
  const affectedCompanies = new Set(riskPopulation.map((record) => record.companyId).filter(Boolean)).size;
  const confirmedCostImpact = projectRecords.filter((record) => record.open && ((record.kind === "rfi" && record.costImpact === "yes") || (record.kind === "issue" && record.iqCostImpact === "high"))).length;
  const potentialCostExposure = projectRecords.filter((record) => record.open && ((record.kind === "rfi" && record.costImpact === "unknown") || (record.kind === "issue" && record.iqCostImpact === "medium"))).length;
  const costEligibleRecords = projectRecords.filter((record) => record.open && (record.kind === "issue" || record.kind === "rfi"));
  const linkedRiskKeys = new Set(scheduleExposure.scheduleLinkedRiskRecords.map(recordIdentityKey));
  const criticalLinkedRiskKeys = new Set(scheduleExposure.criticalPathLinkedRiskRecords.map(recordIdentityKey));
  const exposureInputs = {
    scope: "project",
    locationsShare: riskPopulation.length && allLocations.size ? locations / allLocations.size : null,
    companiesShare: riskPopulation.length && allCompanies.size ? affectedCompanies / allCompanies.size : null,
    confirmedCostShare: costEligibleRecords.length ? confirmedCostImpact / costEligibleRecords.length : null,
    scheduleLinkedShare: riskPopulation.length ? riskPopulation.filter((record) => linkedRiskKeys.has(recordIdentityKey(record))).length / riskPopulation.length : null,
    criticalPathLinkedShare: riskPopulation.length ? riskPopulation.filter((record) => criticalLinkedRiskKeys.has(recordIdentityKey(record))).length / riskPopulation.length : null,
    projectsAffectedShare: null,
    scheduleEdgeCount: scheduleExposure.confirmedScheduleEdgeCount,
  } as const;
  const exposureResult = calculateExposureIndex(exposureInputs);
  const exposureIndex = exposureResult.value;
  const exposureValue: ExposureDimension = {
    index: exposureIndex,
    locationsAffected: locations,
    companiesAffected: affectedCompanies,
    projectsAffected: riskPopulation.length ? 1 : 0,
    confirmedCostImpact,
    potentialCostExposure,
    unquantifiedCostImpact: confirmedCostImpact + potentialCostExposure,
    scheduleLinkedItems: scheduleExposure.scheduleLinkedRiskRecords.length,
    criticalPathLinkedItems: scheduleExposure.criticalPathLinkedRiskRecords.length,
  };
  const observations = index === null ? [] : trendObservations(index, scenario);
  const trend = forwardFillDailySeries(observations, DEMO_COVERAGE_START, DEMO_AS_OF.slice(0, 10));
  const momentumValue = calculateMomentum(trend);
  const windowStart = new Date(DEMO_AS_OF).getTime() - 28 * DAY_MS;
  const inCurrentWindow = (value: string | null): boolean => {
    const timestamp = recordTimestamp(value);
    return timestamp !== null && timestamp >= windowStart && timestamp <= new Date(DEMO_AS_OF).getTime();
  };
  const createdHighRisk = projectRecords.filter((record) =>
    isEffectiveHigh(record) && inCurrentWindow(record.createdAt)
  ).length;
  const resolvedHighRisk = projectRecords.filter((record) =>
    isEffectiveHigh(record) && inCurrentWindow(record.closedAt)
  ).length;
  const momentum: MomentumDimension = {
    ...momentumValue,
    newHighRiskRate: createdHighRisk / 4,
    resolvedHighRiskRate: resolvedHighRisk / 4,
  };
  const timestamp = DEMO_AS_OF;
  const riskContributorRecords = [
    ...highRiskRecords,
    ...criticalOverdueRecords,
    ...(riskInputs.safetySignalsPer100 === null ? [] : safetySignalRecords),
    ...highRiskRfis,
    ...persistentHighRisk,
  ];
  const exposureContributorKeys = new Set([
    ...riskPopulation.map(recordIdentityKey),
    ...linkedRiskKeys,
    ...criticalLinkedRiskKeys,
  ]);
  const exposureContributorRecords = projectRecords.filter((record) =>
    exposureContributorKeys.has(recordIdentityKey(record)) ||
    (record.open && record.kind === "rfi" && record.costImpact !== "no") ||
    (record.open && record.kind === "issue" && (record.iqCostImpact === "high" || record.iqCostImpact === "medium"))
  );
  const momentumContributorRecords = projectRecords.filter((record) =>
    isEffectiveHigh(record) && (inCurrentWindow(record.createdAt) || inCurrentWindow(record.closedAt))
  );
  const riskEvidence = evidenceFromRecords(riskContributorRecords);
  const exposureEvidence = evidenceFromRecords(exposureContributorRecords);
  const momentumEvidence = evidenceFromRecords(momentumContributorRecords.length ? momentumContributorRecords : riskContributorRecords);
  const riskMetric = measured(riskValue, derivedProvenance({ sourceSystem: "demo-generator", sourceDataset: "demo-risk-engine", projectId: project.id, timestamp, definitionId: "risk.index" }), riskEvidence);
  const exposureMetric = measured(exposureValue, derivedProvenance({ sourceSystem: "demo-generator", sourceDataset: "demo-risk-engine", projectId: project.id, timestamp, definitionId: "exposure.index" }), exposureEvidence);
  const momentumMetric = measured(momentum, derivedProvenance({ sourceSystem: "demo-generator", sourceDataset: "demo-snapshots", projectId: project.id, timestamp, definitionId: "momentum.direction" }), momentumEvidence);
  const ciqQuality = scenario.ciqQuality === "none" ? null : measured(
    { level: scenario.ciqQuality, observedAt: "2026-09-05T04:00:00.000Z", forwardFilled: true },
    autodeskProvenance({
      sourceSystem: "demo-generator",
      sourceDataset: "iq_project_daily_quality_risk_changes",
      sourceRecordId: `synthetic-project-quality-${project.id}`,
      projectId: project.id,
      timestamp,
      definitionId: "ciq.project.quality.daily-risk",
      autodeskTerm: "Project Daily Risk Changes",
    }),
  );
  return {
    project,
    code: scenario.code,
    descriptor: scenario.descriptor,
    risk: riskMetric,
    exposure: exposureMetric as Measured<ExposureDimension>,
    momentum: momentumMetric,
    ciqQuality,
    dimensions: { risk: riskMetric, exposure: exposureMetric as Measured<ExposureDimension>, momentum: momentumMetric },
    trend,
    domainSummaries: domainSummaries(project, projectRecords),
    coverage: { covered: project.availableDomains.length, total: RISK_DOMAINS.length, notApplicable: RISK_DOMAINS.length - project.availableDomains.length },
    burnRate: burnRateFromRecords(projectRecords, DEMO_AS_OF, 28, "all", project.id, "demo-generator"),
    actionabilityIndex: actionabilityIndex(projectRecords, DEMO_AS_OF),
    ciqObservedAt: ciqQuality?.value.observedAt ?? null,
    ciqForwardFilled: ciqQuality?.value.forwardFilled ?? false,
    narrative: scenario.headline,
    calculation: {
      risk: {
        definitionId: "risk.index",
        inputs: riskInputs,
        value: riskResult.value,
        coverage: riskResult.coverage,
        availableWeight: riskResult.availableWeight,
        missing: riskResult.missing,
        suppressed: riskResult.suppressed,
        evidenceRecordKeys: allEvidenceFromRecords(riskContributorRecords).map(recordIdentityKey),
        evidenceRecords: allEvidenceFromRecords(riskContributorRecords),
        normalizations: {
          highRiskPer100: highRiskDensity,
          overduePer100: overdueDensity,
          safetySignalsPer100: safetyDensity,
        },
        ranking: {
          inputs: rankingInputs,
          value: rankingEligible ? rankingRiskResult.value : null,
          coverage: rankingRiskResult.coverage,
          availableWeight: rankingRiskResult.availableWeight,
          missing: rankingRiskResult.missing,
          suppressed: !rankingEligible,
          eligible: rankingEligible,
          exclusionReason: !rankingCiqCovered
            ? "ciq-unavailable"
            : rankingHasLowSample
              ? "low-sample"
              : rankingRiskResult.suppressed
                ? "insufficient-coverage"
                : null,
          cohort: rankingCiqCovered ? "ciq-covered" : "ciq-unavailable",
        },
      },
      exposure: {
        definitionId: "exposure.index",
        inputs: exposureInputs,
        value: exposureResult.value,
        coverage: exposureResult.coverage,
        availableWeight: exposureResult.availableWeight,
        missing: exposureResult.missing,
        suppressed: exposureResult.suppressed,
        evidenceRecordKeys: allEvidenceFromRecords(exposureContributorRecords).map(recordIdentityKey),
        evidenceRecords: allEvidenceFromRecords(exposureContributorRecords),
      },
    },
  };
}

function relationship(id: number, from: RiskRecord, to: RiskRecord, method: RiskRelationship["method"], serviceOwned: boolean): RiskRelationship {
  return {
    id: `relationship-demo-${id}`,
    projectId: from.projectId,
    from: { kind: from.kind, id: from.id, projectId: from.projectId, label: from.displayId ?? from.title },
    to: { kind: to.kind, id: to.id, projectId: to.projectId, label: to.displayId ?? to.title },
    confidence: method === "shared-location-window" ? "inferred" : "confirmed",
    method,
    evidence: method === "acc-relationship-service" ? "A relationship edge exists in the Autodesk relationship service." : method === "clash-group-issue-id" ? "The assigned clash group carries this issue ID." : "Records share a location and reporting window; association is inferred.",
    serviceOwned,
    createdAt: dateBefore(35 - id),
    snapshotDate: DEMO_AS_OF.slice(0, 10),
    deletedAt: null,
    algorithmVersion: RISK_CONFIGURATION_ID,
    provenance: derivedProvenance({
      sourceSystem: "demo-generator",
      sourceDataset: method === "acc-relationship-service" ? "relationships_entity_relationship" : method === "clash-group-issue-id" ? "clashes_assigned_clash_group" : "canonical-risk-records",
      projectId: from.projectId,
      timestamp: DEMO_AS_OF,
      definitionId: method.startsWith("shared-") ? `relationship.inferred.${method}` : `relationship.confirmed.${method}`,
    }),
  };
}

function buildRelationships(records: readonly RiskRecord[]): readonly RiskRelationship[] {
  const output: RiskRelationship[] = [];
  for (const scenario of scenarios.slice(0, 6)) {
    const items = records.filter((record) => record.projectId === scenario.id);
    const issue = items.find((record) => record.kind === "issue") ?? items[0];
    const rfi = items.find((record) => record.kind === "rfi") ?? items[1];
    if (issue && rfi) output.push(relationship(output.length + 1, issue, rfi, "acc-relationship-service", output.length % 2 === 0));
  }
  const river = records.filter((record) => record.projectId === "project-riverline");
  const riverRfi = river.find((record) => record.kind === "rfi");
  const riverSchedule = river.find((record) => record.kind === "schedule-activity");
  const harbor = records.filter((record) => record.projectId === "project-harbor-point");
  const harborIssue = harbor.find((record) => record.kind === "issue");
  const harborClash = harbor.find((record) => record.kind === "clash-group");
  if (riverRfi && riverSchedule) output.push(relationship(output.length + 1, riverRfi, riverSchedule, "acc-relationship-service", false));
  if (harborIssue && harborClash) output.push(relationship(output.length + 1, harborClash, harborIssue, "clash-group-issue-id", true));
  const northgate = records.filter((record) => record.projectId === "project-northgate");
  const inferredIssue = northgate.find((record) => record.kind === "issue");
  const inferredRfi = northgate.find((record) => record.kind === "rfi");
  if (inferredIssue && inferredRfi) {
    output.push(relationship(output.length + 1, inferredIssue, inferredRfi, "shared-location-window", false));
  }
  const parkline = records.filter((record) => record.projectId === "project-parkline");
  const candidateIssue = parkline.find((record) => record.kind === "issue");
  const candidatePeer = parkline.find((record) => record.kind === "issue" && record.id !== candidateIssue?.id);
  if (candidateIssue && candidatePeer) {
    const candidate = relationship(output.length + 1, candidateIssue, candidatePeer, "shared-location-window", false);
    output.push({
      ...candidate,
      confidence: "none",
      evidence: "Candidate proximity did not meet the application threshold; no relationship is asserted.",
    });
  }
  return output;
}

function average(values: readonly number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function aggregateProjectTrend(
  projects: readonly ProjectRiskSummary[],
): ReturnType<typeof forwardFillDailySeries> {
  return aggregateFilledSeriesByDate(projects.map((project) => project.trend));
}

export function generateDemoDataset(): DemoDataset {
  const riskRecords = scenarios.flatMap((scenario) =>
    Array.from({ length: scenario.recordCount }, (_, index) => makeRecord(scenario, index))
  );
  const rankingPopulationRecords = scenarios.flatMap((scenario) => {
    if (scenario.rankingActiveIssueTarget === null) return [];
    const existingOpenIssues = riskRecords.filter((record) =>
      record.projectId === scenario.id && record.kind === "issue" && record.open
    ).length;
    const missing = Math.max(0, scenario.rankingActiveIssueTarget - existingOpenIssues);
    return Array.from({ length: missing }, (_, index) => makeRankingPopulationIssue(scenario, index));
  });
  const formRecords = formSignalScenarios.flatMap((signal) => [
    ...Array.from({ length: signal.currentCount }, (_, index) => makeFormRecord(signal, index, "current")),
    ...Array.from({ length: signal.previousCount }, (_, index) => makeFormRecord(signal, index, "previous")),
  ]);
  const reviewRecords = [scenarios[0], scenarios[2], scenarios[5], scenarios[9]]
    .filter((scenario): scenario is Scenario => scenario !== undefined)
    .map((scenario, index) => makeReviewRecord(scenario, index));
  const safetyObservationRecords = Array.from({ length: 24 }, (_, index) => makeSafetyObservationRecord(index));
  const records: readonly RiskRecord[] = [
    ...riskRecords,
    ...rankingPopulationRecords,
    ...formRecords,
    ...reviewRecords,
    ...safetyObservationRecords,
  ];
  const locations = buildDemoLocationNodes(records);
  const relationships = buildRelationships(records);
  const projects = scenarios.map((scenario) => buildProjectSummary(scenario, records, relationships));
  const projectMap = new Map(projects.map((summary) => [summary.project.id, summary]));
  const companyMap = new Map(companies.map((company) => [company.id, company]));
  const projectNames = new Map(projects.map((summary) => [summary.project.id, summary.project.name]));
  const ciqSourceCoverage = {
    issueQualityProjectIds: scenarios
      .filter((scenario) => scenario.issueQualityCovered)
      .map((scenario) => scenario.id),
    rfiRiskProjectIds: scenarios
      .filter((scenario) => scenario.rfiRiskCovered)
      .map((scenario) => scenario.id),
    rfiCauseProjectIds: scenarios
      .filter((scenario) => scenario.rfiCauseCovered)
      .map((scenario) => scenario.id),
    issueSafetyRiskProjectIds: scenarios
      .filter((scenario) => scenario.issueSafetyRiskCovered)
      .map((scenario) => scenario.id),
    issueSafetyHazardProjectIds: scenarios
      .filter((scenario) => scenario.issueSafetyHazardCovered)
      .map((scenario) => scenario.id),
    issueSafetyObservationProjectIds: scenarios
      .filter((scenario) => scenario.issueSafetyObservationCovered)
      .map((scenario) => scenario.id),
    issueSafetyProjectIds: scenarios
      .filter((scenario) => scenario.issueSafetyRiskCovered || scenario.issueSafetyHazardCovered || scenario.issueSafetyObservationCovered)
      .map((scenario) => scenario.id),
  } as const;
  const recurrence = RECURRENCE_DIMENSIONS.flatMap((dimension) =>
    recurrenceGroups(records, dimension, DEMO_AS_OF, 180, "demo-generator")
  );
  const locationHotspots = hotspots(records, projectNames, DEMO_AS_OF, "demo-generator", locations);
  const leafLocationKeys = new Set(records.flatMap((record) =>
    record.locationId ? [demoLocationIdentityKey(record.projectId, record.locationId)] : []
  ));
  const recurringRecordKeys = attentionRecurringRecordKeys(records, DEMO_AS_OF, "demo-generator");
  const hotspotRecordKeys = new Set<string>();
  for (const project of projects) {
    const ranked = locationHotspots.filter((hotspot) =>
      hotspot.projectId === project.project.id &&
      leafLocationKeys.has(demoLocationIdentityKey(hotspot.projectId, hotspot.locationId))
    ).sort((a, b) => a.overlapScore - b.overlapScore);
    const threshold = ranked[Math.floor(Math.max(0, ranked.length - 1) * 0.9)]?.overlapScore;
    for (const hotspot of ranked.filter((entry) => threshold !== undefined && entry.overlapScore >= threshold && entry.domains.length >= 2)) {
      for (const evidence of hotspot.evidence) hotspotRecordKeys.add(recordIdentityKey(evidence));
    }
  }
  const attention = records.filter((record) => record.open).map((record, index) => {
    const summary = projectMap.get(record.projectId)!;
    const incidentEdges = relationships.filter((edge) => edge.confidence === "confirmed" && (sameRecordIdentity(edge.from, record) || sameRecordIdentity(edge.to, record)));
    const related = incidentEdges.map((edge) => ({
      edge,
      other: sameRecordIdentity(edge.from, record) ? edge.to : edge.from,
    }));
    const scheduleLinks = related.filter(({ other }) => other.kind === "schedule-activity");
    const relevantHumanEdge = related.some(({ edge, other }) => !edge.serviceOwned && (other.kind === "schedule-activity" || other.kind === "change-order" || other.kind === "rfi" || other.kind === "issue"));
    return calculateAttentionItem(record, {
      projectName: summary.project.name,
      companyName: record.companyId ? companyMap.get(record.companyId)?.name : null,
      asOf: DEMO_AS_OF,
      projectMomentum: summary.momentum.value.change7d === null ? null : summary.momentum.value.direction,
      recurring: recurringRecordKeys.has(recordIdentityKey(record)),
      hotspot: hotspotRecordKeys.has(recordIdentityKey(record)),
      safetyCategory: record.iqSafetyRiskCategory?.trim() || null,
      safetyHazard: Boolean(record.iqSafetyHazardCategory?.trim()),
      negativeSafetyObservation: record.iqSafetyObservationCategory === "negative",
      rfiPriority: typeof record.raw?.priority === "string" ? record.raw.priority : null,
      rfiScoreBand: record.kind === "rfi" && (record.raw?.score === 0 || record.raw?.score === 1 || record.raw?.score === 2) ? record.raw.score : null,
      submittalRequiredOnJobAt: typeof record.raw?.required_on_job_date === "string" ? record.raw.required_on_job_date : null,
      submittalLeadTimeDays: typeof record.raw?.lead_time === "number" ? record.raw.lead_time : null,
      submittalRevision: typeof record.raw?.revision === "number" ? record.raw.revision : null,
      stale: Boolean(record.updatedAt && new Date(DEMO_AS_OF).getTime() - new Date(record.updatedAt).getTime() > 30 * 86_400_000),
      clashLinked: incidentEdges.some((edge) => edge.method === "clash-group-issue-id"),
      scheduleLinked: scheduleLinks.length > 0,
      criticalPathLinked: scheduleLinks.some(({ other }) => {
        const activity = records.find((candidate) => sameRecordIdentity(candidate, other));
        return activity?.raw?.is_critical_path === true || activity?.raw?.is_critical === true;
      }),
      scheduleSupportingEdgeCount: summary.calculation.exposure.inputs.scheduleEdgeCount,
      costLinked: related.some(({ other }) => other.kind === "change-order"),
      rfiLinked: incidentEdges.some((edge) => new Set([edge.from.kind, edge.to.kind]).has("rfi") && new Set([edge.from.kind, edge.to.kind]).has("issue")),
      userCreatedEdge: relevantHumanEdge,
    });
  }).sort((a, b) => b.rawScore - a.rawScore);
  const highOpen = records.filter((record) => record.open && isEffectiveHigh(record));
  const criticalOverdue = records.filter((record) =>
    record.open && isCriticalOverdueAt(record, DEMO_AS_OF)
  );
  const recordByKey = new Map(records.map((record) => [recordIdentityKey(record), record]));
  const riskEvidenceRecords = projects
    .flatMap((project) => project.calculation.risk.evidenceRecords)
    .map((reference) => recordByKey.get(recordIdentityKey(reference)))
    .filter((record): record is RiskRecord => record !== undefined);
  const exposureEvidenceRecords = projects
    .flatMap((project) => project.calculation.exposure.evidenceRecords)
    .map((reference) => recordByKey.get(recordIdentityKey(reference)))
    .filter((record): record is RiskRecord => record !== undefined);
  const portfolioRiskEvidence = evidenceFromRecords(riskEvidenceRecords, DEMO_AS_OF, 8);
  const portfolioExposureEvidence = evidenceFromRecords(exposureEvidenceRecords, DEMO_AS_OF, 8);
  const projectRiskIndexes = projects.flatMap((project) => project.risk.value.index === null ? [] : [{
    projectId: project.project.id,
    value: project.risk.value.index,
  }]);
  const projectExposureIndexes = projects.flatMap((project) => project.exposure.value.index === null ? [] : [{
    projectId: project.project.id,
    value: project.exposure.value.index,
  }]);
  const portfolioRiskIndex = average(projectRiskIndexes.map((entry) => entry.value));
  const portfolioExposureIndex = average(projectExposureIndexes.map((entry) => entry.value));
  if (portfolioRiskIndex === null || portfolioExposureIndex === null) {
    throw new Error("Synthetic portfolio indices unexpectedly have no project population.");
  }
  const portfolioTrend = aggregateProjectTrend(projects);
  const portfolioMomentum = calculateMomentum(portfolioTrend);
  const portfolioScheduleExposure = scheduleExposureFromRecords(records, relationships);
  const portfolioRisk = measured(
    riskDimension(
      portfolioRiskIndex,
      severityFromRiskIndex(portfolioRiskIndex, criticalOverdue.length, "none", highOpen.length),
      highOpen.length,
      criticalOverdue.length,
    ),
    derivedProvenance({ sourceSystem: "demo-generator", sourceDataset: "demo-project-risk-summaries", timestamp: DEMO_AS_OF, definitionId: "risk.portfolio.mean-project-index" }),
    portfolioRiskEvidence,
  );
  const portfolioExposure = measured<ExposureDimension>(
    {
      index: portfolioExposureIndex,
      locationsAffected: new Set(records.filter((record) => record.open).map((record) => record.locationId).filter(Boolean)).size,
      companiesAffected: new Set(records.filter((record) => record.open).map((record) => record.companyId).filter(Boolean)).size,
      projectsAffected: projects.filter((project) => project.risk.value.severity === "critical" || project.risk.value.severity === "high").length,
      confirmedCostImpact: records.filter((record) => record.open && ((record.kind === "rfi" && record.costImpact === "yes") || (record.kind === "issue" && record.iqCostImpact === "high"))).length,
      potentialCostExposure: records.filter((record) => record.open && ((record.kind === "rfi" && record.costImpact === "unknown") || (record.kind === "issue" && record.iqCostImpact === "medium"))).length,
      unquantifiedCostImpact: records.filter((record) => record.open && ((record.kind === "rfi" && (record.costImpact === "yes" || record.costImpact === "unknown")) || (record.kind === "issue" && (record.iqCostImpact === "high" || record.iqCostImpact === "medium")))).length,
      scheduleLinkedItems: portfolioScheduleExposure.scheduleLinkedRiskRecords.length,
      criticalPathLinkedItems: portfolioScheduleExposure.criticalPathLinkedRiskRecords.length,
    },
    derivedProvenance({ sourceSystem: "demo-generator", sourceDataset: "demo-project-risk-summaries", timestamp: DEMO_AS_OF, definitionId: "exposure.portfolio.mean-project-index" }),
    portfolioExposureEvidence,
  );
  const portfolioMomentumMetric = measured<MomentumDimension>(
    {
      ...portfolioMomentum,
      newHighRiskRate: projects.reduce((sum, project) => sum + project.momentum.value.newHighRiskRate, 0),
      resolvedHighRiskRate: projects.reduce((sum, project) => sum + project.momentum.value.resolvedHighRiskRate, 0),
    },
    derivedProvenance({ sourceSystem: "demo-generator", sourceDataset: "demo-project-risk-series", timestamp: DEMO_AS_OF, definitionId: "momentum.portfolio.mean-project-series" }),
    portfolioRiskEvidence,
  );
  const portfolioCalculation = {
    risk: {
      definitionId: "risk.portfolio.mean-project-index",
      inputs: {
        aggregation: "arithmetic-mean-of-project-risk-index" as const,
        projectIndexes: projectRiskIndexes,
      },
      value: portfolioRiskIndex,
      coverage: projectRiskIndexes.length / scenarios.length,
      availableWeight: projectRiskIndexes.length ? 1 : 0,
      missing: projects.filter((project) => project.risk.value.index === null).map((project) => project.project.id),
      suppressed: projects.length === 0,
      evidenceRecordKeys: allEvidenceFromRecords(riskEvidenceRecords).map(recordIdentityKey),
      evidenceRecords: allEvidenceFromRecords(riskEvidenceRecords),
    },
    exposure: {
      definitionId: "exposure.portfolio.mean-project-index",
      inputs: {
        aggregation: "arithmetic-mean-of-project-exposure-index" as const,
        projectIndexes: projectExposureIndexes,
      },
      value: portfolioExposureIndex,
      coverage: projects.length / scenarios.length,
      availableWeight: projects.length ? 1 : 0,
      missing: [] as readonly string[],
      suppressed: projects.length === 0,
      evidenceRecordKeys: allEvidenceFromRecords(exposureEvidenceRecords).map(recordIdentityKey),
      evidenceRecords: allEvidenceFromRecords(exposureEvidenceRecords),
    },
    momentum: {
      definitionId: "momentum.portfolio.mean-project-series",
      aggregation: "arithmetic-mean-of-project-risk-series" as const,
      projectIds: projects.map((project) => project.project.id),
      evidenceRecordKeys: allEvidenceFromRecords(riskEvidenceRecords).map(recordIdentityKey),
      evidenceRecords: allEvidenceFromRecords(riskEvidenceRecords),
    },
  };
  const formSignals = formSignalScenarios.map((signal) => {
    const matching = records.filter((record) => formRecordMatchesSignal(record, signal));
    const current = matching.filter((record) => record.raw?.period_bucket === "current");
    const previous = matching.filter((record) => record.raw?.period_bucket === "previous");
    const activityChange = previous.length
      ? Math.round((1_000 * (current.length - previous.length)) / previous.length) / 10
      : 0;
    return {
      projectId: signal.projectId,
      templateId: signal.templateId,
      layoutUid: signal.layoutUid,
      templateName: signal.templateName,
      domain: signal.domain,
      period: "Last 28 days",
      inspections: current.length,
      applicationDefinedExceptions: current.filter((record) =>
        record.raw?.application_defined_exception === true
      ).length,
      activityChange,
      note: signal.note,
      evidence: allEvidenceFromRecords(current),
      provenance: derivedProvenance({
        sourceSystem: "demo-generator",
        sourceDataset: "demo-form-records",
        projectId: signal.projectId,
        timestamp: DEMO_AS_OF,
        definitionId: "form.activity-signal",
      }),
    };
  });
  const concentrations = {
    company: concentration(highOpen, "company", companies, DEMO_AS_OF, "demo-generator"),
    trade: concentration(highOpen, "trade", companies, DEMO_AS_OF, "demo-generator"),
    "root-cause": concentration(highOpen, "root-cause", companies, DEMO_AS_OF, "demo-generator"),
    discipline: concentration(highOpen, "discipline", companies, DEMO_AS_OF, "demo-generator"),
  };
  const companyCiqSignals = scenarios.map((scenario, index) => {
    const company = companies[scenario.companyIndex % companies.length]!;
    const projectCiqEligible = scenario.ciqQuality !== "none";
    const hasQuality = projectCiqEligible;
    const hasSafety = projectCiqEligible && index < 2;
    const qualityObservedAt = index % 2 === 0 ? "2026-08-20" : DEMO_AS_OF.slice(0, 10);
    const safetyObservedAt = index === 0 ? "2026-08-18" : DEMO_AS_OF.slice(0, 10);
    return {
      companyId: company.id,
      projectId: scenario.id,
      snapshotDate: DEMO_AS_OF.slice(0, 10),
      quality: hasQuality ? {
        dailyRisk: index % 3 === 1 ? "Medium" : "Low",
        dailyIndicator: index % 3 === 1 ? 3 : index % 2,
        observedAt: qualityObservedAt,
        forwardFilled: qualityObservedAt !== DEMO_AS_OF.slice(0, 10),
        provenance: autodeskProvenance({
          sourceSystem: "demo-generator",
          sourceDataset: "iq_company_daily_quality_risk_changes",
          sourceRecordId: `synthetic-company-quality-${scenario.id}-${company.id}`,
          projectId: scenario.id,
          timestamp: qualityObservedAt,
          definitionId: "ciq.company.quality.daily-risk",
          autodeskTerm: "Company Daily Risk",
        }),
      } : null,
      safety: hasSafety ? {
        dailyRisk: index === 0 ? 1 : 0,
        dailyIndicator: index === 0 ? 1 : 0,
        observedAt: safetyObservedAt,
        forwardFilled: safetyObservedAt !== DEMO_AS_OF.slice(0, 10),
        provenance: autodeskProvenance({
          sourceSystem: "demo-generator",
          sourceDataset: "iq_company_daily_safety_risk_changes",
          sourceRecordId: `synthetic-company-safety-${scenario.id}-${company.id}`,
          projectId: scenario.id,
          timestamp: safetyObservedAt,
          definitionId: "ciq.company.safety.daily-risk",
          autodeskTerm: "Company Daily Safety Risk",
        }),
      } : null,
      notApplicable: !projectCiqEligible,
    };
  });
  const lineage: DemoLineageEntry[] = [
    {
      id: "portfolio:risk",
      category: "portfolio",
      label: "Portfolio risk",
      value: portfolioRisk.value,
      provenance: portfolioRisk.provenance,
      evidence: portfolioCalculation.risk.evidenceRecords,
      inputs: portfolioCalculation.risk.inputs,
    },
    {
      id: "portfolio:exposure",
      category: "portfolio",
      label: "Portfolio exposure",
      value: portfolioExposure.value,
      provenance: portfolioExposure.provenance,
      evidence: portfolioCalculation.exposure.evidenceRecords,
      inputs: portfolioCalculation.exposure.inputs,
    },
    {
      id: "portfolio:momentum",
      category: "portfolio",
      label: "Portfolio momentum",
      value: portfolioMomentumMetric.value,
      provenance: portfolioMomentumMetric.provenance,
      evidence: portfolioCalculation.momentum.evidenceRecords,
      inputs: { aggregation: portfolioCalculation.momentum.aggregation, projectIds: portfolioCalculation.momentum.projectIds },
    },
  ];
  for (const summary of projects) {
    const projectRecords = records.filter((record) => record.projectId === summary.project.id);
    lineage.push(
      {
        id: `project:${summary.project.id}:risk`,
        category: "project",
        label: `${summary.project.name} risk`,
        value: summary.risk.value,
        provenance: summary.risk.provenance,
        evidence: summary.calculation.risk.evidenceRecords,
        inputs: { ...summary.calculation.risk.inputs, ranking: summary.calculation.risk.ranking },
      },
      {
        id: `project:${summary.project.id}:exposure`,
        category: "project",
        label: `${summary.project.name} exposure`,
        value: summary.exposure.value,
        provenance: summary.exposure.provenance,
        evidence: summary.calculation.exposure.evidenceRecords,
        inputs: summary.calculation.exposure.inputs,
      },
      {
        id: `project:${summary.project.id}:momentum`,
        category: "project",
        label: `${summary.project.name} momentum`,
        value: summary.momentum.value,
        provenance: summary.momentum.provenance,
        evidence: summary.calculation.risk.evidenceRecords,
        inputs: { observationCount: summary.trend.filter((point) => point.observed).length, seriesDays: summary.trend.length },
      },
      {
        id: `project:${summary.project.id}:actionability`,
        category: "project",
        label: `${summary.project.name} actionability`,
        value: summary.actionabilityIndex,
        provenance: derivedProvenance({ sourceSystem: "demo-generator", sourceDataset: "demo-risk-records", projectId: summary.project.id, timestamp: DEMO_AS_OF, definitionId: "actionability.index" }),
        evidence: allEvidenceFromRecords(projectRecords.filter((record) => record.open && ["high", "medium"].includes(record.constructionIqRisk))),
        inputs: { openHighOrMedium: projectRecords.filter((record) => record.open && ["high", "medium"].includes(record.constructionIqRisk)).length },
      },
      {
        id: `project:${summary.project.id}:burn`,
        category: "analytics",
        label: `${summary.project.name} burn rate`,
        value: summary.burnRate,
        provenance: summary.burnRate.provenance,
        evidence: allEvidenceFromRecords(burnEligibleRecords(projectRecords)),
        inputs: { periodDays: summary.burnRate.periodDays, population: "issue|rfi|submittal|clash-group|form" },
      },
    );
    if (summary.ciqQuality) {
      lineage.push({
        id: `ciq-project-quality:${summary.project.id}`,
        category: "project",
        label: `${summary.project.name} Construction IQ quality risk`,
        value: summary.ciqQuality.value,
        provenance: summary.ciqQuality.provenance,
        evidence: [],
        inputs: { observedAt: summary.ciqQuality.value.observedAt, forwardFilled: summary.ciqQuality.value.forwardFilled },
      });
    }
    for (const domain of summary.domainSummaries) {
      const contributors = projectRecords.filter((record) =>
        record.domain === domain.domain && record.open &&
        (["critical", "high", "medium", "low"].includes(record.constructionIqRisk) || isOverdueAt(record, DEMO_AS_OF))
      );
      lineage.push({
        id: `domain:${summary.project.id}:${domain.domain}`,
        category: "domain",
        label: `${summary.project.name} · ${domain.label}`,
        value: { index: domain.index, severity: domain.severity, highRiskOpen: domain.highRiskOpen, overdue: domain.overdue, criticalOverdue: domain.criticalOverdue },
        provenance: derivedProvenance({ sourceSystem: "demo-generator", sourceDataset: "demo-risk-records", projectId: summary.project.id, timestamp: DEMO_AS_OF, definitionId: "risk.domain.condition" }),
        evidence: allEvidenceFromRecords(contributors),
        inputs: { ...domain.calculation },
      });
    }
  }
  for (const item of attention) {
    lineage.push({ id: `attention:${item.id}`, category: "attention", label: item.title, value: { score: item.score, priority: item.priority }, provenance: item.provenance, evidence: item.evidence, inputs: { rawScore: item.rawScore, reasons: item.reasons } });
  }
  for (const bucket of Object.values(concentrations).flat()) {
    lineage.push({ id: `concentration:${bucket.dimension}:${bucket.key}`, category: "analytics", label: `${bucket.label} concentration`, value: { count: bucket.count, shareOfTotal: bucket.shareOfTotal, projectsAffected: bucket.projectsAffected }, provenance: bucket.provenance, evidence: bucket.evidence, inputs: { dimension: bucket.dimension, eligiblePopulation: highOpen.length } });
  }
  for (const group of recurrence) {
    lineage.push({ id: group.id, category: "analytics", label: `${group.label} recurrence`, value: { occurrences: group.occurrences, recurrenceRate: group.recurrenceRate }, provenance: group.provenance, evidence: group.evidence, inputs: { dimension: group.dimension, windowDays: 180 } });
  }
  for (const hotspot of locationHotspots) {
    lineage.push({ id: `hotspot:${hotspot.projectId}:${hotspot.locationId}`, category: "analytics", label: `${hotspot.path} overlap`, value: { overlapScore: hotspot.overlapScore, domainCounts: hotspot.domainCounts }, provenance: hotspot.provenance, evidence: hotspot.evidence, inputs: { domains: hotspot.domains, totalHighRisk: hotspot.totalHighRisk } });
  }
  for (const signal of formSignals) {
    lineage.push({ id: `form:${formSignalIdentityKey(signal)}`, category: "form", label: `${signal.templateName} activity`, value: { inspections: signal.inspections, exceptions: signal.applicationDefinedExceptions, activityChange: signal.activityChange }, provenance: signal.provenance, evidence: signal.evidence, inputs: { period: signal.period, projectId: signal.projectId, templateId: signal.templateId, layoutUid: signal.layoutUid } });
  }
  for (const signal of companyCiqSignals) {
    if (signal.quality) lineage.push({ id: `ciq-company-quality:${signal.projectId}:${signal.companyId}`, category: "analytics", label: "Company Construction IQ quality risk", value: signal.quality, provenance: signal.quality.provenance, evidence: [], inputs: { observedAt: signal.quality.observedAt, forwardFilled: signal.quality.forwardFilled } });
    if (signal.safety) lineage.push({ id: `ciq-company-safety:${signal.projectId}:${signal.companyId}`, category: "analytics", label: "Company Construction IQ safety risk", value: signal.safety, provenance: signal.safety.provenance, evidence: [], inputs: { observedAt: signal.safety.observedAt, forwardFilled: signal.safety.forwardFilled, scale: "undocumented" } });
  }
  const syntheticLocationNodeCount = locations.length;
  return {
    mode: "demo",
    asOf: DEMO_AS_OF,
    coverageStart: DEMO_COVERAGE_START,
    hub: { id: "hub-demo", name: "Forma Enterprise Portfolio", region: "US" },
    portfolio: { risk: portfolioRisk, exposure: portfolioExposure, momentum: portfolioMomentumMetric },
    projects,
    companies,
    businessUnits,
    locations,
    records,
    attention,
    concentrations,
    recurrence,
    hotspots: locationHotspots,
    relationships,
    portfolioTrend,
    burnHistory: [
      { week: "Aug 5", created: 29, resolved: 24, backlog: 79 },
      { week: "Aug 12", created: 31, resolved: 27, backlog: 83 },
      { week: "Aug 19", created: 34, resolved: 29, backlog: 88 },
      { week: "Aug 26", created: 38, resolved: 27, backlog: 99 },
      { week: "Sep 2", created: 42, resolved: 28, backlog: 113 },
    ],
    formSignals,
    companyCiqSignals,
    ciqSourceCoverage,
    lineage,
    ingestion: {
      id: "ingestion-demo-2026-09-08",
      source: "demo-generator",
      startedAt: "2026-09-08T04:00:00.000Z",
      completedAt: "2026-09-08T04:02:14.000Z",
      projectId: null,
      rowsProcessed: records.length,
      failures: 0,
      warnings: ["2 projects have no synthetic project-daily Construction IQ quality coverage", "1 synthetic enum routed to unmapped"],
      sourceExtractedAt: "2026-09-08T03:58:00.000Z",
      status: "complete",
    },
    columnReport: [
      { table: "issues_issues", column: "issue_id", mappedTo: "RiskRecord.id", nonNullRows: records.filter((record) => record.kind === "issue").length, note: "Primary key is issue_id, not id." },
      { table: "issues_issues", column: "root_cause_id", mappedTo: "RiskRecord.rootCauseId", nonNullRows: records.filter((record) => record.kind === "issue" && record.rootCauseId).length, note: "Project-scoped identity; cross-project grouping uses the versioned title dictionary." },
      { table: "iq_issues_quality_risks", column: "risk", mappedTo: "RiskRecord.constructionIqRisk", nonNullRows: records.filter((record) => record.kind === "issue" && record.raw?.risk !== null).length, note: "Synthetic values mirror high/medium/low casing." },
      { table: "iq_issues_quality_risks", column: "user_risk", mappedTo: "RiskRecord.riskUserOverridden", nonNullRows: records.filter((record) => record.kind === "issue" && record.riskUserOverridden).length, note: "Human override takes precedence." },
      { table: "iq_issues_safety_risk", column: "safety_risk_category", mappedTo: "RiskRecord.iqSafetyRiskCategory", nonNullRows: records.filter((record) => record.kind === "issue" && record.iqSafetyRiskCategory !== null).length, note: "Documented category normalized to a stable key; unexpected nonblank values remain unmapped." },
      { table: "iq_issues_safety_hazard", column: "safety_hazard_category", mappedTo: "RiskRecord.iqSafetyHazardCategory", nonNullRows: records.filter((record) => record.kind === "issue" && record.iqSafetyHazardCategory !== null).length, note: "Undocumented category is trimmed but not reinterpreted." },
      { table: "iq_issues_safety_observations", column: "safety_observation_category", mappedTo: "RiskRecord.iqSafetyObservationCategory", nonNullRows: records.filter((record) => record.kind === "issue" && record.iqSafetyObservationCategory !== null).length, note: "Observed positive/negative values are normalized; other nonblank values remain unmapped." },
      { table: "iq_design_issues_root_cause", column: "root_cause", mappedTo: "RiskRecord.iqRootCauseModel", nonNullRows: records.filter((record) => record.kind === "issue" && record.iqRootCauseModel !== null).length, note: "Model output is retained separately from its effective user-overridden value." },
      { table: "iq_design_issues_root_cause", column: "user_root_cause", mappedTo: "RiskRecord.iqRootCause + iqRootCauseUserOverridden", nonNullRows: records.filter((record) => record.kind === "issue" && record.iqRootCauseUserOverridden).length, note: "Nonblank user value takes precedence while preserving the model value." },
      { table: "iq_design_issues_building_components", column: "building_component", mappedTo: "RiskRecord.buildingComponentModel", nonNullRows: records.filter((record) => record.kind === "issue" && record.buildingComponentModel !== null).length, note: "Model output is retained separately from its effective user-overridden value." },
      { table: "iq_design_issues_building_components", column: "user_building_component", mappedTo: "RiskRecord.buildingComponent + buildingComponentUserOverridden", nonNullRows: records.filter((record) => record.kind === "issue" && record.buildingComponentUserOverridden).length, note: "Nonblank user value takes precedence while preserving the model value." },
      { table: "locations_nodes", column: "name", mappedTo: "LocationNode.name", nonNullRows: syntheticLocationNodeCount, note: "Tier is derived from depth and name pattern." },
      { table: "rfis_discipline", column: "discipline", mappedTo: "RiskRecord.discipline + disciplineOrigin", nonNullRows: records.filter((record) => record.kind === "rfi" && record.disciplineOrigin === "operational").length, note: "Operational/project-configured values remain separate from CIQ predictions." },
      { table: "iq_rfis_disciplines", column: "discipline", mappedTo: "RiskRecord.discipline + disciplineOrigin", nonNullRows: records.filter((record) => record.kind === "rfi" && record.disciplineOrigin === "construction-iq").length, note: "Construction IQ-predicted values retain their origin." },
      { table: "rfis_rfis", column: "cost_impact", mappedTo: "RiskRecord.costImpact", nonNullRows: records.filter((record) => record.kind === "rfi" && record.costImpact !== null).length, note: `${records.filter((record) => record.kind === "rfi" && record.costImpact === "unmapped").length} unexpected value retained as unmapped; never coerced to Unknown or No.` },
      { table: "rfis_rfis", column: "category_name", mappedTo: "RiskRecord.rfiCategory", nonNullRows: records.filter((record) => record.kind === "rfi" && record.rfiCategory !== null).length, note: "Project-configured category is trimmed and kept distinct from CIQ-predicted causes." },
    ],
    disclosures: RISK_DISCLOSURES.map((disclosure) => `${disclosure.title}: ${disclosure.detail}`),
    portfolioCalculation,
  };
}

let singleton: DemoDataset | undefined;

export function getDemoDataset(): DemoDataset {
  singleton ??= generateDemoDataset();
  return singleton;
}
