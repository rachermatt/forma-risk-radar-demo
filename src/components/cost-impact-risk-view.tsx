"use client";

import type { RecordIdentity } from "@/lib/canonical/types";
import type { CostImpactRiskViewModel } from "@/lib/risk/cost-impact-view";
import { EmptyState, formatDate, SourceChip } from "./risk-ui";
import styles from "./cost-impact-risk-view.module.css";

function bucketNote(category: CostImpactRiskViewModel["buckets"][number]["category"]): string {
  if (category === "confirmed") return "RFI Yes or CIQ categorical High. “Confirmed” describes the source flag/classification, not a confirmed currency amount.";
  if (category === "potential") return "RFI Unknown or CIQ categorical Medium. All such exposure remains unquantified.";
  if (category === "explicit-negative") return "RFI No and CIQ Low are explicit source values. They remain distinct from missing data and do not prove that no financial impact exists.";
  if (category === "unclassified") return "RFI null (field absent or disabled) and CIQ not classified remain unavailable, not No.";
  return "Unexpected source values are retained as unmapped for remediation and receive no inferred meaning.";
}

export interface CostImpactRiskViewProps {
  model: CostImpactRiskViewModel;
  onRecord: (identity: RecordIdentity) => void;
  title?: string;
}

export function CostImpactRiskView({ model, onRecord, title = "Cost-impact evidence" }: CostImpactRiskViewProps) {
  return <>
    <header className="page-head page-head--view">
      <div><p className="eyebrow">CATEGORICAL AND TRI-STATE EVIDENCE</p><h1>{title}</h1><p>Keep affirmative, potential, explicit negative/low, unavailable, and unmapped source states separate without inventing a dollar value or attributing a linked change amount to a risk record.</p></div>
      <SourceChip provenance={model.provenance} />
    </header>
    <section className={styles.summary} aria-label="Cost-impact evidence summary">
      <article><span>Unquantified signals</span><b>{model.state === "unavailable" ? "—" : model.unquantifiedSignalCount}</b><small>confirmed + potential categories</small><SourceChip provenance={model.provenance} /></article>
      <article><span>Current denominator</span><b>{model.state === "unavailable" ? "—" : model.denominator}</b><small>open Issues and RFIs only</small><SourceChip provenance={model.provenance} /></article>
      <article><span>RFI Unknown</span><b>{model.state === "unavailable" ? "—" : model.rfiUnknownCount}</b><small>retained as unknown, never No</small><SourceChip provenance={model.provenance} /></article>
      <article><span>As of</span><b>{formatDate(model.asOf)}</b><small>{model.scopeLabel}</small></article>
    </section>
    {model.state === "unavailable" ? <section className={styles.empty}><EmptyState title="Cost-impact source unavailable" detail={model.unavailableReason ?? "Source coverage is unavailable for this scope."} /></section> : model.state === "empty" ? <section className={styles.empty}><EmptyState title="No classifiable current records" detail="No open Issue or RFI matches the active scope. This is an empty evidence population, not proof that no cost impact exists." /></section> : <section className={styles.grid} aria-label="Cost-impact categories">
      {model.buckets.map((bucket) => <article className={styles.card} key={bucket.category}>
        <div className={styles.cardHead}><span className={`${styles.marker} ${styles[`marker_${bucket.category}`]}`} aria-hidden="true">{bucket.category === "confirmed" ? "!" : bucket.category === "potential" ? "?" : bucket.category === "unmapped" ? "×" : "–"}</span><SourceChip provenance={bucket.provenance} /></div>
        <h2>{bucket.label}</h2>
        <div className={styles.value}><b>{bucket.count}</b><span>{bucket.share === null ? "—" : `${bucket.share.toFixed(1)}%`}</span></div>
        <p>{bucket.count} of {model.denominator} scoped, open Issue/RFI records.</p>
        <small>{bucketNote(bucket.category)}</small>
        <details>
          <summary>{bucket.contributors.length ? `Inspect ${bucket.contributors.length} contributor${bucket.contributors.length === 1 ? "" : "s"}` : "No contributors in this category"}</summary>
          <div className={styles.contributors}>{bucket.contributors.map((contributor) => <button key={contributor.identityKey} onClick={() => onRecord(contributor.identity)}><span><strong>{contributor.displayId} · {contributor.title}</strong><small>{contributor.projectLabel} · {contributor.sourceLabel}</small><em>{contributor.explanation}</em></span><span aria-hidden="true">→</span></button>)}</div>
        </details>
      </article>)}
    </section>}
    <section className={styles.disclosure}><p><b>No dollar claim.</b> Issues expose only Construction IQ categorical cost impact; RFIs expose Yes/No/Unknown or null when the field is absent/disabled. Neither supplies an issue-level monetary amount.</p><p><b>No causal attribution.</b> A cost-record edge is shown separately as an undirected association; its amount is never assigned to the linked Issue or RFI.</p><p><b>Population.</b> {model.excludedRecordCount} closed or unsupported-kind record{model.excludedRecordCount === 1 ? " is" : "s are"} outside the current cost-classifiable denominator.</p></section>
  </>;
}
