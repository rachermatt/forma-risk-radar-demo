export interface RiskDisclosure {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly source: string;
}

/** Product-wide disclosures required by the published risk-definition catalog. */
export const RISK_DISCLOSURES: readonly RiskDisclosure[] = [
  {
    id: "ciq-not-exhaustive",
    title: "Construction IQ is not exhaustive",
    detail: "A missing Construction IQ detection is not evidence that no risk exists. Unclassified and inapplicable records are never treated as Low.",
    source: "Risk definition catalog §21.1",
  },
  {
    id: "ciq-model-separation",
    title: "Quality, RFI, cost, and safety fields remain separate",
    detail: "Construction IQ quality risk, RFI risk, categorical cost impact, and safety sidecars are different source families. The dashboard does not merge them into one Autodesk score.",
    source: "Risk definition catalog §§2, 21",
  },
  {
    id: "eligibility",
    title: "Not applicable differs from unavailable",
    detail: "N/A means a source or metric does not apply. Unavailable means it applies but required evidence is absent or below the published coverage floor.",
    source: "Risk definition catalog §§2.2, 7",
  },
  {
    id: "daily-history",
    title: "Daily snapshots are not real time",
    detail: "Construction IQ change logs are daily snapshots. Carried values are labelled forward-filled, stale values remain explicit, and missing history is never replaced with zero.",
    source: "Risk definition catalog §§8, 21.1",
  },
  {
    id: "safety-scope",
    title: "Safety sources have different scopes",
    detail: "Issue safety categories and observation labels are record-level sidecars. Company safety is a separate company-day source with an undocumented numeric scale and is shown only as raw context.",
    source: "Risk definition catalog §§5.5, 21.1",
  },
  {
    id: "no-money",
    title: "Issue and RFI impact is not money",
    detail: "Issue and RFI cost-impact fields are categorical. Counts do not imply an issue-level monetary amount or attribute a linked cost value to a risk record.",
    source: "Risk definition catalog §§5.4, 21.1",
  },
  {
    id: "relationships",
    title: "Relationships are undirected and non-causal",
    detail: "Edges show explicit or disclosed inferred associations. Endpoint order does not imply sequence, ownership, conversion, or causality; edge creator attribution describes the edge, not the underlying records.",
    source: "Risk definition catalog §§10, 21.1",
  },
  {
    id: "schedule",
    title: "Schedule evidence comes from imported schedule files",
    detail: "Activity dates and critical-path flags come from the project schedule-file extract. A relationship to an activity is supporting evidence, not proof that a risk caused delay.",
    source: "Risk definition catalog §§5.7, 21.1",
  },
  {
    id: "clash-history",
    title: "Clash history can freeze",
    detail: "Clash-derived metrics become unavailable or frozen when the Model Coordination snapshot source is disabled; the dashboard does not invent intervening history.",
    source: "Risk definition catalog §21.1",
  },
  {
    id: "permissions",
    title: "Permissions bound every population",
    detail: "Counts cover only hubs, projects, records, and source families available to the signed-in account. Permission or source gaps are disclosed rather than extrapolated.",
    source: "Risk definition catalog §§2.2, 21.1",
  },
  {
    id: "project-population",
    title: "Portfolio scope excludes non-production projects",
    detail: "Template, training, test, and demonstration projects are excluded from portfolio comparisons. The synthetic demo itself contains no Autodesk customer records.",
    source: "Risk definition catalog §§2.3, 21.1",
  },
  {
    id: "submittal-due",
    title: "Submittal overdue is approximate",
    detail: "Until the state-aware due-date mapping is validated during onboarding, submittal overdue labels and related recommendations remain explicitly approximate.",
    source: "Risk definition catalog §2.4 and open issue OI-6",
  },
] as const;
