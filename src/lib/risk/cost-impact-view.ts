import {
  recordIdentityKey,
  type EvidenceRef,
  type MetricProvenance,
  type RecordIdentity,
  type RiskRecord,
  type SourceSystem,
} from "../canonical/types";
import { derivedProvenance } from "./provenance";

export type CostImpactCategory = "confirmed" | "potential" | "explicit-negative" | "unclassified" | "unmapped";
export type CostImpactViewState = "available" | "empty" | "unavailable";

export interface CostImpactContributor {
  identity: RecordIdentity;
  identityKey: string;
  title: string;
  displayId: string;
  projectLabel: string;
  sourceLabel: string;
  explanation: string;
}

export interface CostImpactBucket {
  category: CostImpactCategory;
  label: string;
  count: number;
  share: number | null;
  contributors: readonly CostImpactContributor[];
  evidence: readonly EvidenceRef[];
  provenance: MetricProvenance;
}

export interface CostImpactRiskViewModel {
  state: CostImpactViewState;
  unavailableReason: string | null;
  scopeLabel: string;
  asOf: string;
  denominator: number;
  excludedRecordCount: number;
  unquantifiedSignalCount: number;
  rfiUnknownCount: number;
  buckets: readonly CostImpactBucket[];
  provenance: MetricProvenance;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

export function costImpactCategoryForRecord(record: RiskRecord): CostImpactCategory | null {
  if (!record.open || (record.kind !== "issue" && record.kind !== "rfi")) return null;
  if (
    (record.kind === "rfi" && record.costImpact === "yes") ||
    (record.kind === "issue" && record.iqCostImpact === "high")
  ) return "confirmed";
  if (
    (record.kind === "rfi" && record.costImpact === "unknown") ||
    (record.kind === "issue" && record.iqCostImpact === "medium")
  ) return "potential";
  if (
    (record.kind === "rfi" && record.costImpact === "no") ||
    (record.kind === "issue" && record.iqCostImpact === "low")
  ) return "explicit-negative";
  if (
    (record.kind === "rfi" && record.costImpact === null) ||
    (record.kind === "issue" && record.iqCostImpact === "none")
  ) return "unclassified";
  return "unmapped";
}

function sourceDescription(record: RiskRecord): Pick<CostImpactContributor, "sourceLabel" | "explanation"> {
  if (record.kind === "rfi") {
    if (record.costImpact === "yes") return {
      sourceLabel: "RFI cost impact: Yes",
      explanation: "Autodesk's RFI tri-state field is Yes. It supplies no monetary amount.",
    };
    if (record.costImpact === "unknown") return {
      sourceLabel: "RFI cost impact: Unknown",
      explanation: "Autodesk's RFI tri-state field remains Unknown; the application does not turn it into No.",
    };
    if (record.costImpact === null) return {
      sourceLabel: "RFI cost impact: unavailable",
      explanation: "The RFI field is null, which can mean the field is absent or disabled. It is not treated as Unknown or No.",
    };
    if (record.costImpact === "unmapped") return {
      sourceLabel: "RFI cost impact: unmapped",
      explanation: "The source supplied an unexpected value. It is retained for remediation and is not assigned a risk meaning.",
    };
    return {
      sourceLabel: "RFI cost impact: No",
      explanation: "Autodesk's current RFI tri-state field is No for this record.",
    };
  }
  const label = record.iqCostImpact === "none" ? "Not classified" : record.iqCostImpact === "unmapped" ? "Unmapped" : `${record.iqCostImpact.charAt(0).toUpperCase()}${record.iqCostImpact.slice(1)}`;
  return {
    sourceLabel: `CIQ categorical cost impact: ${label}`,
    explanation: record.iqCostImpact === "high"
      ? "Construction IQ supplies a High categorical cost-impact classification; it is not a currency value."
      : record.iqCostImpact === "medium"
        ? "Construction IQ supplies a Medium categorical cost-impact classification; the application treats it as potential and unquantified."
        : record.iqCostImpact === "low"
          ? "Construction IQ supplies a Low categorical classification. Low is kept distinct from an absent classification and is not proof of no cost impact."
          : record.iqCostImpact === "none"
            ? "No current Construction IQ cost-impact classification is present. That is not proof of no cost impact."
            : "The Construction IQ source value is unmapped. It is retained for remediation and is not assigned a risk meaning.",
  };
}

function evidence(record: RiskRecord): EvidenceRef {
  return {
    kind: record.kind,
    id: record.id,
    projectId: record.projectId,
    label: record.displayId ?? record.title,
    ...(record.href ? { href: record.href } : {}),
  };
}

const bucketLabels: Record<CostImpactCategory, string> = {
  confirmed: "Confirmed cost-impact signal",
  potential: "Potential cost-impact signal",
  "explicit-negative": "Explicit No / Low signal",
  unclassified: "No current cost-impact classification",
  unmapped: "Unmapped source value",
};

export function buildCostImpactRiskView(
  records: readonly RiskRecord[],
  options: {
    asOf: string;
    scopeLabel?: string;
    sourceAvailable?: boolean;
    unavailableReason?: string;
    sourceSystem?: SourceSystem;
    sourceDataset?: string;
    projectLabels?: Readonly<Record<string, string>>;
  },
): CostImpactRiskViewModel {
  if (!validTimestamp(options.asOf)) throw new RangeError("Cost-impact view requires a valid as-of timestamp.");
  const scopeLabel = options.scopeLabel?.trim() || "Current filtered scope";
  const sourceSystem = options.sourceSystem ?? "forma-risk-radar";
  const sourceDataset = options.sourceDataset ?? "filtered-canonical-risk-records";
  const provenance = derivedProvenance({ sourceSystem, sourceDataset, timestamp: options.asOf, definitionId: "exposure.cost-impact.filtered-categories" });
  const eligible = records.filter((record) => costImpactCategoryForRecord(record) !== null);
  const denominator = eligible.length;
  const categories: readonly CostImpactCategory[] = ["confirmed", "potential", "explicit-negative", "unclassified", "unmapped"];
  const buckets = categories.map((category): CostImpactBucket => {
    const matches = eligible.filter((record) => costImpactCategoryForRecord(record) === category);
    return {
      category,
      label: bucketLabels[category],
      count: matches.length,
      share: denominator ? Math.round((1_000 * matches.length) / denominator) / 10 : null,
      contributors: matches.map((record) => ({
        identity: { projectId: record.projectId, kind: record.kind, id: record.id },
        identityKey: recordIdentityKey(record),
        title: record.title,
        displayId: record.displayId ?? record.id,
        projectLabel: options.projectLabels?.[record.projectId] ?? record.projectId,
        ...sourceDescription(record),
      })),
      evidence: matches.map(evidence),
      provenance: derivedProvenance({ sourceSystem, sourceDataset, timestamp: options.asOf, definitionId: `exposure.cost-impact.${category}` }),
    };
  });
  const confirmed = buckets.find((bucket) => bucket.category === "confirmed")?.count ?? 0;
  const potential = buckets.find((bucket) => bucket.category === "potential")?.count ?? 0;
  return {
    state: options.sourceAvailable === false ? "unavailable" : denominator ? "available" : "empty",
    unavailableReason: options.sourceAvailable === false
      ? options.unavailableReason?.trim() || "Cost-impact source coverage is unavailable for this scope."
      : null,
    scopeLabel,
    asOf: options.asOf,
    denominator,
    excludedRecordCount: records.length - denominator,
    unquantifiedSignalCount: confirmed + potential,
    rfiUnknownCount: eligible.filter((record) => record.kind === "rfi" && record.costImpact === "unknown").length,
    buckets,
    provenance,
  };
}
