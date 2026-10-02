const DAY_MS = 86_400_000;
const MAX_CUSTOM_PERIOD_DAYS = 365;
const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type HistoryRangeKey = "1d" | "7d" | "30d" | "90d" | "180d" | "365d" | "custom";

export interface HistoryRange {
  key: HistoryRangeKey;
  startDate: string;
  endDate: string;
  /** Inclusive number of UTC calendar days in the selected window. */
  periodDays: number;
  /** UTC instant used by calculations whose API accepts an inclusive as-of day. */
  asOf: string;
  /** Exact analytic boundary: start is included. */
  from: number;
  /** Exact analytic boundary: end is excluded. */
  throughExclusive: number;
  label: string;
  custom: boolean;
  invalidCustom: boolean;
  coveragePartial: boolean;
}

const PRESET_DAYS: Readonly<Record<Exclude<HistoryRangeKey, "custom">, number>> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
};

function parseDate(value: string | null | undefined): number | null {
  if (!value || !STRICT_DATE.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

function dateAt(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function presetRange(key: Exclude<HistoryRangeKey, "custom">, end: number, coverageStart: number | null, invalidCustom = false): HistoryRange {
  const periodDays = PRESET_DAYS[key];
  const from = end - (periodDays - 1) * DAY_MS;
  const endDate = dateAt(end);
  return {
    key,
    startDate: dateAt(from),
    endDate,
    periodDays,
    asOf: `${endDate}T12:00:00.000Z`,
    from,
    throughExclusive: end + DAY_MS,
    label: key === "1d" ? "Today" : `Last ${periodDays} days`,
    custom: false,
    invalidCustom,
    coveragePartial: coverageStart !== null && from < coverageStart,
  };
}

/**
 * Resolve URL-backed history controls into one strict half-open UTC interval.
 * Invalid or future custom ranges fail safely to the default trailing 30 days.
 */
export function resolveHistoryRange(input: {
  range?: string | null;
  from?: string | null;
  to?: string | null;
  asOf: string;
  coverageStart?: string | null;
}): HistoryRange {
  const asOfDate = input.asOf.slice(0, 10);
  const end = parseDate(asOfDate);
  if (end === null) throw new RangeError("History range requires a valid as-of timestamp.");
  const coverageStart = parseDate(input.coverageStart);
  const requested = input.range ?? "30d";
  if (requested !== "custom") {
    const key = Object.hasOwn(PRESET_DAYS, requested)
      ? requested as Exclude<HistoryRangeKey, "custom">
      : "30d";
    return presetRange(key, end, coverageStart);
  }

  const from = parseDate(input.from);
  const through = parseDate(input.to);
  if (
    from === null ||
    through === null ||
    from > through ||
    through > end ||
    (coverageStart !== null && from < coverageStart) ||
    Math.floor((through - from) / DAY_MS) + 1 > MAX_CUSTOM_PERIOD_DAYS
  ) {
    return presetRange("30d", end, coverageStart, true);
  }
  const periodDays = Math.floor((through - from) / DAY_MS) + 1;
  const startDate = dateAt(from);
  const endDate = dateAt(through);
  return {
    key: "custom",
    startDate,
    endDate,
    periodDays,
    asOf: `${endDate}T12:00:00.000Z`,
    from,
    throughExclusive: through + DAY_MS,
    label: `${dateLabel(startDate)} – ${dateLabel(endDate)}`,
    custom: true,
    invalidCustom: false,
    coveragePartial: coverageStart !== null && from < coverageStart,
  };
}

export function previousHistoryAsOf(range: HistoryRange): string {
  return `${dateAt(range.from - DAY_MS)}T12:00:00.000Z`;
}

export function previousHistoryRange(range: HistoryRange, coverageStart?: string | null): HistoryRange {
  const throughExclusive = range.from;
  const from = throughExclusive - range.periodDays * DAY_MS;
  const coverageBoundary = parseDate(coverageStart);
  const startDate = dateAt(from);
  const endDate = dateAt(throughExclusive - DAY_MS);
  return {
    ...range,
    startDate,
    endDate,
    asOf: `${endDate}T12:00:00.000Z`,
    from,
    throughExclusive,
    label: `Previous ${range.periodDays === 1 ? "day" : `${range.periodDays} days`}`,
    coveragePartial: coverageBoundary !== null && from < coverageBoundary,
  };
}

export function seriesWithinHistoryRange<T extends { date: string }>(points: readonly T[], range: Pick<HistoryRange, "from" | "throughExclusive">): readonly T[] {
  return points.filter((point) => {
    const timestamp = parseDate(point.date.slice(0, 10));
    return timestamp !== null && timestamp >= range.from && timestamp < range.throughExclusive;
  });
}
