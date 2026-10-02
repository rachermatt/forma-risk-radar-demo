import type {
  BurnRate,
  MomentumDirection,
  MomentumDimension,
  RiskDimension,
  Severity,
} from "../canonical/types";
import { EXPOSURE_WEIGHTS, RISK_THRESHOLDS, RISK_WEIGHTS } from "./definitions";
import { momentumDirection } from "./normalization";

export interface WeightedInput {
  id: string;
  value: number | null;
  weight: number;
}

export interface WeightedIndexResult {
  value: number | null;
  coverage: number;
  availableWeight: number;
  missing: readonly string[];
  suppressed: boolean;
}

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export interface Per100ActiveResult {
  value: number | null;
  lowSample: boolean;
  wilsonLowerBound: number | null;
  rankingValue: number | null;
  numerator: number;
  denominator: number;
}

export function wilsonLowerBound(successes: number, total: number, z = 1.96): number | null {
  if (total <= 0) return null;
  const boundedSuccesses = Math.min(total, Math.max(0, successes));
  const proportion = boundedSuccesses / total;
  const zSquared = z ** 2;
  const center = proportion + zSquared / (2 * total);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * total)) / total);
  return Math.max(0, (center - margin) / (1 + zSquared / total));
}

export function per100Active(count: number, active: number): Per100ActiveResult {
  const value = active > 0 ? (100 * count) / active : null;
  const lowSample = active > 0 && active < RISK_THRESHOLDS.lowSample;
  const lowerBound = wilsonLowerBound(count, active);
  return {
    value,
    lowSample,
    wilsonLowerBound: lowerBound === null ? null : 100 * lowerBound,
    rankingValue: lowSample || lowerBound === null ? null : 100 * lowerBound,
    numerator: count,
    denominator: active,
  };
}

export function weightedIndex(
  inputs: readonly WeightedInput[],
  minimumCoverage = RISK_THRESHOLDS.minimumCoverage,
): WeightedIndexResult {
  const totalWeight = inputs.reduce((sum, input) => sum + input.weight, 0);
  const available = inputs.filter((input) => input.value !== null && Number.isFinite(input.value));
  const availableWeight = available.reduce((sum, input) => sum + input.weight, 0);
  const coverage = totalWeight === 0 ? 0 : availableWeight / totalWeight;
  const missing = inputs.filter((input) => input.value === null).map((input) => input.id);
  if (availableWeight === 0 || coverage < minimumCoverage) {
    return { value: null, coverage, availableWeight, missing, suppressed: true };
  }
  const normalized = available.reduce(
    (sum, input) => sum + input.weight * clamp(input.value ?? 0, 0, 1),
    0,
  );
  return {
    value: Math.round((1000 * normalized) / availableWeight) / 10,
    coverage,
    availableWeight,
    missing,
    suppressed: false,
  };
}

export interface RiskIndexInput {
  constructionIqQuality: number | null;
  highRiskPer100: number | null;
  overduePer100: number | null;
  safetySignalsPer100: number | null;
  rfiHighShare: number | null;
  persistenceOver30Share: number | null;
}

export function calculateRiskIndex(input: RiskIndexInput): WeightedIndexResult {
  return weightedIndex([
    { id: "risk.ciq.project-quality-level", value: input.constructionIqQuality === null ? null : input.constructionIqQuality / 3, weight: RISK_WEIGHTS.constructionIqQuality },
    { id: "risk.quality.high-open-per-100", value: input.highRiskPer100 === null ? null : input.highRiskPer100 / 25, weight: RISK_WEIGHTS.highRiskDensity },
    { id: "risk.overdue.density", value: input.overduePer100 === null ? null : input.overduePer100 / 40, weight: RISK_WEIGHTS.overdueDensity },
    { id: "risk.safety.signal-density", value: input.safetySignalsPer100 === null ? null : input.safetySignalsPer100 / 10, weight: RISK_WEIGHTS.safetySignalDensity },
    { id: "risk.rfi.high-share", value: input.rfiHighShare, weight: RISK_WEIGHTS.rfiHighShare },
    { id: "persistence.share-over-30d", value: input.persistenceOver30Share, weight: RISK_WEIGHTS.persistenceOver30Days },
  ]);
}

export function severityFromRiskIndex(
  index: number | null,
  criticalOverdue: number,
  ciqQuality: Severity,
  derivedSignalCount: number,
): Severity {
  if (ciqQuality === "unmapped") return "unmapped";
  if (index === null && ciqQuality === "none" && derivedSignalCount === 0) return "none";
  if ((index ?? 0) >= RISK_THRESHOLDS.critical || criticalOverdue > 0) return "critical";
  if ((index ?? 0) >= RISK_THRESHOLDS.high || ciqQuality === "high") return "high";
  if ((index ?? 0) >= RISK_THRESHOLDS.medium || ciqQuality === "medium") return "medium";
  return "low";
}

export interface ExposureIndexInput {
  scope?: "hub" | "project";
  locationsShare: number | null;
  companiesShare: number | null;
  confirmedCostShare: number | null;
  scheduleLinkedShare: number | null;
  criticalPathLinkedShare: number | null;
  projectsAffectedShare: number | null;
  scheduleEdgeCount?: number;
}

export function calculateExposureIndex(input: ExposureIndexInput): WeightedIndexResult {
  const scheduleEligible = (input.scheduleEdgeCount ?? 0) >= 10;
  const inputs: WeightedInput[] = [
    { id: "exposure.locations-affected-share", value: input.locationsShare, weight: EXPOSURE_WEIGHTS.locations },
    { id: "exposure.companies-affected-share", value: input.companiesShare, weight: EXPOSURE_WEIGHTS.companies },
    { id: "exposure.cost.confirmed-density", value: input.confirmedCostShare, weight: EXPOSURE_WEIGHTS.confirmedCost },
    { id: "exposure.schedule-linked-share", value: scheduleEligible ? input.scheduleLinkedShare : null, weight: EXPOSURE_WEIGHTS.scheduleLinked },
    { id: "exposure.critical-path-linked-share", value: scheduleEligible ? input.criticalPathLinkedShare : null, weight: EXPOSURE_WEIGHTS.criticalPathLinked },
  ];
  if (input.scope !== "project") inputs.push({ id: "exposure.projects-affected-share", value: input.projectsAffectedShare, weight: EXPOSURE_WEIGHTS.projectsAffected });
  return weightedIndex(inputs);
}

export interface SeriesPoint {
  date: string;
  value: number | null;
}

export interface ObservedSeriesPoint {
  date: string;
  value: number;
}

export interface FilledSeriesPoint extends SeriesPoint {
  observed: boolean;
  forwardFilled: boolean;
  forwardFilledFrom: string | null;
  stale: boolean;
  /** True when an aggregate date combines different source-coverage states. */
  mixed?: boolean;
  observedCount?: number;
  forwardFilledCount?: number;
  missingCount?: number;
  populationCount?: number;
}

/** Align project histories by ISO date before aggregation; never by array position. */
export function aggregateFilledSeriesByDate(
  series: readonly (readonly FilledSeriesPoint[])[],
): readonly FilledSeriesPoint[] {
  const dates = [...new Set(series.flatMap((points) => points.map((point) => point.date)))].sort();
  const indexes = series.map((points) => new Map(points.map((point) => [point.date, point])));
  return dates.map((date) => {
    const matching = indexes.flatMap((index) => {
      const point = index.get(date);
      return point ? [point] : [];
    });
    const values = matching.map((point) => point.value).filter((value): value is number => value !== null);
    const observedCount = matching.filter((point) => point.value !== null && point.observed && !point.forwardFilled).length;
    const forwardFilledCount = matching.filter((point) => point.value !== null && point.forwardFilled).length;
    const missingCount = series.length - values.length;
    const mixed = [observedCount > 0, forwardFilledCount > 0, missingCount > 0].filter(Boolean).length > 1;
    return {
      date,
      value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      observed: observedCount > 0 && forwardFilledCount === 0,
      forwardFilled: forwardFilledCount > 0,
      forwardFilledFrom: matching.find((point) => point.forwardFilledFrom)?.forwardFilledFrom ?? null,
      stale: matching.some((point) => point.stale),
      mixed,
      observedCount,
      forwardFilledCount,
      missingCount,
      populationCount: series.length,
    };
  });
}

/**
 * Seven-day rolling mean used by trend charts.
 *
 * Call this on the complete daily series before clipping a display range so
 * the first visible point can still use the preceding six calendar days.
 * The catalog requires at least five usable observations in each window.
 */
export function rollingAverageSeries(
  points: readonly FilledSeriesPoint[],
  window = 7,
  minimumUsable = 5,
): readonly FilledSeriesPoint[] {
  if (!Number.isInteger(window) || window <= 0) throw new RangeError("Rolling-average window must be a positive integer.");
  if (!Number.isInteger(minimumUsable) || minimumUsable <= 0 || minimumUsable > window) {
    throw new RangeError("Rolling-average minimum must be a positive integer no larger than the window.");
  }
  return points.map((point, index) => {
    const values = points
      .slice(Math.max(0, index - window + 1), index + 1)
      .map((entry) => entry.value)
      .filter((value): value is number => value !== null);
    return {
      ...point,
      value: values.length >= minimumUsable
        ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
        : null,
      observed: false,
    };
  });
}

function utcDate(date: string): Date {
  const normalized = date.length === 10 ? `${date}T00:00:00.000Z` : date;
  return new Date(normalized);
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function forwardFillDailySeries(
  observations: readonly ObservedSeriesPoint[],
  start: string,
  end: string,
  staleAfterDays = 90,
): readonly FilledSeriesPoint[] {
  const byDate = new Map(observations.map((point) => [point.date.slice(0, 10), point.value]));
  const sorted = [...observations].sort((a, b) => a.date.localeCompare(b.date));
  const output: FilledSeriesPoint[] = [];
  let cursor = utcDate(start);
  const last = utcDate(end);
  let latest: ObservedSeriesPoint | null = null;
  let observationIndex = 0;

  while (cursor <= last) {
    const key = dateKey(cursor);
    while (observationIndex < sorted.length && sorted[observationIndex]!.date.slice(0, 10) <= key) {
      latest = sorted[observationIndex]!;
      observationIndex += 1;
    }
    const observed = byDate.has(key);
    const origin = observed ? key : latest?.date.slice(0, 10) ?? null;
    const age = origin ? Math.floor((cursor.getTime() - utcDate(origin).getTime()) / 86_400_000) : 0;
    output.push({
      date: key,
      value: latest?.value ?? null,
      observed,
      forwardFilled: !observed && latest !== null,
      forwardFilledFrom: !observed ? origin : null,
      stale: latest !== null && age > staleAfterDays,
    });
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return output;
}

function valueAt(series: readonly SeriesPoint[], offsetFromEnd: number): number | null {
  const point = series[series.length - 1 - offsetFromEnd];
  return point?.value ?? null;
}

export function calculateMomentum(series: readonly SeriesPoint[]): MomentumDimension & { insufficientHistory: boolean } {
  const current = valueAt(series, 0);
  const day1 = valueAt(series, 1);
  const day7 = series.length >= 8 ? valueAt(series, 7) : null;
  const day14 = series.length >= 15 ? valueAt(series, 14) : null;
  const day28 = series.length >= 29 ? valueAt(series, 28) : null;
  const change1d = current === null || day1 === null ? null : current - day1;
  const change7d = current === null || day7 === null ? null : current - day7;
  const change28d = current === null || day28 === null ? null : current - day28;
  const acceleration = current === null || day7 === null || day14 === null ? null : current - 2 * day7 + day14;
  const lastSeven = series.slice(-7).map((point) => point.value).filter((value): value is number => value !== null);
  const rollingAverage7d = lastSeven.length < 5 ? null : lastSeven.reduce((sum, value) => sum + value, 0) / lastSeven.length;
  const distinct28 = new Set(series.slice(-28).map((point) => point.value).filter((value) => value !== null)).size;
  const safeAcceleration = distinct28 < 3 ? null : acceleration;
  const direction: MomentumDirection = momentumDirection(change7d, safeAcceleration);

  const currentPoint = series.at(-1);
  const currentIsStale = Boolean(currentPoint && "stale" in currentPoint && currentPoint.stale === true);
  let consecutiveElevatedPeriods = 0;
  if (!currentIsStale) {
    for (let index = series.length - 1; index >= 0; index -= 1) {
      const value = series[index]?.value;
      if (value === null || value === undefined || value < 55) break;
      consecutiveElevatedPeriods += 1;
    }
    let lastObservedIndex = -1;
    for (let index = series.length - 1; index >= 0; index -= 1) {
      const point = series[index]!;
      if ("observed" in point && point.observed === true) {
        lastObservedIndex = index;
        break;
      }
    }
    if (lastObservedIndex >= 0) {
      const carriedDays = Math.max(0, series.length - 1 - lastObservedIndex);
      consecutiveElevatedPeriods = Math.min(consecutiveElevatedPeriods, carriedDays + 30);
    }
  }

  return {
    direction,
    change1d,
    change7d,
    change28d,
    rollingAverage7d,
    acceleration: safeAcceleration,
    consecutiveElevatedPeriods,
    newHighRiskRate: 0,
    resolvedHighRiskRate: 0,
    insufficientHistory: series.length < 8 || change7d === null,
  };
}

export function ageDays(createdAt: string, asOf: string): number {
  return Math.max(0, Math.floor((new Date(asOf).getTime() - new Date(createdAt).getTime()) / 86_400_000));
}

export function persistenceBuckets(ages: readonly number[]): { over7: number; over14: number; over30: number } {
  return {
    over7: ages.filter((age) => age > 7).length,
    over14: ages.filter((age) => age > 14).length,
    over30: ages.filter((age) => age > 30).length,
  };
}

export function calculateBurnRate(
  scopeId: string,
  domain: BurnRate["domain"],
  periodDays: number,
  created: number,
  resolved: number,
  backlog: number,
): Omit<BurnRate, "provenance"> {
  return {
    scopeId,
    domain,
    periodDays,
    created,
    resolved,
    net: created - resolved,
    backlog,
    creationRatePerWeek: (created * 7) / periodDays,
    resolutionRatePerWeek: (resolved * 7) / periodDays,
    burnRatio: created === 0 ? null : resolved / created,
  };
}

export function derivedRiskExposureIndex(risk: number | null, exposure: number | null): number | null {
  if (risk === null || exposure === null) return null;
  return Math.round((0.6 * risk + 0.4 * exposure) * 10) / 10;
}

export function riskDimension(
  index: number | null,
  severity: Severity,
  highRiskOpen: number,
  criticalOverdue: number,
  constructionIqLevel?: Severity,
): RiskDimension {
  return {
    severity,
    index,
    highRiskOpen,
    criticalOverdue,
    ...(constructionIqLevel && constructionIqLevel !== "none" ? { constructionIqLevel } : {}),
  };
}
