import type { ValueKind } from "../canonical/types";
import { RISK_DEFINITION_VERSION } from "./definitions";

export interface MetricDefinitionMetadata {
  readonly id: string;
  readonly version: typeof RISK_DEFINITION_VERSION;
  readonly title: string;
  readonly valueKind: ValueKind;
  readonly catalogSection: string;
}

function definition(
  id: string,
  title: string,
  catalogSection: string,
  valueKind: ValueKind = "application-derived",
): MetricDefinitionMetadata {
  return Object.freeze({ id, version: RISK_DEFINITION_VERSION, title, valueKind, catalogSection });
}

const entries: MetricDefinitionMetadata[] = [
  definition("risk.index", "Project risk index", "§6"),
  definition("risk.index.filtered", "Filtered project risk index", "§6"),
  definition("risk.domain.condition", "Risk-domain condition", "§6.11"),
  definition("risk.portfolio.mean-project-index", "Portfolio mean project risk", "§6"),
  definition("risk.portfolio.filtered-mean-project-index", "Filtered portfolio mean project risk", "§6"),
  definition("risk.quality.high-open", "Open High Construction IQ issues", "§5.2"),
  definition("risk.rfi.high-open", "Open High Construction IQ RFIs", "§6.8"),
  definition("risk.safety.signal-count", "Open issue safety-signal count", "§6.10"),
  definition("risk.critical-overdue", "Critical overdue risk items", "§6.6"),
  definition("exposure.index", "Project exposure index", "§7.1"),
  definition("exposure.portfolio.mean-project-index", "Portfolio mean project exposure", "§7.1"),
  definition("exposure.portfolio.filtered-mean-project-index", "Filtered portfolio mean project exposure", "§7.1"),
  definition("exposure.cost-impact.filtered-categories", "Filtered cost-impact evidence", "§7.8"),
  definition("momentum.direction", "Project momentum direction", "§8.1"),
  definition("momentum.portfolio.mean-project-series", "Portfolio mean project history", "§8"),
  definition("momentum.portfolio.filtered-mean-project-change", "Filtered portfolio mean project change", "§8"),
  definition("momentum.projects.increased-7d", "Projects with increased seven-day risk", "§8.1"),
  definition("momentum.velocity.current-scope", "Current-scope risk velocity", "§8"),
  definition("actionability.index", "Project actionability index", "§13"),
  definition("actionability.index.filtered-records", "Filtered-record actionability index", "§13"),
  definition("persistence.filtered-open-high-over-30d", "Filtered persistent High risk", "§11"),
  definition("burn.rate", "Risk burn rate", "§15"),
  definition("burn.weekly-flow", "Weekly risk flow", "§15"),
  definition("hotspot.location-overlap", "Location overlap hotspot", "§18"),
  definition("attention.score", "Attention priority score", "§19"),
  definition("form.activity-signal", "Form activity signal", "§16"),
  definition("form.activity.filtered", "Filtered form activity", "§16"),
  definition("safety.observation-balance", "Safety observation balance", "§16", "application-derived"),
  definition("relationships.conversion-evidence.filtered", "Filtered relationship conversion evidence", "§10"),
  definition("rfi.root-cause.current-scope", "Current-scope RFI cause intelligence", "§9"),
  definition("rfi.root-cause.concentration.construction-iq-predicted", "Construction IQ RFI cause concentration", "§9"),
  definition("rfi.root-cause.concentration.operational-category", "Operational RFI category concentration", "§9"),
  definition("rfi.root-cause.label.construction-iq-predicted", "Construction IQ RFI cause label", "§9", "autodesk-provided"),
  definition("rfi.root-cause.label.operational-category", "Operational RFI category label", "§9", "autodesk-provided"),
  definition("ciq.project.quality.daily-risk", "Construction IQ project daily quality risk", "§5.1", "autodesk-provided"),
  definition("ciq.company.quality.daily-risk", "Construction IQ company daily quality risk", "§5.3", "autodesk-provided"),
  definition("ciq.company.safety.daily-risk", "Construction IQ company daily safety risk", "§5.3", "autodesk-provided"),
  definition("indicator.projects.monitored", "Projects monitored", "§2.3"),
  definition("indicator.projects.requiring-attention", "Projects requiring attention", "§19"),
  definition("indicator.quality.classified-open", "Open classified issues", "§5.2"),
  definition("indicator.issue.recorded-root-cause-open", "Open issues by recorded cause", "§14"),
  definition("indicator.company.high-risk-signal-count", "Company High-risk signal count", "§5.3"),
  definition("indicator.records.overdue-filtered", "Filtered overdue records", "§2.4"),
];

for (const category of ["confirmed", "potential", "explicit-negative", "unclassified", "unmapped"] as const) {
  entries.push(definition(`exposure.cost-impact.${category}`, `Cost-impact ${category} category`, "§7.8"));
}

for (const metric of ["change1d", "change7d", "change28d", "rollingAverage7d", "acceleration", "consecutiveElevatedPeriods", "newlyClassifiedRate", "newHighRiskRate", "resolvedHighRiskRate"] as const) {
  entries.push(definition(`momentum.velocity.${metric}`, `Risk velocity ${metric}`, "§8"));
}

for (const dimension of ["company", "trade", "root-cause", "iq-root-cause", "discipline", "location", "building-component", "issue-type", "project-type", "project-phase", "business-unit"] as const) {
  entries.push(definition(`concentration.${dimension}`, `${dimension} concentration`, "§12"));
}

for (const dimension of ["root-cause", "iq-root-cause", "location", "company", "building-component"] as const) {
  entries.push(definition(`recurrence.${dimension}`, `${dimension} recurrence`, "§14"));
}

export const METRIC_DEFINITION_REGISTRY: Readonly<Record<string, MetricDefinitionMetadata>> = Object.freeze(
  Object.fromEntries(entries.map((entry) => [entry.id, entry])),
);

export function metricDefinitionFor(id: string): MetricDefinitionMetadata | null {
  return METRIC_DEFINITION_REGISTRY[id] ?? null;
}
