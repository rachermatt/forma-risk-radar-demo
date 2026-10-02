"use client";

import type { RecordIdentity, RiskRecord } from "@/lib/canonical/types";
import { formRecordMatchesSignal, formSignalIdentityKey, type DemoDataset, type ProjectRiskSummary } from "@/lib/demo/types";
import { buildSafetyObservationBalance, safetyObservationSourceAvailabilityForProjects } from "@/lib/risk/safety-observation";
import { SourceChip } from "./risk-ui";

export interface SafetyLeadingIndicatorsProps {
  readonly data: DemoDataset;
  readonly projects: readonly ProjectRiskSummary[];
  readonly records: readonly RiskRecord[];
  readonly onRecord: (identity: RecordIdentity) => void;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value));
}

export function SafetyLeadingIndicators({ data, projects, records, onRecord }: SafetyLeadingIndicatorsProps) {
  const visibleProjectIds = new Set(projects.map((project) => project.project.id));
  const balance = buildSafetyObservationBalance(
    records,
    data.asOf,
    20,
    safetyObservationSourceAvailabilityForProjects(
      [...visibleProjectIds],
      data.ciqSourceCoverage.issueSafetyObservationProjectIds,
    ),
  );
  const safetySourceAvailable = balance.sourceCoverage.available;
  const safetyProjectCoverage = balance.sourceCoverage.coveredProjects !== null && balance.sourceCoverage.scopeProjects !== null
    ? `${balance.sourceCoverage.coveredProjects}/${balance.sourceCoverage.scopeProjects} visible projects covered`
    : null;
  const formSignals = data.formSignals.flatMap((signal) => {
    if (!visibleProjectIds.has(signal.projectId)) return [];
    const matching = records.filter((record) => formRecordMatchesSignal(record, signal));
    if (!matching.length) return [];
    const current = matching.filter((record) => record.raw?.period_bucket === "current");
    const previous = matching.filter((record) => record.raw?.period_bucket === "previous");
    return [{
      ...signal,
      current,
      previous,
      change: previous.length ? 100 * (current.length - previous.length) / previous.length : null,
      exceptions: current.filter((record) => record.raw?.application_defined_exception === true),
    }];
  });
  const maximum = Math.max(1, ...balance.periods.flatMap((period) => [period.positive, period.negative]));
  return <>
    <header className="dashboard-header safety-leading-header">
      <div><p className="eyebrow">BALANCED SAFETY EVIDENCE</p><h1>Safety observations &amp; checklist leading indicators</h1><p>Positive and negative classifications are shown together. Checklist activity is a leading signal for investigation, never an employee, trade, or company performance score.</p></div>
    </header>
    <section className="safety-balance-summary" aria-label="Safety observation balance">
      <article><span>Positive observations</span><b>{safetySourceAvailable ? balance.positive : "N/A"}</b><small>{safetySourceAvailable ? `Construction IQ-classified rows${safetyProjectCoverage ? ` · ${safetyProjectCoverage}` : ""}` : balance.sourceCoverage.unavailableReason}</small><SourceChip provenance={balance.provenance} /></article>
      <article><span>Negative observations</span><b>{safetySourceAvailable ? balance.negative : "N/A"}</b><small>{safetySourceAvailable ? `Construction IQ-classified rows${safetyProjectCoverage ? ` · ${safetyProjectCoverage}` : ""}` : balance.sourceCoverage.unavailableReason}</small><SourceChip provenance={balance.provenance} /></article>
      <article><span>Positive share</span><b>{!safetySourceAvailable ? "N/A" : balance.positiveShare === null ? "—" : `${Math.round(balance.positiveShare * 100)}%`}</b><small>{!safetySourceAvailable ? balance.sourceCoverage.unavailableReason : balance.positiveShare === null ? `insufficient data · ${balance.classified}/${balance.minimumForShare} classified` : `${balance.positive} of ${balance.classified} classified`}</small><SourceChip provenance={balance.provenance} /></article>
    </section>
    <section className="safety-leading-grid">
      <article className="safety-trend-panel">
        <div className="safety-panel-head"><div><p className="eyebrow">28-DAY CURRENT-LABEL COHORT</p><h2>Rows grouped by current classification time</h2></div><SourceChip provenance={balance.provenance} /></div>
        {balance.events.some((event) => event.observedAt) ? <div className="safety-periods" role="group" aria-label="Weekly positive and negative safety observations">{balance.periods.map((period) => <div key={period.startAt} role="img" aria-label={`${dateLabel(period.startAt)}: ${period.positive} positive and ${period.negative} negative observations`}><span className="safety-bars" aria-hidden="true"><i className="safety-bar safety-bar--positive" style={{ height: `${100 * period.positive / maximum}%` }} /><i className="safety-bar safety-bar--negative" style={{ height: `${100 * period.negative / maximum}%` }} /></span><small>{dateLabel(period.startAt)}</small><b>{period.positive}+ / {period.negative}−</b></div>)}</div> : <p className="empty-copy">{safetySourceAvailable ? "Historical observation timestamps are unavailable. Current positive and negative counts remain visible without a fabricated trend." : balance.sourceCoverage.unavailableReason}</p>}
        <p className="method-note"><b>Interpretation:</b> this groups current sidecar rows by their prediction timestamp; it is not archived observation-balance history. Reporting behavior and sparse classification coverage can change the balance, and this is not a safety score.</p>
      </article>
      <article className="safety-evidence-panel">
        <div className="safety-panel-head"><div><p className="eyebrow">CONTRIBUTING RECORDS</p><h2>{!safetySourceAvailable ? "Safety classification source unavailable" : balance.classified ? `${balance.classified} classified observations` : "No classified observations"}</h2></div></div>
        {balance.events.length ? <div className="safety-evidence-list">{balance.events.slice(0, 12).map((event) => <button key={`${event.record.projectId}:${event.record.kind}:${event.record.id}`} onClick={() => onRecord(event.record)}><span className={`safety-observation safety-observation--${event.category}`}>{event.category}</span><span><strong>{event.record.title}</strong><small>{event.record.displayId ?? event.record.id} · {event.observedAt ? `classified ${dateLabel(event.observedAt)}` : "classification time unavailable"}</small></span><span aria-hidden="true">→</span></button>)}</div> : <p className="empty-copy">{safetySourceAvailable ? "No positive or negative safety-observation sidecar matches the active scope. Absence does not mean no safety activity occurred." : balance.sourceCoverage.unavailableReason}</p>}
      </article>
    </section>
    <section className="checklist-leading-panel">
      <div className="safety-panel-head"><div><p className="eyebrow">LEADING RISK INDICATORS</p><h2>Checklist and form activity</h2></div><SourceChip label="Synthetic" /></div>
      {formSignals.length ? <div className="checklist-signal-list">{formSignals.map((signal) => <article key={formSignalIdentityKey(signal)}><span><strong>{signal.templateName}</strong><small>{projects.find((project) => project.project.id === signal.projectId)?.project.name ?? signal.projectId} · {signal.domain} · distinct template/layout</small></span><b className="metric-neutral">{signal.change === null ? "—" : `${signal.change > 0 ? "+" : ""}${signal.change.toFixed(1)}%`}</b><SourceChip provenance={signal.provenance} /><p>{signal.current.length} current vs {signal.previous.length} prior · {signal.exceptions.length} configured exceptions. {signal.note}</p>{signal.exceptions.length >= 2 ? <div className="checklist-suggestion"><strong>Suggested action · advisory</strong><p>Review the configured exception fields, identify the responsible location or trade, perform a targeted inspection, and verify corrective action before follow-on work.</p><small>Deterministic rule · mitigation.form-exception-review.v1 · {signal.exceptions.length} cited forms. This does not claim the same checklist question failed or that the exceptions measure conformance.</small><span>{signal.exceptions.map((record) => <button key={`${record.projectId}:${record.id}`} onClick={() => onRecord(record)}>{record.displayId ?? record.id}</button>)}</span></div> : null}{signal.current[0] ? <button onClick={() => onRecord(signal.current[0]!)}>Inspect contributing form <span aria-hidden="true">→</span></button> : null}</article>)}</div> : <p className="empty-copy">No checklist activity series matches the active scope. No deterioration or conformance conclusion is inferred.</p>}
      <p className="method-note"><b>Leading-indicator rule:</b> activity change and application-configured exceptions prompt investigation only. Autodesk does not publish a checklist conformance score, and correlation is not causation.</p>
    </section>
  </>;
}
