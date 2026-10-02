import type { CSSProperties, ReactNode } from "react";
import type { MetricProvenance, MomentumDirection, Severity } from "@/lib/canonical/types";
import type { FilledSeriesPoint } from "@/lib/risk/metrics";
import { provenanceLabel } from "@/lib/risk/provenance";

const severityIcon: Record<Severity, string> = {
  critical: "!",
  high: "▲",
  medium: "◆",
  low: "●",
  none: "–",
  unmapped: "?",
};

export function SeverityBadge({ severity, compact = false, noneLabel = "Not applicable" }: { severity: Severity; compact?: boolean; noneLabel?: string }) {
  const label = severity === "none" ? noneLabel : severity === "unmapped" ? "Unmapped" : severity.charAt(0).toUpperCase() + severity.slice(1);
  return (
    <span className={`severity severity--${severity}${compact ? " severity--compact" : ""}`}>
      <span className="severity__icon" aria-hidden="true">{severityIcon[severity]}</span>
      <span>{label}</span>
    </span>
  );
}

export function PriorityBadge({ priority, compact = false }: { priority: Severity; compact?: boolean }) {
  const label = priority === "none" || priority === "unmapped" ? "Unranked priority" : `${priority.charAt(0).toUpperCase()}${priority.slice(1)} priority`;
  return (
    <span className={`priority priority--${priority}${compact ? " priority--compact" : ""}`}>
      <span className="priority__icon" aria-hidden="true">{severityIcon[priority]}</span>
      <span>{label}</span>
    </span>
  );
}

export function SourceChip({
  provenance,
  label,
  syntheticKind,
}: {
  provenance?: MetricProvenance;
  label?: "Synthetic" | "Autodesk" | "Derived" | "AI";
  syntheticKind?: "Autodesk-shaped field" | "Derived";
}) {
  const value = label ?? (provenance ? provenanceLabel(provenance) : "Derived");
  const syntheticDetail = value === "Synthetic"
    ? syntheticKind ?? (provenance?.valueKind === "autodesk-provided" ? "Autodesk-shaped field" : "Derived")
    : null;
  const icon = value === "Autodesk" ? "A" : value === "Synthetic" ? "◇" : value === "AI" ? "✦" : "ƒ";
  return (
    <span className={`data-chip data-chip--${value.toLowerCase()}`} title={provenance ? `${provenance.definitionId} · v${provenance.definitionVersion}` : undefined}>
      <span aria-hidden="true">{icon}</span>
      {value}{syntheticDetail ? ` · ${syntheticDetail}` : ""}
    </span>
  );
}

export function MomentumBadge({ direction, change }: { direction: MomentumDirection; change?: number | null }) {
  const icon = direction === "improving" ? "↘" : direction === "stable" ? "→" : direction === "accelerating" ? "↗↗" : "↗";
  return (
    <span className={`momentum momentum--${direction}`}>
      <span aria-hidden="true">{icon}</span>
      <span>{direction.charAt(0).toUpperCase() + direction.slice(1)}</span>
      {change !== undefined && change !== null ? <b>{change > 0 ? "+" : ""}{Math.round(change * 10) / 10}</b> : null}
    </span>
  );
}

export function MetricHeader({ label, provenance }: { label: string; provenance: MetricProvenance }) {
  return (
    <div className="metric-header">
      <span>{label}</span>
      <SourceChip provenance={provenance} />
    </div>
  );
}

export interface TrendCoordinate {
  x: number;
  y: number;
}

export function contiguousTrendSegments(
  coordinates: readonly (TrendCoordinate | null)[],
): readonly (readonly TrendCoordinate[])[] {
  const segments: TrendCoordinate[][] = [];
  let current: TrendCoordinate[] = [];
  for (const coordinate of coordinates) {
    if (coordinate) {
      current.push(coordinate);
      continue;
    }
    if (current.length) segments.push(current);
    current = [];
  }
  if (current.length) segments.push(current);
  return segments;
}

export function trendTransitionCoverage(
  source: Pick<FilledSeriesPoint, "forwardFilled" | "mixed">,
  destination: Pick<FilledSeriesPoint, "forwardFilled" | "mixed">,
): { horizontalCarried: boolean; verticalCarried: boolean } {
  return {
    horizontalCarried: source.forwardFilled || source.mixed === true,
    verticalCarried: destination.forwardFilled || destination.mixed === true,
  };
}

export function stepAfterPath(segment: readonly TrendCoordinate[]): string {
  const first = segment[0];
  if (!first) return "";
  return segment.slice(1).reduce(
    (path, point) => `${path} H ${point.x.toFixed(1)} V ${point.y.toFixed(1)}`,
    `M ${first.x.toFixed(1)},${first.y.toFixed(1)}`,
  );
}

export function TrendChart({
  points,
  label,
  compact = false,
  threshold,
  rollingAverage,
  comparison,
}: {
  points: readonly FilledSeriesPoint[];
  label: string;
  compact?: boolean;
  threshold?: number;
  rollingAverage?: readonly FilledSeriesPoint[];
  comparison?: { points: readonly FilledSeriesPoint[]; label: string };
}) {
  const values = points.map((point) => point.value).filter((value): value is number => value !== null);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 100);
  const width = 640;
  const height = compact ? 70 : 230;
  const pad = compact ? 4 : 28;
  const plotWidth = width - pad * 2;
  const plotHeight = height - pad * 2;
  const x = (index: number) => pad + (points.length <= 1 ? 0 : (index / (points.length - 1)) * plotWidth);
  const y = (value: number) => pad + ((max - value) / Math.max(1, max - min)) * plotHeight;
  const segments = contiguousTrendSegments(points.map((point, index) =>
    point.value === null ? null : { x: x(index), y: y(point.value) }
  ));
  const paths = segments.map((segment) => ({
    line: stepAfterPath(segment),
    area: `${stepAfterPath(segment)} L ${segment.at(-1)!.x.toFixed(1)},${height - pad} L ${segment[0]!.x.toFixed(1)},${height - pad} Z`,
  }));
  const primarySegments = points.slice(1).flatMap((point, index) => {
    const previous = points[index];
    if (previous?.value === null || previous?.value === undefined || point.value === null) return [];
    const coverage = trendTransitionCoverage(previous, point);
    return [
      { d: `M ${x(index).toFixed(1)},${y(previous.value).toFixed(1)} H ${x(index + 1).toFixed(1)}`, carried: coverage.horizontalCarried, key: `${previous.date}:${point.date}:horizontal` },
      { d: `M ${x(index + 1).toFixed(1)},${y(previous.value).toFixed(1)} V ${y(point.value).toFixed(1)}`, carried: coverage.verticalCarried, key: `${previous.date}:${point.date}:vertical` },
    ];
  });
  const overlayPaths = (series: readonly FilledSeriesPoint[]): readonly string[] => {
    const overlayX = (index: number) => pad + (series.length <= 1 ? 0 : (index / (series.length - 1)) * plotWidth);
    return contiguousTrendSegments(series.map((point, index) => point.value === null ? null : { x: overlayX(index), y: y(point.value) }))
      .map((segment) => segment.reduce((path, point) => `${path}${path ? " L" : "M"} ${point.x.toFixed(1)},${point.y.toFixed(1)}`, ""));
  };
  const rollingPaths = rollingAverage ? overlayPaths(rollingAverage) : [];
  const comparisonPaths = comparison ? overlayPaths(comparison.points) : [];
  const accessibleSeries = [
    `Primary series: ${points.map((point) => `${point.date} ${point.value === null ? "unavailable" : point.value.toFixed(1)}`).join(", ")}.`,
    rollingAverage ? `Rolling-average series: ${rollingAverage.map((point) => `${point.date} ${point.value === null ? "unavailable" : point.value.toFixed(1)}`).join(", ")}.` : "",
    comparison ? `${comparison.label} series: ${comparison.points.map((point) => `${point.date} ${point.value === null ? "unavailable" : point.value.toFixed(1)}`).join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  const lastValue = (series: readonly FilledSeriesPoint[] | undefined): number | null => {
    if (!series) return null;
    for (let index = series.length - 1; index >= 0; index -= 1) {
      const value = series[index]?.value;
      if (value !== null && value !== undefined) return value;
    }
    return null;
  };
  return (
    <svg className={compact ? "trend-chart trend-chart--compact" : "trend-chart"} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} preserveAspectRatio="none">
      <title>{label}</title>
      <desc>Risk history. Solid points are observed snapshots; dashed segments include carried or mixed-coverage daily values. {accessibleSeries}</desc>
      {!compact ? [25, 50, 75].map((value) => <line className="chart-grid" key={value} x1={pad} x2={width - pad} y1={y(value)} y2={y(value)} />) : null}
      {threshold !== undefined ? <line className="chart-threshold" x1={pad} x2={width - pad} y1={y(threshold)} y2={y(threshold)} /> : null}
      {paths.map((path, index) => <path className="trend-area" d={path.area} key={`area-${index}`} />)}
      {primarySegments.map((segment) => <path className={segment.carried ? "trend-path trend-path--carried" : "trend-path"} d={segment.d} key={segment.key} />)}
      {comparisonPaths.map((path, index) => <path className="trend-overlay trend-overlay--previous" d={path} key={`comparison-${index}`} />)}
      {rollingPaths.map((path, index) => <path className="trend-overlay trend-overlay--rolling" d={path} key={`rolling-${index}`} />)}
      {points.map((point, index) => {
        if (point.value === null) return null;
        const state = point.mixed
          ? `mixed coverage: ${point.observedCount ?? 0} observed, ${point.forwardFilledCount ?? 0} carried, ${point.missingCount ?? 0} unavailable`
          : point.observed
          ? "observed source point"
          : point.stale
            ? `stale carry from ${point.forwardFilledFrom ?? "an earlier observation"}`
            : `carried forward from ${point.forwardFilledFrom ?? "an earlier observation"}`;
        const pointTitle = `${point.date}: ${point.value.toFixed(1)} · ${state}`;
        return <circle className={point.observed ? "trend-point" : point.mixed ? "trend-point trend-point--mixed" : "trend-point trend-point--carried"} key={point.date} cx={x(index)} cy={y(point.value)} r={point.observed ? (compact ? 2.8 : 4.2) : point.mixed ? 3 : 2} aria-hidden="true"><title>{pointTitle}</title></circle>;
      })}
      {!compact ? (
        <>
          <text className="chart-axis-label" x={pad} y={height - 5}>{points[0]?.date.slice(5)}</text>
          <text className="chart-axis-label" x={width - pad} y={height - 5} textAnchor="end">{points.at(-1)?.date.slice(5)}</text>
          {lastValue(rollingAverage) !== null ? <text className="chart-series-label chart-series-label--rolling" x={width - pad} y={y(lastValue(rollingAverage)!)-6} textAnchor="end">{`7d avg ${lastValue(rollingAverage)!.toFixed(1)}`}</text> : null}
          {lastValue(comparison?.points) !== null ? <text className="chart-series-label chart-series-label--previous" x={width - pad} y={y(lastValue(comparison?.points)!)+12} textAnchor="end">{`${comparison?.label} ${lastValue(comparison?.points)!.toFixed(1)}`}</text> : null}
        </>
      ) : null}
    </svg>
  );
}

export function ProgressBar({ value, tone = "blue", label }: { value: number; tone?: "blue" | "orange" | "red" | "green" | "violet"; label: string }) {
  const style = { "--progress": `${Math.max(0, Math.min(100, value))}%` } as CSSProperties;
  return <span className={`progress progress--${tone}`} style={style} role="img" aria-label={`${label}: ${Math.round(value)} out of 100`}><span /></span>;
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`.trim()}>{children}</section>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">○</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatDate(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}
