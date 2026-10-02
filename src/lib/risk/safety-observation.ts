import { canonicalUtcTimestamp, recordIdentityKey, type EvidenceRef, type RiskRecord } from "../canonical/types";
import { derivedProvenance } from "./provenance";

export type SafetyObservationCategory = "positive" | "negative";

export interface SafetyObservationEvent {
  readonly category: SafetyObservationCategory;
  readonly observedAt: string | null;
  readonly record: RiskRecord;
}

export interface SafetyObservationPeriod {
  readonly startAt: string;
  readonly endAt: string;
  readonly positive: number;
  readonly negative: number;
}

export interface SafetyObservationBalance {
  readonly positive: number;
  readonly negative: number;
  readonly classified: number;
  readonly positiveShare: number | null;
  readonly minimumForShare: number;
  readonly events: readonly SafetyObservationEvent[];
  readonly periods: readonly SafetyObservationPeriod[];
  readonly evidence: readonly EvidenceRef[];
  readonly sourceCoverage: {
    readonly available: boolean;
    readonly unavailableReason: string | null;
    readonly eligibleIssues: number | null;
    readonly coveredProjects: number | null;
    readonly scopeProjects: number | null;
  };
  readonly provenance: ReturnType<typeof derivedProvenance>;
}

export interface SafetyObservationSourceAvailability {
  readonly available: boolean;
  readonly reason?: string;
  readonly coveredProjectIds?: readonly string[];
  readonly scopeProjectIds?: readonly string[];
}

export function safetyObservationSourceAvailabilityForProjects(
  scopeProjectIds: readonly string[],
  coveredProjectIds: readonly string[],
): SafetyObservationSourceAvailability {
  const scope = [...new Set(scopeProjectIds)];
  const scopeSet = new Set(scope);
  const covered = [...new Set(coveredProjectIds.filter((projectId) => scopeSet.has(projectId)))];
  return {
    available: covered.length > 0,
    reason: covered.length ? undefined : "No project in the current scope has an extracted Construction IQ Issue safety-observation source.",
    coveredProjectIds: covered,
    scopeProjectIds: scope,
  };
}

export function buildSafetyObservationBalance(
  records: readonly RiskRecord[],
  asOf: string,
  minimumForShare = 20,
  sourceAvailability: SafetyObservationSourceAvailability = { available: true },
): SafetyObservationBalance {
  const asOfTime = new Date(asOf).getTime();
  if (!Number.isFinite(asOfTime)) throw new RangeError("Safety observation balance requires a valid as-of time.");
  if (!Number.isSafeInteger(minimumForShare) || minimumForShare < 1) throw new RangeError("Safety observation minimum must be a positive integer.");
  const scopeProjectIds = sourceAvailability.scopeProjectIds
    ? new Set(sourceAvailability.scopeProjectIds)
    : null;
  const coveredProjectIds = sourceAvailability.coveredProjectIds
    ? new Set(sourceAvailability.coveredProjectIds.filter((projectId) => !scopeProjectIds || scopeProjectIds.has(projectId)))
    : null;
  const sourceAvailable = sourceAvailability.available && (coveredProjectIds === null || coveredProjectIds.size > 0);
  const eligibleRecords = sourceAvailable
    ? records.filter((record) => coveredProjectIds === null || coveredProjectIds.has(record.projectId))
    : [];
  const events = eligibleRecords.flatMap((record): SafetyObservationEvent[] => {
    if (record.kind !== "issue") return [];
    const category = record.iqSafetyObservationCategory?.trim().toLowerCase();
    if (category !== "positive" && category !== "negative") return [];
    const observedAt = canonicalUtcTimestamp(record.iqSafetyObservationPredictedAt);
    if (observedAt && new Date(observedAt).getTime() > asOfTime) return [];
    return [{ category, observedAt, record }];
  });
  const positive = events.filter((event) => event.category === "positive").length;
  const negative = events.filter((event) => event.category === "negative").length;
  const classified = positive + negative;
  const evidence = [...new Map(events.map(({ record }) => [recordIdentityKey(record), {
    projectId: record.projectId,
    kind: record.kind,
    id: record.id,
    label: record.displayId ?? record.title,
    ...(record.href ? { href: record.href } : {}),
  } satisfies EvidenceRef])).values()];
  const day = 86_400_000;
  const start = asOfTime - 28 * day;
  const periods = Array.from({ length: 4 }, (_, index): SafetyObservationPeriod => {
    const periodStart = start + index * 7 * day;
    const periodEnd = periodStart + 7 * day;
    const observed = events.filter((event) => {
      if (!event.observedAt) return false;
      const timestamp = new Date(event.observedAt).getTime();
      return timestamp >= periodStart && timestamp < periodEnd;
    });
    return {
      startAt: new Date(periodStart).toISOString(),
      endAt: new Date(periodEnd).toISOString(),
      positive: observed.filter((event) => event.category === "positive").length,
      negative: observed.filter((event) => event.category === "negative").length,
    };
  });
  return {
    positive,
    negative,
    classified,
    positiveShare: classified >= minimumForShare ? positive / classified : null,
    minimumForShare,
    events,
    periods,
    evidence,
    sourceCoverage: {
      available: sourceAvailable,
      unavailableReason: sourceAvailable
        ? null
        : sourceAvailability.reason?.trim() || "Construction IQ Issue safety-observation source availability was not established for this scope.",
      eligibleIssues: sourceAvailable
        ? eligibleRecords.filter((record) => record.kind === "issue").length
        : null,
      coveredProjects: coveredProjectIds?.size ?? scopeProjectIds?.size ?? null,
      scopeProjects: scopeProjectIds?.size ?? null,
    },
    provenance: derivedProvenance({
      sourceSystem: "demo-generator",
      sourceDataset: "iq_issues_safety_observations",
      timestamp: asOf,
      definitionId: "safety.observation-balance",
    }),
  };
}
