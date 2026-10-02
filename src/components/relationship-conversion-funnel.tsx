"use client";

import type { RecordIdentity, RiskRecord, RiskRelationship } from "@/lib/canonical/types";
import { buildRelationshipConversionEvidence } from "@/lib/risk/relationship-conversion-evidence";
import { formatDate, SourceChip } from "./risk-ui";
import styles from "./relationship-conversion-funnel.module.css";

export function RelationshipConversionFunnel({ relationships, records, minimumEdgeCount, onContributor, className }: {
  relationships: readonly RiskRelationship[];
  records: readonly Pick<RiskRecord, "projectId" | "kind" | "id" | "domain">[];
  minimumEdgeCount?: number;
  onContributor: (identity: RecordIdentity) => void;
  className?: string;
}) {
  const model = buildRelationshipConversionEvidence(relationships, { records, ...(minimumEdgeCount ? { minimumEdgeCount } : {}) });
  return <section className={`${styles.panel}${className ? ` ${className}` : ""}`}>
    <header><div><p className="eyebrow">RELATIONSHIP CONVERSION EVIDENCE</p><h2>Connected stages, without a causal funnel</h2><p>Raw link populations are shown independently. A percentage is never calculated from these thin, undirected edge sets.</p></div><SourceChip label="Synthetic" /></header>
    <div className={styles.stages}>{model.stages.map((stage) => <article key={stage.id} className={stage.coverageState === "unsupported" ? styles.unsupported : ""}><span>{stage.label}</span><b>{stage.rawEdgeCount ?? "N/A"}</b><small>{stage.coverageState === "unsupported" ? "not available in ACC" : stage.coverageState === "no-links-recorded" ? "no links recorded" : stage.coverageState === "insufficient-data" ? `insufficient data · minimum ${model.minimumEdgeCount}` : `minimum ${model.minimumEdgeCount} met`}</small><em>Conversion % not asserted</em></article>)}</div>
    <div className={styles.timelineHead}><div><p className="eyebrow">NON-DIRECTIONAL TIMELINE</p><h3>{model.contributors.length ? `${model.contributors.length} classified link${model.contributors.length === 1 ? "" : "s"}` : "No links recorded"}</h3></div>{model.unclassifiedEdgeCount ? <span>{model.unclassifiedEdgeCount} other edge{model.unclassifiedEdgeCount === 1 ? "" : "s"} outside these stages</span> : null}</div>
    {model.contributors.length ? <ol className={styles.timeline}>{model.contributors.map((contributor) => <li key={`${contributor.edge.projectId}:${contributor.edge.id}`}><time>{contributor.recordedAt ? formatDate(contributor.recordedAt) : "Recorded time unavailable"}</time><span className={`${styles.confidence} ${styles[`confidence_${contributor.edge.confidence}`]}`}>{contributor.edge.confidence}</span><div><button onClick={() => onContributor(contributor.endpointA)}>{contributor.endpointA.label}</button><span aria-hidden="true"> ↔ </span><button onClick={() => onContributor(contributor.endpointB)}>{contributor.endpointB.label}</button><small>{contributor.ownershipLabel} · {contributor.edge.evidence}</small></div></li>)}</ol> : <p className={styles.empty}>No supported relationship pair matches the active scope. Absence of a link does not establish that records are unrelated.</p>}
    <footer><p>{model.caption}</p><small>Counts below {model.minimumEdgeCount} are labelled insufficient data. Percentages remain suppressed even when the minimum is met because these stages are not a directional population.{model.noRelationshipCandidateCount ? ` ${model.noRelationshipCandidateCount} candidate pair${model.noRelationshipCandidateCount === 1 ? " is" : "s are"} marked confidence “none” and excluded from every edge count.` : ""}</small></footer>
  </section>;
}
