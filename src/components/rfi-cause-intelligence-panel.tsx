"use client";

import type { RecordIdentity } from "@/lib/canonical/types";
import type { RfiCauseGroup, RfiCauseIntelligence } from "@/lib/risk/rfi-cause-intelligence";
import { EmptyState, SourceChip } from "./risk-ui";
import styles from "./rfi-cause-intelligence-panel.module.css";

function number(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value.toFixed(value % 1 ? 1 : 0)}${suffix}`;
}

function originLabel(group: RfiCauseGroup): string {
  return group.origin === "construction-iq-predicted" ? "CIQ-predicted root cause" : "Project-configured RFI category";
}

function projectCoverage(source: RfiCauseIntelligence["sourceCoverage"][number]): string {
  return source.coveredProjects === null || source.scopeProjects === null
    ? ""
    : ` · ${source.coveredProjects}/${source.scopeProjects} projects covered`;
}

export function RfiCauseIntelligencePanel({ intelligence, onRecord, limit }: {
  intelligence: RfiCauseIntelligence;
  onRecord: (identity: RecordIdentity) => void;
  limit?: number;
}) {
  const groups = intelligence.groups.slice(0, limit ?? intelligence.groups.length);
  const maximum = Math.max(1, ...groups.flatMap((group) => group.weeklyCreated.map((point) => point.count)));
  const ciqSource = intelligence.sourceCoverage.find((source) => source.origin === "construction-iq-predicted")!;
  const operationalSource = intelligence.sourceCoverage.find((source) => source.origin === "operational-category")!;
  return <>
    <header className={styles.header}><div><p className="eyebrow">SOURCE-QUALIFIED RFI CAUSES</p><h1>RFI cause intelligence</h1><p>Construction IQ predictions and project-configured operational categories remain separate. Counts, aging, response coverage, reach, and recurrence all drill to the exact RFI population.</p></div><SourceChip provenance={intelligence.provenance} /></header>
    <section className={styles.coverage} aria-label="RFI cause coverage">
      <article><span>RFIs in scope</span><b>{intelligence.totalRfis}</b><small>current filtered records</small><SourceChip provenance={intelligence.provenance} /></article>
      <article><span>CIQ cause coverage</span><b>{!ciqSource.available ? "N/A" : ciqSource.eligibleRfis ? `${intelligence.ciqAttributed}/${ciqSource.eligibleRfis}` : "—"}</b><small>{ciqSource.available ? `${intelligence.ciqUnattributed} without a CIQ cause${projectCoverage(ciqSource)}` : ciqSource.unavailableReason}</small><SourceChip label="Synthetic" syntheticKind="Autodesk-shaped field" /></article>
      <article><span>Operational category coverage</span><b>{!operationalSource.available ? "N/A" : operationalSource.eligibleRfis ? `${intelligence.operationalAttributed}/${operationalSource.eligibleRfis}` : "—"}</b><small>{operationalSource.available ? `${intelligence.operationalUnattributed} without a category${projectCoverage(operationalSource)}` : operationalSource.unavailableReason}</small><SourceChip label="Synthetic" syntheticKind="Autodesk-shaped field" /></article>
    </section>
    {intelligence.state === "empty" ? <section className={styles.empty}><EmptyState title="No RFIs in this scope" detail="No RFI record matches the active filters, so cause shares and coverage are unavailable rather than zero." /></section> : groups.length ? <section className={styles.groups}>{groups.map((group) => <article className={styles.group} key={group.key}>
      <header><div><span>{originLabel(group)}</span><h2>{group.label}</h2>{group.projectId ? <small>Project-scoped vocabulary · {group.contributors[0]?.projectLabel}</small> : <small>Cross-project observed label · undocumented value set</small>}</div><div><b>{group.count}</b><span>{group.share === null ? "—" : `${Math.round(group.share * 100)}%`}</span></div></header>
      <div className={styles.metrics}><div><span>Open age</span><b>{number(group.openAge.median, "d")}</b><small>median · {group.openAge.count}/{group.count} open</small></div><div><span>Response duration</span><b>{number(group.responseDuration.median, "d")}</b><small>median · {group.responseDuration.count}/{group.count} with response</small></div><div><span>Reach</span><b>{group.projectsAffected}p · {group.companiesAffected}c</b><small>{group.disciplines.length ? group.disciplines.join(" · ") : "discipline unavailable"}</small></div><div><span>180-day recurrence</span><b>{group.recurrence.populationRate === null ? "—" : `${Math.round(group.recurrence.populationRate * 100)}%`}</b><small>{group.recurrence.occurrencesWithinWindow} group events · {group.recurrence.repeatedEvents} after first{group.recurrence.suppressedReason ? ` · rate suppressed (${group.recurrence.populationDistinctSignatures}/${group.recurrence.minimumDistinctSignatures} distinct signatures)` : " · rate uses all relevant events for this source origin"}</small></div></div>
      <div className={styles.trend}><div><span>12-week RFI creation pattern</span><small>Current cause label grouped by RFI creation date; not historical classification state.</small></div><div className={styles.bars} role="img" aria-label={`${group.label}: weekly created counts ${group.weeklyCreated.map((point) => point.count).join(", ")}`}>{group.weeklyCreated.map((point) => <i key={point.weekStart} style={{ height: `${Math.max(2, 100 * point.count / maximum)}%` }} />)}</div></div>
      {group.count >= 2 && group.label.trim().toLocaleLowerCase("en-US") === "design coordination" ? <div className={styles.trend}><div><span>Suggested action · advisory</span><small>Deterministic rule · mitigation.rfi-design-concentration.v1</small></div><div><span>Focused coordination review</span><small>Group these RFIs by discipline and source-qualified cause, then evaluate affected downstream work. The shared label does not establish one upstream cause. {group.evidence.length} cited RFI{group.evidence.length === 1 ? "" : "s"} are listed below.</small></div></div> : null}
      <details><summary>Inspect {group.contributors.length} contributing RFI{group.contributors.length === 1 ? "" : "s"}</summary><div className={styles.contributors}>{group.contributors.map((contributor) => <button key={contributor.identityKey} onClick={() => onRecord(contributor.identity)}><span><strong>{contributor.displayId} · {contributor.title}</strong><small>{contributor.projectLabel} · {contributor.discipline ?? "discipline unavailable"}</small><em>{contributor.openAgeDays === null ? "closed/current age not applicable" : `${contributor.openAgeDays} days open`} · {contributor.responseDays === null ? "response timestamp unavailable" : `${contributor.responseDays} days to response`}</em></span><span aria-hidden="true">→</span></button>)}</div></details>
    </article>)}</section> : <section className={styles.empty}><EmptyState title={intelligence.sourceCoverage.every((source) => !source.available) ? "Cause sources unavailable" : "No populated cause values"} detail={intelligence.sourceCoverage.every((source) => !source.available) ? "RFIs are present, but neither source family is available for this scope. Missing sources are not counted as unattributed records." : "Available source families contain no populated Construction IQ-predicted cause or project-configured RFI category. Null values stay outside the share denominator."} /></section>}
    <section className={styles.note}><p><b>Source separation:</b> the RFI object has no supported root-cause field. Construction IQ root cause is a prediction from Data Connector; operational RFI category is project-configured and remains project-scoped.</p><p><b>Recurrence denominator:</b> repeated events ÷ all relevant events across every distinct signature for the same source origin within 180 days. Rates are suppressed below eight distinct signatures; group cards still show raw occurrences and repeats.</p><p><b>Trend limitation:</b> source snapshots do not retain historical CIQ cause labels in this fixture. The bars show creation dates under each record’s current label, never a fabricated classification history.</p></section>
  </>;
}
