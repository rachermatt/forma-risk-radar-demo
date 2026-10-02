import {
  recordIdentityKey,
  type EvidenceRef,
  type Measured,
  type MetricProvenance,
  type MomentumDimension,
  type SourceSystem,
} from "../canonical/types";
import type { FilledSeriesPoint } from "./metrics";
import { derivedProvenance } from "./provenance";

export type VelocityState = "available" | "unavailable";
export type VelocityCoverageState = "complete" | "carried-forward" | "partial" | "stale" | "unavailable";

export interface VelocityMetric {
  id: "change1d" | "change7d" | "change28d" | "rollingAverage7d" | "acceleration" | "consecutiveElevatedPeriods" | "newlyClassifiedRate" | "newHighRiskRate" | "resolvedHighRiskRate";
  label: string;
  value: number | null;
  unit: string;
  availability: "available" | "unavailable";
  unavailableReason: string | null;
  coverageCount: number;
  populationCount: number;
  evidence: readonly EvidenceRef[];
  provenance: MetricProvenance;
}

export interface RiskVelocityEvidence {
  state: VelocityState;
  unavailableReason: string | null;
  scopeLabel: string;
  coverageState: VelocityCoverageState;
  coverage: { observed: number; carried: number; mixed: number; missing: number; stale: number; usableRatio: number | null };
  rateQualifier: "accelerating" | "decelerating" | "steady-rate" | "unavailable";
  metrics: readonly VelocityMetric[];
  series: readonly FilledSeriesPoint[];
  provenance: MetricProvenance;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function mean(values: readonly number[]): number | null {
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;
}

function uniqueEvidence(measures: readonly Measured<MomentumDimension>[]): readonly EvidenceRef[] {
  const byIdentity = new Map<string, EvidenceRef>();
  for (const item of measures) for (const itemEvidence of item.evidence ?? []) byIdentity.set(recordIdentityKey(itemEvidence), itemEvidence);
  return [...byIdentity.values()];
}

export function buildRiskVelocityEvidence(
  momentum: readonly Measured<MomentumDimension>[],
  options: {
    asOf: string;
    scopeLabel?: string;
    available?: boolean;
    unavailableReason?: string;
    series?: readonly FilledSeriesPoint[];
    sourceSystem?: SourceSystem;
    sourceDataset?: string;
  },
): RiskVelocityEvidence {
  if (!validTimestamp(options.asOf)) throw new RangeError("Risk velocity requires a valid as-of timestamp.");
  const sourceSystem = options.sourceSystem ?? "forma-risk-radar";
  const sourceDataset = options.sourceDataset ?? "risk-snapshots";
  const provenance = derivedProvenance({ sourceSystem, sourceDataset, timestamp: options.asOf, definitionId: "momentum.velocity.current-scope" });
  const evidence = uniqueEvidence(momentum);
  const series = options.series ?? [];
  const mixed = series.filter((point) => point.value !== null && (point.mixed || (point.observed && point.forwardFilled))).length;
  const observed = series.filter((point) => point.value !== null && !point.mixed && point.observed && !point.forwardFilled).length;
  const carried = series.filter((point) => point.value !== null && !point.mixed && !point.observed && point.forwardFilled).length;
  const missing = series.filter((point) => point.value === null).length;
  const stale = series.filter((point) => point.value !== null && point.stale).length;
  const usable = observed + carried + mixed;
  const coverage = { observed, carried, mixed, missing, stale, usableRatio: series.length ? Math.min(1, usable / series.length) : null };
  const explicitlyUnavailable = options.available === false || momentum.length === 0 || options.series === undefined;
  const coverageState: VelocityCoverageState = explicitlyUnavailable
    ? "unavailable"
    : stale > 0
      ? "stale"
      : missing > 0
        ? "partial"
        : mixed > 0 || carried > 0
          ? "carried-forward"
          : "complete";
  const fields: readonly [VelocityMetric["id"], keyof MomentumDimension | null, string, string, "mean" | "sum", string | null][] = [
    ["change1d", "change1d", "1-day change", "index points", "mean", null],
    ["change7d", "change7d", "7-day change", "index points", "mean", null],
    ["change28d", "change28d", "28-day change", "index points", "mean", null],
    ["rollingAverage7d", "rollingAverage7d", "7-day rolling average", "risk index", "mean", null],
    ["acceleration", "acceleration", "Acceleration", "index-point second difference", "mean", null],
    ["consecutiveElevatedPeriods", "consecutiveElevatedPeriods", "Consecutive elevated periods", "daily periods", "mean", null],
    ["newlyClassifiedRate", null, "Newly classified rate", "records per week", "sum", "Classification transition history is not stored, so a newly-classified rate is not inferred."],
    ["newHighRiskRate", "newHighRiskRate", "New high-risk rate", "records per week", "sum", null],
    ["resolvedHighRiskRate", "resolvedHighRiskRate", "Resolved high-risk rate", "records per week", "sum", null],
  ];
  const metrics = fields.map(([id, field, label, unit, aggregation, unsupportedReason]): VelocityMetric => {
    const values = explicitlyUnavailable || field === null ? [] : momentum
      .map((item) => item.value[field])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const value = aggregation === "sum"
      ? values.length ? Math.round(values.reduce((sum, item) => sum + item, 0) * 10) / 10 : null
      : mean(values);
    return {
      id,
      label,
      value,
      unit,
      availability: values.length ? "available" : "unavailable",
      unavailableReason: unsupportedReason ?? (values.length ? null : explicitlyUnavailable ? options.unavailableReason?.trim() || "Historical velocity is unavailable for this scope." : "No covered value is stored for this metric."),
      coverageCount: values.length,
      populationCount: momentum.length,
      evidence,
      provenance: derivedProvenance({ sourceSystem, sourceDataset, timestamp: options.asOf, definitionId: `momentum.velocity.${id}` }),
    };
  });
  const acceleration = metrics.find((metric) => metric.id === "acceleration")?.value ?? null;
  return {
    state: explicitlyUnavailable ? "unavailable" : "available",
    unavailableReason: explicitlyUnavailable
      ? options.unavailableReason?.trim() || "Historical velocity is unavailable for this scope."
      : null,
    scopeLabel: options.scopeLabel?.trim() || "Current filtered scope",
    coverageState,
    coverage,
    rateQualifier: acceleration === null ? "unavailable" : acceleration > 1 ? "accelerating" : acceleration < -1 ? "decelerating" : "steady-rate",
    metrics,
    series,
    provenance,
  };
}
