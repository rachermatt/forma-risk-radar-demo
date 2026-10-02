import {
  disciplineIdentityKey,
  disciplineIdentityLabel,
} from "./analytics";
import {
  recordIdentityKey,
  type EvidenceRef,
  type MetricProvenance,
  type RecordIdentity,
  type RiskRecord,
  type SourceSystem,
} from "../canonical/types";
import { autodeskProvenance, derivedProvenance } from "./provenance";

export type RfiCauseOrigin = "construction-iq-predicted" | "operational-category";

export interface RfiCauseSourceCoverage {
  origin: RfiCauseOrigin;
  available: boolean;
  unavailableReason: string | null;
  attributed: number | null;
  unattributed: number | null;
  eligibleRfis: number | null;
  coveredProjects: number | null;
  scopeProjects: number | null;
}

export interface RfiCauseSourceAvailability {
  available: boolean;
  reason?: string;
  /** When supplied, only RFIs in these projects belong to this source's denominator. */
  coveredProjectIds?: readonly string[];
  /** Full visible project population used to disclose partial source coverage. */
  scopeProjectIds?: readonly string[];
}

export const ALL_RFI_CAUSE_SOURCES_AVAILABLE = Object.freeze({
  "construction-iq-predicted": Object.freeze({ available: true }),
  "operational-category": Object.freeze({ available: true }),
} as const);

export function rfiCauseSourceAvailabilityForProjects(
  scopeProjectIds: readonly string[],
  ciqCoveredProjectIds: readonly string[],
): Record<RfiCauseOrigin, RfiCauseSourceAvailability> {
  const scope = [...new Set(scopeProjectIds)];
  const scopeSet = new Set(scope);
  const ciqCovered = [...new Set(ciqCoveredProjectIds.filter((projectId) => scopeSet.has(projectId)))];
  return {
    "construction-iq-predicted": {
      available: ciqCovered.length > 0,
      reason: ciqCovered.length ? undefined : "No project in the current scope has an extracted Construction IQ RFI source.",
      coveredProjectIds: ciqCovered,
      scopeProjectIds: scope,
    },
    "operational-category": {
      available: scope.length > 0,
      reason: scope.length ? undefined : "No project is present in the current scope.",
      coveredProjectIds: scope,
      scopeProjectIds: scope,
    },
  };
}

export interface RfiCauseContributor {
  identity: RecordIdentity;
  identityKey: string;
  displayId: string;
  title: string;
  projectId: string;
  projectLabel: string;
  companyId: string | null;
  discipline: string | null;
  openAgeDays: number | null;
  responseDays: number | null;
}

export interface RfiCauseGroup {
  key: string;
  origin: RfiCauseOrigin;
  label: string;
  projectId: string | null;
  count: number;
  denominator: number;
  share: number | null;
  openAge: { count: number; mean: number | null; median: number | null; max: number | null };
  responseDuration: { count: number; mean: number | null; median: number | null; max: number | null };
  projectsAffected: number;
  companiesAffected: number;
  disciplines: readonly string[];
  recurrence: {
    occurrencesWithinWindow: number;
    repeatedEvents: number;
    populationRate: number | null;
    populationDistinctSignatures: number;
    minimumDistinctSignatures: 8;
    suppressedReason: string | null;
    windowDays: 180;
  };
  weeklyCreated: readonly { weekStart: string; count: number }[];
  contributors: readonly RfiCauseContributor[];
  evidence: readonly EvidenceRef[];
  labelProvenance: MetricProvenance;
  metricProvenance: MetricProvenance;
}

export interface RfiCauseIntelligence {
  state: "available" | "empty";
  asOf: string;
  totalRfis: number;
  ciqAttributed: number | null;
  operationalAttributed: number | null;
  ciqUnattributed: number | null;
  operationalUnattributed: number | null;
  sourceCoverage: readonly RfiCauseSourceCoverage[];
  recurrencePopulations: readonly {
    origin: RfiCauseOrigin;
    totalRelevant: number;
    distinctSignatures: number;
    repeatedEvents: number;
    rate: number | null;
    minimumDistinctSignatures: 8;
    suppressedReason: string | null;
  }[];
  groups: readonly RfiCauseGroup[];
  provenance: MetricProvenance;
}

function normalizedLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function operationalRfiCause(record: RiskRecord): string | null {
  if (record.kind !== "rfi") return null;
  return normalizedLabel(record.rfiCategory);
}

export function rfiCauseIdentityKey(origin: RfiCauseOrigin, label: string, projectId?: string | null): string {
  const normalized = label.trim().toLocaleLowerCase("en-US");
  if (!normalized) throw new RangeError("RFI cause identity requires a non-empty label.");
  if (origin === "operational-category" && !projectId) throw new RangeError("Operational RFI categories require a project identity.");
  return origin === "operational-category"
    ? `${origin}\u001f${projectId}\u001f${normalized}`
    : `${origin}\u001f${normalized}`;
}

function daysBetween(start: string, end: string): number | null {
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return null;
  return Math.round(((endTime - startTime) / 86_400_000) * 10) / 10;
}

function summary(values: readonly number[]): { count: number; mean: number | null; median: number | null; max: number | null } {
  if (!values.length) return { count: 0, mean: null, median: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    count: sorted.length,
    mean: Math.round((sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 10) / 10,
    median: Math.round(median * 10) / 10,
    max: sorted.at(-1)!,
  };
}

function weeklyCreation(records: readonly RiskRecord[], asOf: string): readonly { weekStart: string; count: number }[] {
  const asOfDate = new Date(asOf);
  asOfDate.setUTCHours(0, 0, 0, 0);
  const through = asOfDate.getTime() + 86_400_000;
  return Array.from({ length: 12 }, (_, index) => {
    const start = through - (12 - index) * 7 * 86_400_000;
    const end = start + 7 * 86_400_000;
    return {
      weekStart: new Date(start).toISOString(),
      count: records.filter((record) => {
        const created = new Date(record.createdAt).getTime();
        return Number.isFinite(created) && created >= start && created < end;
      }).length,
    };
  });
}

function ref(record: RiskRecord): EvidenceRef {
  return { kind: record.kind, id: record.id, projectId: record.projectId, label: record.displayId ?? record.title, ...(record.href ? { href: record.href } : {}) };
}

export function buildRfiCauseIntelligence(options: {
  records: readonly RiskRecord[];
  asOf: string;
  sourceSystem?: SourceSystem;
  projectLabels?: Readonly<Record<string, string>>;
  sourceAvailability: Record<RfiCauseOrigin, RfiCauseSourceAvailability>;
}): RfiCauseIntelligence {
  const asOfTime = new Date(options.asOf).getTime();
  if (!Number.isFinite(asOfTime)) throw new RangeError("RFI cause intelligence requires a valid as-of timestamp.");
  const rfis = options.records.filter((record) => record.kind === "rfi");
  const sourceSystem = options.sourceSystem ?? "forma-risk-radar";
  const provenance = derivedProvenance({ sourceSystem, sourceDataset: "filtered-canonical-rfis", timestamp: options.asOf, definitionId: "rfi.root-cause.current-scope" });
  const origins: readonly { origin: RfiCauseOrigin; value: (record: RiskRecord) => string | null; sourceDataset: string; autodeskTerm: string }[] = [
    { origin: "construction-iq-predicted", value: (record) => normalizedLabel(record.iqRootCause), sourceDataset: "iq_rfis_root_cause", autodeskTerm: "Construction IQ RFI Root Cause" },
    { origin: "operational-category", value: operationalRfiCause, sourceDataset: "rfis_rfis", autodeskTerm: "RFI Category" },
  ];
  const groups: RfiCauseGroup[] = [];
  const recurrencePopulations: RfiCauseIntelligence["recurrencePopulations"][number][] = [];
  const sourceCoverage: RfiCauseSourceCoverage[] = [];
  for (const definition of origins) {
    const availability = options.sourceAvailability[definition.origin];
    const scopeProjectIds = availability.scopeProjectIds
      ? new Set(availability.scopeProjectIds)
      : null;
    const coveredProjectIds = availability.coveredProjectIds
      ? new Set(availability.coveredProjectIds.filter((projectId) => !scopeProjectIds || scopeProjectIds.has(projectId)))
      : null;
    const sourceAvailable = availability.available && (coveredProjectIds === null || coveredProjectIds.size > 0);
    if (!sourceAvailable) {
      const reason = availability.reason?.trim() || `${definition.autodeskTerm} source availability was not established for this scope.`;
      sourceCoverage.push({
        origin: definition.origin,
        available: false,
        unavailableReason: reason,
        attributed: null,
        unattributed: null,
        eligibleRfis: null,
        coveredProjects: coveredProjectIds?.size ?? null,
        scopeProjects: scopeProjectIds?.size ?? null,
      });
      recurrencePopulations.push({
        origin: definition.origin,
        totalRelevant: 0,
        distinctSignatures: 0,
        repeatedEvents: 0,
        rate: null,
        minimumDistinctSignatures: 8,
        suppressedReason: reason,
      });
      continue;
    }
    const eligibleRfis = coveredProjectIds === null
      ? rfis
      : rfis.filter((record) => coveredProjectIds.has(record.projectId));
    const attributed = eligibleRfis.filter((record) => definition.value(record) !== null);
    sourceCoverage.push({
      origin: definition.origin,
      available: true,
      unavailableReason: null,
      attributed: attributed.length,
      unattributed: eligibleRfis.length - attributed.length,
      eligibleRfis: eligibleRfis.length,
      coveredProjects: coveredProjectIds?.size ?? scopeProjectIds?.size ?? null,
      scopeProjects: scopeProjectIds?.size ?? null,
    });
    const withinWindow = attributed.filter((record) => {
      const created = new Date(record.createdAt).getTime();
      return Number.isFinite(created) && created >= asOfTime - 180 * 86_400_000 && created <= asOfTime;
    });
    const populationKeys = withinWindow.map((record) => rfiCauseIdentityKey(
      definition.origin,
      definition.value(record)!,
      definition.origin === "operational-category" ? record.projectId : null,
    ));
    const distinctSignatures = new Set(populationKeys).size;
    const repeatedEvents = Math.max(0, populationKeys.length - distinctSignatures);
    const minimumDistinctSignatures = 8 as const;
    const suppressedReason = distinctSignatures < minimumDistinctSignatures
      ? `Recurrence rate suppressed: ${distinctSignatures}/${minimumDistinctSignatures} distinct signatures in the 180-day ${definition.origin === "construction-iq-predicted" ? "CIQ" : "operational-category"} population.`
      : null;
    const populationRate = !suppressedReason && populationKeys.length ? repeatedEvents / populationKeys.length : null;
    recurrencePopulations.push({
      origin: definition.origin,
      totalRelevant: populationKeys.length,
      distinctSignatures,
      repeatedEvents,
      rate: populationRate,
      minimumDistinctSignatures,
      suppressedReason,
    });
    const grouped = new Map<string, RiskRecord[]>();
    for (const record of attributed) {
      const label = definition.value(record)!;
      const key = rfiCauseIdentityKey(definition.origin, label, definition.origin === "operational-category" ? record.projectId : null);
      const records = grouped.get(key) ?? [];
      records.push(record);
      grouped.set(key, records);
    }
    for (const [key, records] of grouped) {
      const first = records[0]!;
      const label = definition.value(first)!;
      const contributors = records.map((record): RfiCauseContributor => {
        const disciplineKey = disciplineIdentityKey(record);
        return {
          identity: { kind: record.kind, id: record.id, projectId: record.projectId },
          identityKey: recordIdentityKey(record),
          displayId: record.displayId ?? record.id,
          title: record.title,
          projectId: record.projectId,
          projectLabel: options.projectLabels?.[record.projectId] ?? record.projectId,
          companyId: record.companyId,
          discipline: disciplineKey ? disciplineIdentityLabel(record) : null,
          openAgeDays: record.open ? daysBetween(record.createdAt, options.asOf) : null,
          responseDays: record.respondedAt ? daysBetween(record.createdAt, record.respondedAt) : null,
        };
      });
      const groupWithinWindow = records.filter((record) => {
        const created = new Date(record.createdAt).getTime();
        return Number.isFinite(created) && created >= asOfTime - 180 * 86_400_000 && created <= asOfTime;
      }).length;
      const groupRepeatedEvents = Math.max(0, groupWithinWindow - 1);
      groups.push({
        key,
        origin: definition.origin,
        label,
        projectId: definition.origin === "operational-category" ? first.projectId : null,
        count: records.length,
        denominator: attributed.length,
        share: attributed.length ? records.length / attributed.length : null,
        openAge: summary(contributors.map((item) => item.openAgeDays).filter((value): value is number => value !== null)),
        responseDuration: summary(contributors.map((item) => item.responseDays).filter((value): value is number => value !== null)),
        projectsAffected: new Set(records.map((record) => record.projectId)).size,
        companiesAffected: new Set(records.map((record) => record.companyId).filter((value): value is string => Boolean(value))).size,
        disciplines: [...new Set(contributors.map((item) => item.discipline).filter((value): value is string => Boolean(value)))].sort(),
        recurrence: {
          occurrencesWithinWindow: groupWithinWindow,
          repeatedEvents: groupRepeatedEvents,
          populationRate,
          populationDistinctSignatures: distinctSignatures,
          minimumDistinctSignatures,
          suppressedReason,
          windowDays: 180,
        },
        weeklyCreated: weeklyCreation(records, options.asOf),
        contributors,
        evidence: records.map(ref),
        labelProvenance: autodeskProvenance({ sourceSystem, sourceDataset: definition.sourceDataset, timestamp: options.asOf, definitionId: `rfi.root-cause.label.${definition.origin}`, autodeskTerm: definition.autodeskTerm }),
        metricProvenance: derivedProvenance({ sourceSystem, sourceDataset: definition.sourceDataset, timestamp: options.asOf, definitionId: `rfi.root-cause.concentration.${definition.origin}` }),
      });
    }
  }
  groups.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  const ciqSource = sourceCoverage.find((source) => source.origin === "construction-iq-predicted")!;
  const operationalSource = sourceCoverage.find((source) => source.origin === "operational-category")!;
  const ciqAttributed = ciqSource.attributed;
  const operationalAttributed = operationalSource.attributed;
  return {
    state: rfis.length ? "available" : "empty",
    asOf: options.asOf,
    totalRfis: rfis.length,
    ciqAttributed,
    operationalAttributed,
    ciqUnattributed: ciqSource.unattributed,
    operationalUnattributed: operationalSource.unattributed,
    sourceCoverage,
    recurrencePopulations,
    groups,
    provenance,
  };
}
