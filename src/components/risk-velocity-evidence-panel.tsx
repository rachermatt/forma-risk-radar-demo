"use client";

import type { RiskVelocityEvidence, VelocityMetric } from "@/lib/risk/risk-velocity";
import { EmptyState, SourceChip, TrendChart } from "./risk-ui";
import styles from "./risk-velocity-evidence-panel.module.css";

function display(metric: VelocityMetric): string {
  if (metric.value === null) return "—";
  const value = Math.round(metric.value * 10) / 10;
  const signed = ["change1d", "change7d", "change28d", "acceleration"].includes(metric.id) && value > 0 ? `+${value}` : String(value);
  return signed;
}

export function RiskVelocityEvidencePanel({ velocity }: { velocity: RiskVelocityEvidence }) {
  if (velocity.state === "unavailable") return <section className={styles.panel}><header><div><p className="eyebrow">RISK VELOCITY</p><h2>Momentum evidence unavailable</h2></div><SourceChip provenance={velocity.provenance} /></header><EmptyState title="Velocity cannot be calculated for this scope" detail={velocity.unavailableReason ?? "Historical evidence is unavailable."} /></section>;
  return <section className={styles.panel}>
    <header><div><p className="eyebrow">RISK VELOCITY</p><h2>Change, acceleration, and risk flow</h2><p>Existing snapshot momentum values are aggregated without replacing missing history. Positive change means risk increased; negative change means improvement.</p></div><div><span className={styles.coverage}>{velocity.coverageState.replaceAll("-", " ")}</span><SourceChip provenance={velocity.provenance} /></div></header>
    <div className={styles.metrics}>{velocity.metrics.map((metric) => <article key={metric.id}><span>{metric.label}</span><b className={metric.value !== null && ["change1d", "change7d", "change28d", "acceleration"].includes(metric.id) ? metric.value > 0 ? styles.worse : metric.value < 0 ? styles.better : "" : ""}>{display(metric)}</b><small>{metric.unavailableReason ?? `${metric.unit} · ${metric.coverageCount}/${metric.populationCount} projects`}</small><SourceChip provenance={metric.provenance} /></article>)}</div>
    <div className={styles.detail}><div><p className="eyebrow">RATE OF CHANGE</p><strong>{velocity.rateQualifier === "steady-rate" ? "Steady rate" : velocity.rateQualifier === "unavailable" ? "Unavailable" : velocity.rateQualifier.charAt(0).toUpperCase() + velocity.rateQualifier.slice(1)}</strong><p>The acceleration qualifier uses the mean stored second-difference where covered; it does not infer future risk.</p></div><dl><div><dt>Observed days</dt><dd>{velocity.coverage.observed}</dd></div><div><dt>Carried days</dt><dd>{velocity.coverage.carried}</dd></div><div><dt>Missing days</dt><dd>{velocity.coverage.missing}</dd></div><div><dt>Stale days</dt><dd>{velocity.coverage.stale}</dd></div></dl></div>
    {velocity.series.length ? <div className={styles.chart}><TrendChart points={velocity.series} label={`${velocity.scopeLabel} daily risk velocity evidence`} /><p>Daily portfolio series. Dashed segments are forward-filled; they are evidence of last-known state, not a new observation.</p></div> : <EmptyState title="Daily series unavailable" detail="The exact stored deltas remain visible above; a whole-project series is never substituted for a domain or record-filtered scope." />}
  </section>;
}
