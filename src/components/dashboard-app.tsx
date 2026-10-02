"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { recordIdentityKey, sameRecordIdentity, severityFromConstructionIq } from "@/lib/canonical/types";
import type { AttentionItem, MetricProvenance, MomentumDirection, RecordIdentity, RiskDomain, RiskRecord, RiskRelationship, Severity } from "@/lib/canonical/types";
import { formRecordMatchesSignal, formSignalIdentityKey, type DemoDataset, type ProjectRiskSummary } from "@/lib/demo/types";
import { UNATTRIBUTED_TRADE_FILTER, dashboardScopeFiltersFromQuery, effectiveRecordSeverity, hasRecordLevelFilters, resolveScopedProject, scopeDashboardData, selectSignedMomentumMovers, type DashboardScopeFilters } from "@/lib/demo/scope";
import { buildScopedLineage, resolveVisibleLineageSelection } from "@/lib/demo/scoped-lineage";
import { buildPortfolioIndicators } from "@/lib/demo/portfolio-indicators";
import {
  actionabilityIndex,
  attentionExposureSummary,
  burnEligibleRecords,
  burnGrowthRecommendation,
  burnHistoryFromRecords,
  burnRateFromRecords,
  concentration,
  concentrationEligibleRecords,
  disciplineIdentityKey,
  disciplineIdentityLabel,
  hotspots as deriveHotspots,
  isConstructionIqRiskApplicable,
  RECURRENCE_DIMENSIONS,
  RECORDED_ROOT_CAUSE_NORMALIZATION_VERSION,
  recurrenceGroups,
  recurrenceGroupsAcrossDimensions,
  recurrencePopulationStats,
  scheduleExposureFromRecords,
} from "@/lib/risk/analytics";
import { aggregateFilledSeriesByDate, rollingAverageSeries, type FilledSeriesPoint } from "@/lib/risk/metrics";
import { triStateLabel } from "@/lib/risk/normalization";
import { buildCostImpactRiskView } from "@/lib/risk/cost-impact-view";
import { buildRfiCauseIntelligence, rfiCauseSourceAvailabilityForProjects } from "@/lib/risk/rfi-cause-intelligence";
import { buildRiskVelocityEvidence } from "@/lib/risk/risk-velocity";
import { previousHistoryRange, resolveHistoryRange, seriesWithinHistoryRange, type HistoryRange } from "@/lib/risk/history-range";
import { RISK_DISCLOSURES } from "@/lib/risk/disclosures";
import { metricDefinitionFor } from "@/lib/risk/definition-registry";
import { normalizeAutodeskDeepLink } from "@/lib/http/autodesk-link";
import {
  EmptyState,
  formatCompact,
  formatDate,
  MetricHeader,
  MomentumBadge,
  Panel,
  PriorityBadge,
  ProgressBar,
  SeverityBadge,
  SourceChip,
  TrendChart,
} from "./risk-ui";
import { SafetyLeadingIndicators } from "./safety-leading-indicators";
import { CostImpactRiskView } from "./cost-impact-risk-view";
import { RelationshipConversionFunnel } from "./relationship-conversion-funnel";
import { selectCanonicalRelationships } from "@/lib/risk/relationship-conversion-evidence";
import { RfiCauseIntelligencePanel } from "./rfi-cause-intelligence-panel";
import { RiskVelocityEvidencePanel } from "./risk-velocity-evidence-panel";

type ViewId = "portfolio" | "attention" | "trends" | "rfi-causes" | "hotspots" | "concentration" | "patterns" | "burn" | "cost-impact" | "companies" | "relationships" | "safety-observations" | "provenance" | "project";

const views: readonly { id: ViewId; label: string; icon: string }[] = [
  { id: "portfolio", label: "Command center", icon: "⌂" },
  { id: "attention", label: "Attention queue", icon: "!" },
  { id: "trends", label: "Trends & velocity", icon: "↗" },
  { id: "rfi-causes", label: "RFI causes", icon: "R" },
  { id: "hotspots", label: "Hotspots", icon: "⌖" },
  { id: "safety-observations", label: "Safety & checklists", icon: "+" },
  { id: "concentration", label: "Concentration", icon: "◫" },
  { id: "patterns", label: "Recurring & persistent", icon: "∞" },
  { id: "burn", label: "Burn-down", icon: "⇄" },
  { id: "cost-impact", label: "Cost impact", icon: "$" },
  { id: "companies", label: "Companies", icon: "◇" },
  { id: "relationships", label: "Relationships", icon: "⌘" },
];

const validViews = new Set<ViewId>([...views.map((view) => view.id), "provenance", "project"]);

type QueryUpdate = Record<string, string | null | undefined>;
function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function recordCiqConditionLabel(record: RiskRecord | undefined): string {
  if (!record) return "Unavailable";
  if (!isConstructionIqRiskApplicable(record)) return "Construction IQ risk · Not applicable";
  if (record.constructionIqRisk === "none") return "Unclassified / no CIQ classification";
  if (record.constructionIqRisk === "unmapped") return "Unmapped source value";
  return cap(record.constructionIqRisk);
}

function unavailableProjectRiskRow(project: ProjectRiskSummary, columns: number, onProject: (id: string) => void): ReactNode {
  return <tr onClick={() => onProject(project.project.id)} className="clickable-row"><td><span className="project-code">{project.code}</span><span className="project-name"><strong>{project.project.name}</strong><small>{project.descriptor}</small></span></td><td><span className="risk-rank-cell"><b className="score">—</b><small>Not calculated · {Math.round(project.calculation.risk.coverage * 100)}% input coverage</small></span></td><td colSpan={columns - 3}><span className="matrix-na">Risk composite unavailable below the 60% evidence floor</span></td><td><button className="row-arrow" onClick={(event) => { event.stopPropagation(); onProject(project.project.id); }} aria-label={`Open ${project.project.name}`}>→</button></td></tr>;
}

function average(values: readonly (number | null)[]): number | null {
  const available = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
}

function coverageRange(values: readonly number[]): string {
  if (!values.length) return "input coverage unavailable";
  const rounded = values.map((value) => Math.round(value * 100));
  const low = Math.min(...rounded);
  const high = Math.max(...rounded);
  return low === high ? `${low}% input coverage` : `${low}–${high}% project input coverage`;
}

function uniqueOptions(values: readonly (string | null | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));
}

function scopedProvenance(base: MetricProvenance, definitionId: string): MetricProvenance {
  const { projectId: _projectId, sourceRecordId: _sourceRecordId, autodeskTerm: _autodeskTerm, ...shared } = base;
  return {
    ...shared,
    sourceDataset: "filtered-project-risk-summaries",
    definitionId,
    valueKind: "application-derived",
  };
}

function rangeSeries(points: readonly FilledSeriesPoint[], range: HistoryRange): readonly FilledSeriesPoint[] {
  return seriesWithinHistoryRange(points, range);
}

function aggregateSeries(points: readonly FilledSeriesPoint[], period: "daily" | "weekly" | "monthly"): readonly FilledSeriesPoint[] {
  if (period === "daily") return points;
  if (period === "weekly") {
    const output: FilledSeriesPoint[] = [];
    for (let index = 0; index < points.length; index += 7) output.push(points.slice(index, index + 7).at(-1)!);
    return output;
  }
  const byMonth = new Map<string, FilledSeriesPoint>();
  for (const point of points) byMonth.set(point.date.slice(0, 7), point);
  return [...byMonth.values()];
}

function portfolioSeries(projects: readonly ProjectRiskSummary[]): readonly FilledSeriesPoint[] {
  return aggregateFilledSeriesByDate(projects.map((project) => project.trend));
}

function weeklyBurnHistory(records: readonly RiskRecord[], asOf: string, rangeDays: number): readonly { week: string; created: number; resolved: number }[] {
  return burnHistoryFromRecords(records, asOf, rangeDays, "all", "demo-generator").map((bucket) => ({
    week: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(bucket.startAt)),
    created: bucket.created,
    resolved: bucket.resolved,
  }));
}

function DashboardHeader({ eyebrow, title, detail, actions }: { eyebrow: string; title: string; detail: string; actions?: ReactNode }) {
  return (
    <section className="page-head page-head--view">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{detail}</p>
      </div>
      {actions ? <div className="page-head__actions">{actions}</div> : null}
    </section>
  );
}

function PanelHead({ eyebrow, title, action, chip }: { eyebrow: string; title: string; action?: ReactNode; chip?: ReactNode }) {
  return (
    <div className="panel__head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <div className="panel-title-row"><h2>{title}</h2>{chip}</div>
      </div>
      {action}
    </div>
  );
}

export function DashboardApp({ data }: { data: DemoDataset }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const requestedView = params.get("view") as ViewId | null;
  const view: ViewId = requestedView && validViews.has(requestedView) ? requestedView : "portfolio";
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const recordReturnFocus = useRef<HTMLElement | null>(null);

  const closeSearch = useCallback(() => {
    setSearch("");
    setSearchOpen(false);
    window.setTimeout(() => searchTriggerRef.current?.focus(), 0);
  }, []);

  const updateQuery = useCallback((updates: QueryUpdate, mode: "push" | "replace" = "push") => {
    const next = new URLSearchParams(params.toString());
    Object.entries(updates).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "" || value === "all") next.delete(key);
      else next.set(key, value);
    });
    const href = next.size ? `${pathname}?${next.toString()}` : pathname;
    if (mode === "replace") router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }, [params, pathname, router]);

  const scopeFilters = useMemo<DashboardScopeFilters>(
    () => dashboardScopeFiltersFromQuery(data, params),
    [data, params],
  );
  const selectedProject = scopeFilters.projectId ?? null;
  const selectedHub = scopeFilters.hubId ?? null;
  const selectedBusinessUnit = scopeFilters.businessUnitId ?? null;
  const selectedProjectType = scopeFilters.projectType ?? null;
  const selectedProjectPhase = scopeFilters.projectPhase ?? null;
  const selectedDomain = scopeFilters.domain ?? null;
  const selectedSeverity = scopeFilters.severity ?? null;
  const selectedMomentum = scopeFilters.momentum ?? null;
  const selectedCompany = scopeFilters.companyId ?? null;
  const selectedTrade = scopeFilters.trade ?? null;
  const selectedDiscipline = scopeFilters.discipline ?? null;
  const selectedLocation = scopeFilters.location ?? null;
  const selectedRootCause = scopeFilters.rootCause ?? null;
  const selectedIqRootCause = scopeFilters.iqRootCause ?? null;
  const selectedStatus = scopeFilters.status ?? null;
  const selectedPersistence = scopeFilters.persistence ?? null;
  const selectedRecurrence = scopeFilters.recurrence ?? null;
  const selectedCostExposure = scopeFilters.costExposure ?? null;
  const selectedScheduleExposure = scopeFilters.scheduleExposure ?? null;
  const historyRange = useMemo(() => resolveHistoryRange({
    range: params.get("range"),
    from: params.get("rangeFrom"),
    to: params.get("rangeTo"),
    asOf: data.asOf,
    coverageStart: data.coverageStart,
  }), [data.asOf, data.coverageStart, params]);
  const rangeDays = historyRange.periodDays;

  const scoped = useMemo(() => scopeDashboardData(data, scopeFilters), [data, scopeFilters]);
  const recordScopeActive = hasRecordLevelFilters(scopeFilters);
  const companySignalsSuppressed = Boolean(selectedSeverity || selectedDiscipline || selectedLocation || selectedRootCause || selectedIqRootCause || selectedStatus || selectedPersistence || selectedRecurrence || selectedCostExposure || selectedScheduleExposure);
  const filteredProjects = scoped.projects;
  const filteredRecords = scoped.records;
  const requestedConcentrationDimension = params.get("dimension");
  const concentrationDimension = requestedConcentrationDimension === "company" || requestedConcentrationDimension === "root-cause" || requestedConcentrationDimension === "iq-root-cause" || requestedConcentrationDimension === "discipline" || requestedConcentrationDimension === "location" || requestedConcentrationDimension === "building-component" || requestedConcentrationDimension === "issue-type" || requestedConcentrationDimension === "project-type" || requestedConcentrationDimension === "project-phase" || requestedConcentrationDimension === "business-unit" ? requestedConcentrationDimension : "trade";
  const scopedLineage = useMemo(() => buildScopedLineage(data, scoped, {
    filters: scopeFilters,
    rangeDays,
    rangeAsOf: historyRange.asOf,
    rangeCoverageComplete: !historyRange.coveragePartial,
    concentrationDimension,
  }), [concentrationDimension, data, historyRange.asOf, rangeDays, scopeFilters, scoped]);
  const projectLabels = useMemo(
    () => Object.fromEntries(filteredProjects.map((summary) => [summary.project.id, summary.project.name])),
    [filteredProjects],
  );
  const costImpact = useMemo(
    () => buildCostImpactRiskView(filteredRecords, { asOf: data.asOf, sourceSystem: "demo-generator", projectLabels }),
    [data.asOf, filteredRecords, projectLabels],
  );
  const rfiCauses = useMemo(
    () => buildRfiCauseIntelligence({
      records: filteredRecords,
      asOf: data.asOf,
      sourceSystem: "demo-generator",
      projectLabels,
      sourceAvailability: rfiCauseSourceAvailabilityForProjects(
        filteredProjects.map((summary) => summary.project.id),
        data.ciqSourceCoverage.rfiCauseProjectIds,
      ),
    }),
    [data.asOf, data.ciqSourceCoverage.rfiCauseProjectIds, filteredProjects, filteredRecords, projectLabels],
  );

  const activeFilterCount = [selectedHub, selectedProject, selectedBusinessUnit, selectedProjectType, selectedProjectPhase, selectedDomain, selectedSeverity, selectedMomentum, selectedCompany, selectedTrade, selectedDiscipline, selectedLocation, selectedRootCause, selectedIqRootCause, selectedStatus, selectedPersistence, selectedRecurrence, selectedCostExposure, selectedScheduleExposure].filter(Boolean).length + 2;
  const navigate = (target: ViewId, extra: QueryUpdate = {}) => updateQuery({ view: target === "portfolio" ? null : target, project: target === "project" ? extra.project : null, record: null, recordKind: null, recordProject: null, ...extra });
  const openRecord = (identity: RecordIdentity) => {
    recordReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    updateQuery({ record: identity.id, recordKind: identity.kind, recordProject: identity.projectId });
  };

  const currentLabel = view === "project" ? "Project detail" : views.find((item) => item.id === view)?.label ?? "Data provenance";
  const requestedRecord = params.get("record");
  const requestedRecordKind = params.get("recordKind");
  const requestedRecordProject = params.get("recordProject");
  const requestedIdentityKey = requestedRecord && requestedRecordKind && requestedRecordProject
    ? recordIdentityKey({ id: requestedRecord, kind: requestedRecordKind as RiskRecord["kind"], projectId: requestedRecordProject })
    : null;
  const relationshipEndpointKeys = new Set(scoped.relationships.flatMap((edge) => [recordIdentityKey(edge.from), recordIdentityKey(edge.to)]));
  const record = filteredRecords.find((item) => item.id === requestedRecord && item.kind === requestedRecordKind && item.projectId === requestedRecordProject)
    ?? (requestedIdentityKey && relationshipEndpointKeys.has(requestedIdentityKey)
      ? data.records.find((item) => recordIdentityKey(item) === requestedIdentityKey) ?? null
      : null);
  const attentionForRecord = record ? scoped.attention.find((item) => item.evidence.some((evidence) => sameRecordIdentity(evidence, record))) : undefined;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand brand--button" onClick={() => navigate("portfolio")} aria-label="Go to portfolio command center">
          <span className="brand__mark" aria-hidden="true" />
          <span><strong>FORMA</strong><small>RISK RADAR</small></span>
        </button>
        <nav aria-label="Primary navigation" className="primary-nav">
          <p className="nav-label">PORTFOLIO</p>
          {views.map((item) => (
            <button className={view === item.id || (view === "project" && item.id === "portfolio") ? "nav-item nav-item--active" : "nav-item"} onClick={() => navigate(item.id)} key={item.id}>
              <span aria-hidden="true">{item.icon}</span>{item.label}
              {item.id === "attention" ? <b className="nav-count">{scoped.attention.filter((item) => item.score >= 55).length}</b> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar__foot">
          <button className={view === "provenance" ? "nav-item nav-item--active" : "nav-item"} onClick={() => navigate("provenance")}>
            <span aria-hidden="true">◎</span>Data provenance
          </button>
          <button className="nav-item" onClick={() => setFiltersOpen(true)}><span aria-hidden="true">⚙</span>Portfolio settings</button>
          <div className="profile">
            <span className="avatar">RM</span>
            <span><strong>Portfolio Executive</strong><small>Synthetic demo workspace</small></span>
            <span aria-hidden="true">⌄</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <section className="print-context" aria-hidden="true"><strong>Forma Risk Radar · {currentLabel}</strong><span>Snapshot as of {formatDate(data.asOf)} · {filteredProjects.length} projects · {filteredRecords.length} records in active scope</span><small>Synthetic demo · generated {new Date(data.asOf).toISOString()}</small></section>
        <header className="topbar">
          <div className="breadcrumb"><span>{data.hub.name}</span><span aria-hidden="true">/</span><strong>{currentLabel}</strong></div>
          <div className="topbar__actions">
            {searchOpen ? (
              <label className="search-field"><span className="sr-only">Search projects and records</span><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }} placeholder="Search projects or records" /><button onClick={closeSearch} aria-label="Close search">×</button></label>
            ) : <button ref={searchTriggerRef} className="icon-button" aria-label="Search" onClick={() => setSearchOpen(true)}>⌕</button>}
            <span className="icon-button notification notification--status" role="img" aria-label="Notifications are unavailable in the synthetic demo">♢<span className="notification__dot" /></span>
            <button className="date-control" onClick={() => setFiltersOpen(true)}><span aria-hidden="true">□</span>As of {formatDate(data.asOf)}<span aria-hidden="true">⌄</span></button>
          </div>
        </header>

        <div className="demo-banner" role="status">
          <span className="demo-banner__badge">SYNTHETIC DEMO</span>
          <span>Representative project data for product evaluation — no Autodesk customer records.</span>
          <button onClick={() => navigate("provenance")}>How it works</button>
        </div>

        {searchOpen && search.trim() ? <SearchResults projects={filteredProjects} records={filteredRecords} query={search} onProject={(id) => { setSearchOpen(false); navigate("project", { project: id }); }} onRecord={(identity) => { setSearchOpen(false); openRecord(identity); }} /> : null}

        <ActiveFilters data={data} filters={scopeFilters} historyRange={historyRange} count={activeFilterCount} onClear={(key) => updateQuery(key === "range" ? { range: null, rangeFrom: null, rangeTo: null } : { [key]: null }, "replace")} onClearAll={() => updateQuery({ hub: null, filterProject: null, businessUnit: null, projectType: null, projectPhase: null, domain: null, severity: null, momentum: null, company: null, trade: null, discipline: null, location: null, rootCause: null, iqRootCause: null, status: null, persistence: null, recurrence: null, costExposure: null, scheduleExposure: null, range: null, rangeFrom: null, rangeTo: null }, "replace")} />

        {view === "portfolio" ? <PortfolioView data={data} projects={filteredProjects} records={filteredRecords} relationships={scoped.relationships} companySignals={scoped.companyCiqSignals} selectedDomain={selectedDomain} recordScopeActive={recordScopeActive} filterCount={activeFilterCount} onFilters={() => setFiltersOpen(true)} onNavigate={navigate} onProject={(id) => navigate("project", { project: id })} /> : null}
        {view === "attention" ? <AttentionView attention={scoped.attention} records={filteredRecords} projects={filteredProjects} onFilters={() => setFiltersOpen(true)} onRecord={openRecord} /> : null}
        {view === "project" ? <ProjectView data={data} projects={filteredProjects} records={filteredRecords} relationships={scoped.relationships} attention={scoped.attention} projectId={params.get("project")} selectedDomain={selectedDomain} recordScopeActive={recordScopeActive} historyRange={historyRange} onBack={() => navigate("portfolio")} onRecord={openRecord} onNavigate={navigate} /> : null}
        {view === "project" ? <FormSignalPanel data={data} records={filteredRecords} projectId={params.get("project")} /> : null}
        {view === "trends" ? <TrendsView data={data} projects={filteredProjects} records={filteredRecords} selectedDomain={selectedDomain} recordScopeActive={recordScopeActive} historyRange={historyRange} /> : null}
        {view === "rfi-causes" ? <RfiCauseIntelligencePanel intelligence={rfiCauses} onRecord={openRecord} /> : null}
        {view === "hotspots" ? <HotspotsView data={data} projects={filteredProjects} records={filteredRecords} onRecord={openRecord} /> : null}
        {view === "concentration" ? <ConcentrationView data={data} records={filteredRecords} params={params} selectedSeverity={selectedSeverity} updateQuery={updateQuery} onRecord={openRecord} /> : null}
        {view === "patterns" ? <PatternsView data={data} projects={filteredProjects} records={filteredRecords} attention={scoped.attention} onRecord={openRecord} /> : null}
        {view === "burn" ? <BurnView data={data} projects={filteredProjects} records={filteredRecords} historyRange={historyRange} onRecord={openRecord} /> : null}
        {view === "cost-impact" ? <CostImpactRiskView model={costImpact} onRecord={openRecord} /> : null}
        {view === "companies" ? <CompaniesView data={data} projects={filteredProjects} records={filteredRecords} companyCiqSignals={scoped.companyCiqSignals} companySignalsSuppressed={companySignalsSuppressed} selectedDomain={selectedDomain} onRecord={openRecord} /> : null}
        {view === "relationships" ? <RelationshipsView relationships={scoped.relationships} records={scoped.records} coverage={scoped.relationshipCoverage} onRecord={openRecord} /> : null}
        {view === "safety-observations" ? <SafetyLeadingIndicators data={data} projects={filteredProjects} records={filteredRecords} onRecord={openRecord} /> : null}
        {view === "provenance" ? <ProvenanceView data={data} scopedLineage={scopedLineage} requestedMetricId={params.get("metric")} scopeBounded={activeFilterCount > 2} /> : null}
      </main>

      {filtersOpen ? <FilterPanel data={data} filters={scopeFilters} historyRange={historyRange} updateQuery={updateQuery} onClose={() => setFiltersOpen(false)} /> : null}
      {record ? <RecordDrawer data={data} projects={filteredProjects} records={filteredRecords} relationships={scoped.relationships} record={record} attention={attentionForRecord} returnFocus={recordReturnFocus.current} onClose={() => updateQuery({ record: null, recordKind: null, recordProject: null }, "replace")} /> : null}
    </div>
  );
}

function ActiveFilters({ data, filters, historyRange, count, onClear, onClearAll }: { data: DemoDataset; filters: DashboardScopeFilters; historyRange: HistoryRange; count: number; onClear: (key: string) => void; onClearAll: () => void }) {
  const chips: { key: string; label: string }[] = [{ key: "range", label: historyRange.invalidCustom ? "Invalid custom range · Last 30 days" : historyRange.label }];
  const project = data.projects.find((item) => item.project.id === filters.projectId);
  const company = data.companies.find((item) => item.id === filters.companyId);
  const disciplineRecord = data.records.find((record) => disciplineIdentityKey(record) === filters.discipline);
  if (filters.hubId) chips.push({ key: "hub", label: data.hub.name });
  if (project) chips.push({ key: "filterProject", label: project.project.name });
  if (filters.businessUnitId) chips.push({ key: "businessUnit", label: `Business unit: ${data.businessUnits.find((unit) => unit.id === filters.businessUnitId)?.path ?? "Unresolved"}` });
  if (filters.projectType) chips.push({ key: "projectType", label: filters.projectType });
  if (filters.projectPhase) chips.push({ key: "projectPhase", label: `Phase: ${filters.projectPhase}` });
  if (filters.domain) chips.push({ key: "domain", label: `${cap(filters.domain)} risk` });
  if (filters.severity) chips.push({ key: "severity", label: filters.severity === "none" ? "CIQ risk: Unclassified / no classification" : filters.severity === "unmapped" ? "CIQ risk: Unmapped source value" : `CIQ risk: ${cap(filters.severity)}` });
  if (filters.momentum) chips.push({ key: "momentum", label: cap(filters.momentum) });
  if (company) chips.push({ key: "company", label: company.name });
  if (filters.trade) chips.push({ key: "trade", label: filters.trade === UNATTRIBUTED_TRADE_FILTER ? "Trade: No trade recorded" : filters.trade });
  if (filters.discipline) chips.push({ key: "discipline", label: disciplineIdentityLabel(disciplineRecord ?? { discipline: null, disciplineOrigin: null }) ?? "Discipline: unavailable selection" });
  if (filters.location) chips.push({ key: "location", label: filters.location });
  if (filters.rootCause) chips.push({ key: "rootCause", label: `Recorded cause: ${filters.rootCause}` });
  if (filters.iqRootCause) chips.push({ key: "iqRootCause", label: `CIQ predicted: ${filters.iqRootCause}` });
  if (filters.status) chips.push({ key: "status", label: `Status: ${filters.status.replaceAll("_", " ")}` });
  if (filters.persistence) chips.push({ key: "persistence", label: cap(filters.persistence) });
  if (filters.recurrence) chips.push({ key: "recurrence", label: cap(filters.recurrence) });
  if (filters.costExposure) chips.push({ key: "costExposure", label: filters.costExposure === "confirmed" ? "Cost: Yes RFI / High CIQ" : filters.costExposure === "potential" ? "Cost: Unknown RFI / Medium CIQ" : filters.costExposure === "explicit-negative" ? "Cost: No RFI / Low CIQ" : filters.costExposure === "unclassified" ? "Cost: field unavailable / not classified" : "Cost: unmapped source value" });
  if (filters.scheduleExposure) chips.push({ key: "scheduleExposure", label: filters.scheduleExposure === "flagged" ? "Schedule: RFI Yes" : filters.scheduleExposure === "potential" ? "Schedule: RFI Unknown" : filters.scheduleExposure === "linked" ? "Schedule: linked evidence" : filters.scheduleExposure === "explicit-negative" ? "Schedule: RFI No" : filters.scheduleExposure === "unavailable" ? "Schedule: field unavailable" : "Schedule: unmapped source value" });
  chips.push({ key: "production", label: "Production only" });
  return (
    <section className="filter-row filter-row--global" aria-label={`${count} active filters`}>
      {chips.map((chip) => chip.key === "production"
        ? <span className="filter-chip" key={chip.key} aria-label="Fixed scope: Production only">{chip.label}</span>
        : <button className="filter-chip" key={chip.key} onClick={() => onClear(chip.key)}>{chip.label}<span aria-hidden="true">×</span></button>)}
      <button className="clear-button" onClick={onClearAll}>Clear all</button>
      <span className="coverage-date">Coverage begins {formatDate(data.coverageStart)}</span>
    </section>
  );
}

function PortfolioView({ data, projects, records, relationships, companySignals, selectedDomain, recordScopeActive, filterCount, onFilters, onNavigate, onProject }: { data: DemoDataset; projects: readonly ProjectRiskSummary[]; records: readonly RiskRecord[]; relationships: readonly RiskRelationship[]; companySignals: DemoDataset["companyCiqSignals"]; selectedDomain: RiskDomain | null; recordScopeActive: boolean; filterCount: number; onFilters: () => void; onNavigate: (view: ViewId, extra?: QueryUpdate) => void; onProject: (id: string) => void }) {
  const indicators = buildPortfolioIndicators({
    data,
    projects,
    records,
    companySignals,
    recordScopeActive,
  });
  const indicator = (id: string) => indicators.find((entry) => entry.id === id)!;
  const needAttention = indicator("scoped:indicator:projects-attention").value ?? 0;
  const overdueIndicator = indicator("scoped:indicator:overdue");
  const criticalOverdue = overdueIndicator.value ?? 0;
  const unassigned = records.filter((record) => record.open && (record.kind === "issue" || record.kind === "rfi" || record.kind === "submittal") && !record.assigneeId).length;
  const matchingHighRisk = records.filter((record) => record.open && isConstructionIqRiskApplicable(record) && (record.constructionIqRisk === "critical" || record.constructionIqRisk === "high")).length;
  const visibleProjectIds = new Set(projects.map((project) => project.project.id));
  const scopedRiskIndex = recordScopeActive ? null : average(projects.map((project) => project.risk.value.index));
  const scopedRiskSeverity: Severity = scopedRiskIndex === null ? "none" : criticalOverdue > 0 || scopedRiskIndex >= 75 ? "critical" : scopedRiskIndex >= 55 ? "high" : scopedRiskIndex >= 30 ? "medium" : "low";
  const scopedExposureIndex = selectedDomain || recordScopeActive ? null : average(projects.map((project) => project.exposure.value.index));
  const riskCoverageLabel = coverageRange(projects.map((project) => project.calculation.risk.coverage));
  const exposureCoverageLabel = coverageRange(projects.map((project) => project.calculation.exposure.coverage));
  const scopedMomentumChange = recordScopeActive ? null : average(projects.map((project) => project.momentum.value.change7d).filter((value): value is number => value !== null));
  const scopedMomentum: MomentumDirection | null = scopedMomentumChange === null ? null : scopedMomentumChange >= 6 ? "accelerating" : scopedMomentumChange > 3 ? "increasing" : scopedMomentumChange < -3 ? "improving" : "stable";
  const scopedTrend = selectedDomain || recordScopeActive ? [] : portfolioSeries(projects);
  const scheduleMetadata = data.records.filter((record) => record.kind === "schedule-activity" && visibleProjectIds.has(record.projectId));
  const scheduleExposure = scheduleExposureFromRecords([...records, ...scheduleMetadata], relationships);
  const exposureContextRecords = recordScopeActive || selectedDomain
    ? records.filter((record) => record.open)
    : scheduleExposure.eligibleRiskRecords;
  const exposureLocationCount = new Set(exposureContextRecords.map((record) => record.locationId).filter(Boolean)).size;
  const exposureCompanyCount = new Set(exposureContextRecords.map((record) => record.companyId).filter(Boolean)).size;
  const recurringGroups = recurrenceGroupsAcrossDimensions(
    records,
    data.asOf,
    180,
    "demo-generator",
  ).length;
  const newHighRiskRate = projects.reduce((sum, project) => sum + project.momentum.value.newHighRiskRate, 0);
  const resolvedHighRiskRate = projects.reduce((sum, project) => sum + project.momentum.value.resolvedHighRiskRate, 0);
  const rankingEligible = recordScopeActive ? [] : selectedDomain ? projects : projects.filter((project) => project.calculation.risk.ranking.eligible);
  const moverCohort = rankingEligible.some((project) => project.calculation.risk.ranking.cohort === "ciq-covered")
    ? "ciq-covered"
    : "ciq-unavailable";
  const comparableRiskProjects = (selectedDomain ? rankingEligible : rankingEligible.filter((project) =>
    project.calculation.risk.ranking.cohort === moverCohort
  )).filter((project) => project.momentum.value.change7d !== null);
  const signedMovers = selectSignedMomentumMovers(comparableRiskProjects);
  const moverCohortLabel = selectedDomain ? `${cap(selectedDomain)} domain · unranked` : moverCohort === "ciq-covered" ? "Project daily CIQ quality covered" : "Project daily CIQ quality unavailable";
  const emerging = comparableRiskProjects.filter((project) => project.risk.value.severity === "medium" && project.momentum.value.change7d! > 3).sort((a, b) => b.momentum.value.change7d! - a.momentum.value.change7d!)[0];
  const burnProjects = projects.map((project) => ({
    ...project,
    burnRate: burnRateFromRecords(
      records.filter((record) => record.projectId === project.project.id),
      data.asOf,
      28,
      selectedDomain ?? "all",
      project.project.id,
      "demo-generator",
    ),
  }));
  const scopedRiskProvenance = scopedProvenance(data.portfolio.risk.provenance, "risk.portfolio.filtered-mean-project-index");
  const scopedExposureProvenance = scopedProvenance(data.portfolio.exposure.provenance, "exposure.portfolio.filtered-mean-project-index");
  const scopedMomentumProvenance = scopedProvenance(data.portfolio.momentum.provenance, "momentum.portfolio.filtered-mean-project-change");
  return (
    <>
      <DashboardHeader eyebrow="PORTFOLIO COMMAND CENTER" title={recordScopeActive ? `${records.length} records match the evidence filters.` : needAttention === 1 ? "1 project needs attention." : `${needAttention} projects need attention.`} detail={recordScopeActive ? "Project-level risk, exposure, momentum, and ranking are suppressed because record-level filters cannot be applied retrospectively to their stored project snapshots." : "Start with the conditions where severity, exposure, and momentum overlap—not simply the projects with the largest record counts."} actions={<><button className="secondary-button" onClick={() => window.print()}><span aria-hidden="true">⇩</span>Export brief</button><button className="filter-button" onClick={onFilters}><span aria-hidden="true">≡</span>Filters<span className="filter-count">{filterCount}</span></button></>} />

      <section className="portfolio-indicators" aria-label="Portfolio monitoring indicators">
        {indicators.map((entry) => <article key={entry.id}>
          <span>{entry.label}</span><b>{entry.value ?? "—"}</b>
          <small>{entry.detail}</small>
          <button className="indicator-inspect" onClick={() => onNavigate("provenance", { metric: entry.id })} aria-label={`Inspect source and evidence for ${entry.label}`}>Inspect source &amp; evidence <span aria-hidden="true">→</span></button>
        </article>)}
      </section>

      <section className="pulse-grid" aria-label="Portfolio risk summary">
        <article className="pulse-card pulse-card--risk">
          <div className="pulse-card__top"><MetricHeader label="RISK" provenance={scopedRiskProvenance} /><span className="pulse-card__spark" aria-hidden="true">{scopedMomentumChange === null ? "—" : scopedMomentumChange > 0 ? "↗" : scopedMomentumChange < 0 ? "↘" : "→"}</span></div>
          <div className="pulse-card__value">{scopedRiskIndex === null ? "—" : <>{Math.round(scopedRiskIndex)} <span>/ 100</span></>}</div>
          <div className="pulse-card__meta"><SeverityBadge severity={scopedRiskSeverity} />{scopedMomentumChange !== null ? <span className={scopedMomentumChange < 0 ? "change change--down" : scopedMomentumChange > 0 ? "change change--up" : "change metric-neutral"}>{scopedMomentumChange < 0 ? "↓" : scopedMomentumChange > 0 ? "↑" : "→"} {Math.abs(Math.round(scopedMomentumChange))} pts</span> : null}<span>{scopedMomentumChange === null ? "prior observation unavailable" : "mean project change · 7 days"}</span></div>
          <div className="coverage-bar"><span style={{ width: `${(projects.length / data.projects.length) * 100}%` }} /></div><p>{recordScopeActive ? "Not recalculated from record-filtered evidence" : `${projects.length} of ${data.projects.length} production ${projects.length === 1 ? "project" : "projects"} in view · ${selectedDomain ? "domain point estimates; weighted-input coverage not applicable" : riskCoverageLabel}`}</p>
        </article>
        <article className="pulse-card">
          <div className="pulse-card__top"><MetricHeader label="EXPOSURE" provenance={scopedExposureProvenance} /><span className="pulse-card__spark pulse-card__spark--orange" aria-hidden="true">◎</span></div>
          <div className="pulse-card__value">{scopedExposureIndex === null ? "—" : <>{Math.round(scopedExposureIndex)} <span>/ 100</span></>}</div>
          <div className="pulse-card__meta"><span className="plain-status"><b>{exposureLocationCount}</b> {recordScopeActive || selectedDomain ? "matching locations" : "eligible locations"}</span><span className="plain-status"><b>{exposureCompanyCount}</b> {recordScopeActive || selectedDomain ? "matching companies" : "eligible companies"}</span></div>
          <div className="micro-bars" aria-hidden="true"><span style={{ height: "55%" }} /><span style={{ height: "78%" }} /><span style={{ height: "42%" }} /><span style={{ height: "88%" }} /><span style={{ height: "67%" }} /><span style={{ height: "73%" }} /><span style={{ height: "91%" }} /></div>
          <p>{recordScopeActive ? "Project exposure snapshots suppressed; contextual counts remain filtered." : selectedDomain ? `A ${cap(selectedDomain)}-specific exposure index is not defined; contextual counts remain filtered.` : `${scheduleExposure.scheduleLinkedRiskRecords.length} schedule-linked ${scheduleExposure.scheduleLinkedRiskRecords.length === 1 ? "risk" : "risks"} · ${scheduleExposure.criticalPathLinkedRiskRecords.length} critical-path (project schedule file) · ${scheduleExposure.confirmedScheduleEdgeCount} supporting ${scheduleExposure.confirmedScheduleEdgeCount === 1 ? "edge" : "edges"} · ${exposureCoverageLabel}`}</p>
        </article>
        <article className="pulse-card">
          <div className="pulse-card__top"><MetricHeader label="MOMENTUM" provenance={scopedMomentumProvenance} /><span className="pulse-card__spark pulse-card__spark--red" aria-hidden="true">↗</span></div>
          <div className="pulse-card__value pulse-card__value--text">{scopedMomentum ? cap(scopedMomentum) : "Unavailable"}</div>
          <div className="pulse-card__meta">{scopedMomentumChange !== null ? <span className={scopedMomentumChange < 0 ? "change change--down" : scopedMomentumChange > 0 ? "change change--up" : "change metric-neutral"}>{scopedMomentumChange > 0 ? "+" : ""}{scopedMomentumChange.toFixed(1)} pts</span> : <span>— · prior observation unavailable</span>}{scopedMomentumChange !== null ? <span>mean project risk index · 7 days</span> : null}</div>
          {scopedTrend.length ? <TrendChart compact points={scopedTrend} label="Mean project risk index in the filtered portfolio" /> : <p>{recordScopeActive ? "Historical project snapshots are suppressed for record-level filters." : selectedDomain ? scopedMomentumChange === null ? "Domain history and a prior domain observation are unavailable; no direction is inferred." : "Domain history is unavailable; the displayed change compares current and prior domain conditions." : "No project trend is available for this filter."}</p>}
          <p>{recordScopeActive ? "Use burn-down and evidence views for this record-filtered population." : selectedDomain ? `${cap(selectedDomain)} domain momentum is calculated from domain evidence only.` : resolvedHighRiskRate > 0 ? `New high-risk rate is ${Math.round((newHighRiskRate / resolvedHighRiskRate) * 10) / 10}× the resolution rate` : "No resolved high-risk rate is available in this scope"}</p>
        </article>
        <article className="pulse-card pulse-card--attention">
          <div className="pulse-card__top"><div><span className="pulse-card__label">NEEDS ATTENTION</span><span className="data-chip data-chip--plain">TODAY</span></div><span className="pulse-card__spark pulse-card__spark--yellow" aria-hidden="true">!</span></div>
          <div className="pulse-card__value">{recordScopeActive ? records.length : needAttention} <span>{recordScopeActive ? (records.length === 1 ? "record" : "records") : (needAttention === 1 ? "project" : "projects")}</span></div>
          <div className="attention-summary"><span><b>{recordScopeActive ? matchingHighRisk : criticalOverdue}</b>{recordScopeActive ? "high-risk matches" : "critical overdue*"}</span><span><b>{unassigned}</b>unassigned</span><span><b>{recordScopeActive ? criticalOverdue : recurringGroups}</b>{recordScopeActive ? "overdue matches*" : "recurring groups"}</span></div>
          <button className="text-button" onClick={() => onNavigate("attention")}>Open attention queue<span aria-hidden="true">→</span></button>
        </article>
      </section>

      <p className="method-note"><b>* Due-date qualification:</b> any Submittal included in an overdue total uses an approximate mapped date pending validation of the state-aware source fields.</p>

      <section className="content-grid content-grid--portfolio">
        <Panel className="project-panel">
          <PanelHead eyebrow="WHERE TO LOOK FIRST" title="Project risk matrix" action={<div className="panel__actions"><span>{recordScopeActive ? "Evidence match" : selectedDomain ? "Comparison" : "Ordering"}</span><span>{recordScopeActive ? "Snapshot metrics suppressed" : selectedDomain ? `${cap(selectedDomain)} conditions · not ranked` : "8 transparent sort modes below"}</span></div>} />
          {projects.length ? <ProjectTable projects={projects} selectedDomain={selectedDomain} metricsSuppressed={recordScopeActive} onProject={onProject} /> : <EmptyState title="No projects match these filters" detail="Clear one or more filters to restore the portfolio population." />}
        </Panel>
        <Panel className="signal-panel">
          <PanelHead eyebrow="EMERGING SIGNAL" title="Risk before red" chip={<SourceChip label="Synthetic" />} />
          {recordScopeActive ? <EmptyState title="Emerging project signal suppressed" detail="Clear record-level filters to compare project snapshot momentum." /> : emerging ? <><div className="signal-project"><span className="project-code project-code--dark">{emerging.code}</span><span><strong>{emerging.project.name}</strong><small>{selectedDomain ? `${cap(selectedDomain)} domain` : `${emerging.domainSummaries.find((domain) => domain.domain === "quality")?.label} · Building envelope`}</small></span><span className="signal-delta">{(emerging.momentum.value.change7d ?? 0) > 0 ? "+" : ""}{emerging.momentum.value.change7d ?? "—"} pts</span></div>{selectedDomain ? <p className="signal-copy">Historical domain series are unavailable. This emerging condition uses the current-versus-prior domain calculation.</p> : <div className="signal-chart-wrap"><TrendChart points={emerging.trend} compact label={`${emerging.project.name} risk trend`} threshold={55} /></div>}<p className="signal-copy">{emerging.narrative}</p><button className="text-button signal-link" onClick={() => onProject(emerging.project.id)}>Why this is emerging<span aria-hidden="true">→</span></button></> : <EmptyState title="No emerging risk in view" detail="No medium-severity project is currently increasing above the configured threshold." />}
        </Panel>
      </section>

      <section className="movers-grid">
        {recordScopeActive ? null : <MoverCard label={`Largest increase · ${moverCohortLabel}`} project={signedMovers.increase ?? undefined} emptyTitle="No increasing project" emptyDetail="No comparable project has a positive 7-day change." onProject={onProject} />}
        {recordScopeActive ? null : <MoverCard label={`Largest improvement · ${moverCohortLabel}`} project={signedMovers.improvement ?? undefined} emptyTitle="No improving project" emptyDetail="No comparable project has a negative 7-day change." onProject={onProject} />}
        <MoverCard label={selectedDomain ? `Weakest ${selectedDomain} burn rate` : "Weakest burn rate"} project={burnProjects.filter((project) => project.burnRate.burnRatio !== null).sort((a, b) => a.burnRate.burnRatio! - b.burnRate.burnRatio!)[0]} emptyTitle="No comparable burn rate" emptyDetail="No project has both created and resolved-flow evidence in this scope." onProject={onProject} burn />
      </section>
      <p className="ciq-disclosure">{recordScopeActive ? "Record-level filters select evidence and the projects containing it. Stored project snapshot metrics are not retrospectively recalculated from that partial population, so risk, exposure, momentum, ranking, and movers are suppressed; record-level counts, patterns, hotspots, concentration, and burn-down remain scoped." : selectedDomain ? `${cap(selectedDomain)} condition scores and changes use only evidence in the selected domain. Domain rows are not ranked because a validated domain-level comparison denominator is unavailable. Whole-project exposure and historical series are suppressed.` : "Construction IQ risk indicates higher-than-normal risk for a reporting day; it is not a judgement of whether a project is well managed. Condition scores use point estimates. Ranking uses 95% Wilson lower bounds, excludes active denominators below 20, and never mixes project-daily CIQ quality coverage cohorts. Record-level CIQ datasets retain independent coverage."}</p>
    </>
  );
}

function ProjectTable({ projects, selectedDomain, metricsSuppressed, onProject }: { projects: readonly ProjectRiskSummary[]; selectedDomain: RiskDomain | null; metricsSuppressed: boolean; onProject: (id: string) => void }) {
  const [sortBy, setSortBy] = useState<"risk" | "increase" | "exposure" | "high-risk" | "overdue" | "normalized-exposure" | "persistence" | "burn">("risk");
  if (metricsSuppressed) {
    const matched = [...projects].sort((left, right) => left.project.name.localeCompare(right.project.name));
    return <div className="table-wrap"><table><thead><tr><th>Project</th><th>Condition</th><th>Exposure</th><th>Momentum</th><th>Coverage</th><th><span className="sr-only">Open project</span></th></tr></thead><tbody><tr className="ranking-group ranking-group--insufficient"><td colSpan={6}><strong>Projects containing matching evidence</strong><span>Stored project metrics are not recalculated from partial record populations.</span></td></tr>{matched.map((project) => <ProjectRiskRow key={project.project.id} project={project} metricsSuppressed onProject={onProject} />)}</tbody></table></div>;
  }
  if (selectedDomain) {
    const domainProjects = [...projects].sort((a, b) => (b.risk.value.index ?? Number.NEGATIVE_INFINITY) - (a.risk.value.index ?? Number.NEGATIVE_INFINITY) || a.project.name.localeCompare(b.project.name));
    return <div className="table-wrap"><table><thead><tr><th>Project</th><th>Domain condition</th><th>Exposure</th><th>Domain momentum</th><th>Coverage</th><th><span className="sr-only">Open project</span></th></tr></thead><tbody><tr className="ranking-group"><td colSpan={6}><strong>{cap(selectedDomain)} domain</strong><span>Ordered by current condition for review · no cross-project rank assigned</span></td></tr>{domainProjects.map((project) => <ProjectRiskRow key={project.project.id} project={project} domainMode onProject={onProject} />)}</tbody></table></div>;
  }
  const cohorts = [
    { id: "ciq-covered", label: "Project daily CIQ quality covered" },
    { id: "ciq-unavailable", label: "Project daily CIQ quality unavailable" },
  ] as const;
  const compare = (left: ProjectRiskSummary, right: ProjectRiskSummary): number => {
    if (sortBy === "increase") return (right.momentum.value.change7d ?? Number.NEGATIVE_INFINITY) - (left.momentum.value.change7d ?? Number.NEGATIVE_INFINITY);
    if (sortBy === "exposure") {
      const total = (project: ProjectRiskSummary) => project.exposure.value.confirmedCostImpact + project.exposure.value.potentialCostExposure + project.exposure.value.scheduleLinkedItems;
      return total(right) - total(left);
    }
    if (sortBy === "high-risk") return right.risk.value.highRiskOpen - left.risk.value.highRiskOpen;
    if (sortBy === "overdue") return right.risk.value.criticalOverdue - left.risk.value.criticalOverdue;
    if (sortBy === "normalized-exposure") return (right.exposure.value.index ?? Number.NEGATIVE_INFINITY) - (left.exposure.value.index ?? Number.NEGATIVE_INFINITY);
    if (sortBy === "persistence") return right.momentum.value.consecutiveElevatedPeriods - left.momentum.value.consecutiveElevatedPeriods;
    if (sortBy === "burn") return (left.burnRate.burnRatio ?? Number.POSITIVE_INFINITY) - (right.burnRate.burnRatio ?? Number.POSITIVE_INFINITY);
    return (right.calculation.risk.ranking.value ?? Number.NEGATIVE_INFINITY) - (left.calculation.risk.ranking.value ?? Number.NEGATIVE_INFINITY);
  };
  const sortLabels = {
    risk: "Highest current risk (Wilson key)",
    increase: "Fastest increasing",
    exposure: "Greatest exposure count",
    "high-risk": "Most high-risk items",
    overdue: "Most critical overdue",
    "normalized-exposure": "Highest normalized exposure",
    persistence: "Longest persistent elevation",
    burn: "Weakest risk burn rate",
  } as const;
  const columns = <tr><th>Project</th><th>Overall</th><th>Design</th><th>RFI</th><th>Quality</th><th>Safety</th><th>Subcontractor</th><th>Exposure</th><th>Momentum</th><th><span className="sr-only">Open project</span></th></tr>;
  if (sortBy !== "risk") {
    const sorted = [...projects].sort((left, right) => compare(left, right) || left.project.name.localeCompare(right.project.name));
    return <div className="matrix-wrap"><label className="matrix-sort"><span>Sort projects</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>{Object.entries(sortLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="table-wrap table-wrap--matrix"><table><thead>{columns}</thead><tbody><tr className="ranking-group"><td colSpan={10}><strong>{sortLabels[sortBy]}</strong><span>Condition cells remain point estimates; this ordering is not a risk rank.</span></td></tr>{sorted.map((project) => <ProjectMatrixRow key={project.project.id} project={project} showRank={false} onProject={onProject} />)}</tbody></table></div></div>;
  }
  return (
    <div className="matrix-wrap"><label className="matrix-sort"><span>Sort projects</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>{Object.entries(sortLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="table-wrap table-wrap--matrix"><table><thead>{columns}</thead>{cohorts.map((cohort) => {
      const cohortProjects = projects.filter((project) => project.calculation.risk.ranking.cohort === cohort.id);
      if (!cohortProjects.length) return null;
      const ranked = cohortProjects.filter((project) => project.calculation.risk.ranking.eligible).sort((a, b) =>
        compare(a, b) ||
        (b.exposure.value.index ?? Number.NEGATIVE_INFINITY) - (a.exposure.value.index ?? Number.NEGATIVE_INFINITY) ||
        a.project.name.localeCompare(b.project.name)
      );
      const insufficient = cohortProjects.filter((project) => !project.calculation.risk.ranking.eligible).sort((a, b) => a.project.name.localeCompare(b.project.name));
      return <tbody key={cohort.id}>
        <tr className="ranking-group"><td colSpan={10}><strong>{cohort.label}</strong><span>{ranked.length} comparable project{ranked.length === 1 ? "" : "s"} · ranked only inside this cohort</span></td></tr>
        {ranked.map((project) => <ProjectMatrixRow key={project.project.id} project={project} showRank onProject={onProject} />)}
        {insufficient.length ? <><tr className="ranking-group ranking-group--insufficient"><td colSpan={10}><strong>Insufficient ranking data</strong><span>Point-estimate condition scores remain visible; these rows are not ranked.</span></td></tr>{insufficient.map((project) => <ProjectMatrixRow key={project.project.id} project={project} showRank onProject={onProject} />)}</> : null}
      </tbody>;
    })}</table></div></div>
  );
}

function DomainMatrixCell({ project, domain }: { project: ProjectRiskSummary; domain: RiskDomain }) {
  const summary = project.domainSummaries.find((candidate) => candidate.domain === domain);
  if (!summary?.available || summary.index === null) return <td><span className="matrix-na">N/A</span></td>;
  return <td title={`${summary.label}: ${summary.index.toFixed(1)} of 100, ${summary.severity}`}><span className={`matrix-score matrix-score--${summary.severity}`}><b>{Math.round(summary.index)}</b><small>{cap(summary.severity)}</small></span></td>;
}

function ProjectMatrixRow({ project, showRank, onProject }: { project: ProjectRiskSummary; showRank: boolean; onProject: (id: string) => void }) {
  const ranking = project.calculation.risk.ranking;
  const lowSample = Object.values(project.calculation.risk.normalizations).some((normalization) => normalization?.lowSample === true);
  const rankingLabel = showRank
    ? ranking.eligible && ranking.value !== null
      ? `Rank key ${ranking.value.toFixed(1)}`
      : ranking.exclusionReason === "ciq-unavailable"
        ? "Not ranked · project daily CIQ quality unavailable"
        : ranking.exclusionReason === "low-sample" || lowSample ? "Not ranked · n<20" : "Not ranked"
    : "Point estimate";
  const open = () => onProject(project.project.id);
  return (
    <tr onClick={open} className="clickable-row matrix-row">
      <td><span className="project-code">{project.code}</span><span className="project-name"><strong>{project.project.name}</strong><small>{project.descriptor}</small></span></td>
      <td>{project.risk.value.index === null
        ? <span className="matrix-score"><b>—</b><span className="matrix-na">N/A</span><small>Below 60% evidence floor · {Math.round(project.calculation.risk.coverage * 100)}% coverage</small></span>
        : <span className={`matrix-score matrix-score--${project.risk.value.severity}`}><b>{Math.round(project.risk.value.index)}</b><SeverityBadge severity={project.risk.value.severity} compact /><small>{rankingLabel} · {Math.round(project.calculation.risk.coverage * 100)}% input coverage</small></span>}
      </td>
      <DomainMatrixCell project={project} domain="design" />
      <DomainMatrixCell project={project} domain="rfi" />
      <DomainMatrixCell project={project} domain="quality" />
      <DomainMatrixCell project={project} domain="safety" />
      <DomainMatrixCell project={project} domain="subcontractor" />
      <td>{project.exposure.value.index === null
        ? <span className="matrix-score"><b>—</b><span className="matrix-na">N/A</span><small>Below 60% evidence floor · {Math.round(project.calculation.exposure.coverage * 100)}% coverage</small></span>
        : <span className="matrix-score matrix-score--exposure"><b>{Math.round(project.exposure.value.index)}</b><small>{project.exposure.value.confirmedCostImpact + project.exposure.value.potentialCostExposure} cost · {project.exposure.value.scheduleLinkedItems} schedule {project.exposure.value.scheduleLinkedItems === 1 ? "risk" : "risks"} · {project.calculation.exposure.inputs.scheduleEdgeCount ?? 0} supporting {(project.calculation.exposure.inputs.scheduleEdgeCount ?? 0) === 1 ? "edge" : "edges"} · {Math.round(project.calculation.exposure.coverage * 100)}% input coverage</small></span>}
      </td>
      <td>{project.momentum.value.change7d === null ? <span aria-label="Momentum prior unavailable">— · prior unavailable</span> : <MomentumBadge direction={project.momentum.value.direction} change={project.momentum.value.change7d} />}</td>
      <td><button className="row-arrow" onClick={(event) => { event.stopPropagation(); open(); }} aria-label={`Open ${project.project.name}`}>→</button></td>
    </tr>
  );
}

function ProjectRiskRow({ project, onProject, domainMode = false, metricsSuppressed = false }: { project: ProjectRiskSummary; onProject: (id: string) => void; domainMode?: boolean; metricsSuppressed?: boolean }) {
  const ranking = project.calculation.risk.ranking;
  const lowSample = Object.values(project.calculation.risk.normalizations).some((normalization) => normalization?.lowSample === true);
  const rankingLabel = domainMode
    ? "Current domain condition · not ranked"
    : ranking.eligible && ranking.value !== null
      ? `Rank key ${ranking.value.toFixed(1)} · ${Math.round(ranking.coverage * 100)}% coverage`
      : ranking.exclusionReason === "ciq-unavailable"
        ? "Not ranked · project daily CIQ quality unavailable"
        : ranking.exclusionReason === "low-sample" || lowSample
        ? "Not ranked · active denominator below 20"
        : "Not ranked · insufficient coverage";
  const open = () => onProject(project.project.id);
  const riskCell = metricsSuppressed
    ? <span className="risk-rank-cell"><b className="score">—</b><small>Not calculated for record scope</small></span>
    : project.risk.value.index === null
      ? <span className="risk-rank-cell"><b className="score">—</b><small>N/A · below 60% evidence floor</small></span>
      : <span className="risk-rank-cell" title={`Displayed condition score ${project.risk.value.index.toFixed(1)}. ${rankingLabel}.`}><span><SeverityBadge severity={project.risk.value.severity} compact /><b className="score">{Math.round(project.risk.value.index)}</b></span><small>{rankingLabel}{domainMode ? "" : ` · ${Math.round(project.calculation.risk.coverage * 100)}% input coverage`}</small></span>;
  const exposureCell = metricsSuppressed || domainMode
    ? <><span aria-label={metricsSuppressed ? "Filtered exposure unavailable" : "Domain exposure unavailable"}>—</span><small>{metricsSuppressed ? "Not calculated for record scope" : "Not defined for domain"}</small></>
    : project.exposure.value.index === null
      ? <><span aria-label="Exposure unavailable">—</span><small>N/A · below 60% evidence floor</small></>
      : <><ProgressBar value={project.exposure.value.index} tone="orange" label={`${project.project.name} exposure`} /><b>{Math.round(project.exposure.value.index)}</b><small>{Math.round(project.calculation.exposure.coverage * 100)}% input coverage</small></>;
  return (
    <tr onClick={open} className="clickable-row">
      <td><span className="project-code">{project.code}</span><span className="project-name"><strong>{project.project.name}</strong><small>{project.descriptor}</small></span></td>
      <td>{riskCell}</td>
      <td>{exposureCell}</td>
      <td>{metricsSuppressed ? <span aria-label="Filtered momentum unavailable">—</span> : project.momentum.value.change7d === null ? <span aria-label="Momentum prior unavailable">— · prior unavailable</span> : <MomentumBadge direction={project.momentum.value.direction} change={project.momentum.value.change7d} />}</td>
      <td><span className="coverage-pill">{project.coverage.covered}/{project.coverage.total} domains</span></td>
      <td><button className="row-arrow" onClick={(event) => { event.stopPropagation(); open(); }} aria-label={`Open ${project.project.name}`}>→</button></td>
    </tr>
  );
}

function MoverCard({ label, project, onProject, burn = false, emptyTitle = "No qualifying project", emptyDetail = "No project has a comparable value in this scope." }: { label: string; project?: ProjectRiskSummary; onProject: (id: string) => void; burn?: boolean; emptyTitle?: string; emptyDetail?: string }) {
  if (!project) return <article className="mover-card mover-card--empty"><span className="eyebrow">{label}</span><span className="mover-card__body"><span aria-hidden="true" className="project-code">—</span><span><strong>{emptyTitle}</strong><small>{emptyDetail}</small></span></span></article>;
  const value = burn ? project.burnRate.burnRatio : project.momentum.value.change7d;
  return <button className="mover-card" onClick={() => onProject(project.project.id)}><span className="eyebrow">{label}</span><span className="mover-card__body"><span className="project-code">{project.code}</span><span><strong>{project.project.name}</strong><small>{project.narrative}</small></span><b className={(value ?? 0) < 0 || (burn && (value ?? 0) > 1) ? "mover-value mover-value--good" : "mover-value"}>{value === null || value === undefined ? "—" : burn ? `${value.toFixed(2)}×` : `${value > 0 ? "+" : ""}${value.toFixed(1)} pts`}</b></span></button>;
}

function AttentionView({ attention, records, projects, onFilters, onRecord }: { attention: readonly (AttentionItem & { rawScore: number })[]; records: readonly RiskRecord[]; projects: readonly ProjectRiskSummary[]; onFilters: () => void; onRecord: (identity: RecordIdentity) => void }) {
  const queue = attention.slice(0, 20);
  const openRecords = records.filter((record) => record.open && isConstructionIqRiskApplicable(record));
  const classified = openRecords.filter((record) =>
    record.constructionIqRisk !== "none" && record.constructionIqRisk !== "unmapped"
  ).length;
  const recordByKey = new Map(records.map((record) => [recordIdentityKey(record), record]));
  const projectById = new Map(projects.map((project) => [project.project.id, project]));
  return <><DashboardHeader eyebrow="ACTIONABLE RISK" title="Attention queue" detail="A transparent ranking of the open conditions a human should review first. Priority is derived from the attention score and remains separate from source risk severity." actions={<button className="filter-button" onClick={onFilters}><span aria-hidden="true">≡</span>Refine queue</button>} /><section className="queue-summary"><div><SourceChip label="Synthetic" /><strong>{queue.length}</strong><span>shown · {attention.length} total ranked open records</span></div><div><span className="queue-summary__icon" aria-hidden="true">◎</span><p><b>{classified} of {openRecords.length}</b> visible open Issues/RFIs eligible for record-level Construction IQ risk have a synthetic Autodesk-shaped classification. Unclassified records are unknown, not low risk.</p></div></section><Panel className="queue-panel"><div className="queue-table-head"><span>Priority and source condition</span><span>Why prioritized</span><span>Owner / next action</span></div>{queue.length ? <div className="queue-list">{queue.map((item, index) => <AttentionRow key={item.id} item={item} record={item.evidence[0] ? recordByKey.get(recordIdentityKey(item.evidence[0])) : undefined} project={projectById.get(item.projectId)} rank={index + 1} onOpen={() => onRecord(item.evidence[0]!)} />)}</div> : <EmptyState title="No attention items match" detail="The active filters exclude every ranked open record." />}</Panel><MethodNote /></>;
}

function AttentionRow({ item, record, project, rank, onOpen }: { item: AttentionItem & { rawScore: number }; record?: RiskRecord; project?: ProjectRiskSummary; rank: number; onOpen: () => void }) {
  const firstAction = item.recommendations[0];
  const exposure = record ? attentionExposureSummary(record) : "Exposure unavailable";
  const change = project?.momentum.value.change7d;
  return <button className="queue-row" onClick={onOpen}><span className="queue-rank">{String(rank).padStart(2, "0")}</span><span className="queue-condition"><span className="queue-title-line"><PriorityBadge priority={item.priority} compact /><SourceChip provenance={item.provenance} /></span><strong>{item.title}</strong><small>{item.projectName} · {cap(item.domain)} · {item.ageDays ?? 0} days open</small><span className="queue-facts"><i>Source condition: {recordCiqConditionLabel(record)}</i><i>{exposure}</i><i>{change === null || change === undefined || item.momentum === null ? "Momentum unavailable" : `${cap(item.momentum)} · ${change > 0 ? "+" : ""}${change.toFixed(1)} pts`}</i></span><span className="queue-score">Attention priority score {item.score}{item.rawScore > 100 ? " (capped)" : ""}</span></span><span className="reason-stack">{item.reasons.slice(0, 3).map((entry) => <span key={entry.code}><b>{entry.points > 0 ? "+" : ""}{entry.points}</b>{entry.label}</span>)}{item.reasons.length > 3 ? <small>+ {item.reasons.length - 3} more factors</small> : null}</span><span className="queue-owner"><span className={item.assigneeId ? "owner-state" : "owner-state owner-state--missing"}>{item.assigneeId ? "Named owner" : "! Unassigned"}</span><strong>{firstAction?.title}</strong><small>{item.companyName ?? "No company attribution"}{record?.assigneeName ? ` · ${record.assigneeName}` : item.assigneeId ? " · assignee name unavailable" : ""}</small><span className="row-arrow" aria-hidden="true">→</span></span></button>;
}

function MethodNote() {
  return <p className="method-note"><b>How ranking works:</b> additive, versioned points prioritize review—they are not a measurement of inherent risk. Correlated terms can stack, so the complete factor list remains available on every record.</p>;
}

function ProjectView({
  data,
  projects,
  records,
  relationships,
  attention,
  projectId,
  selectedDomain,
  recordScopeActive,
  historyRange,
  onBack,
  onRecord,
  onNavigate,
}: {
  data: DemoDataset;
  projects: readonly ProjectRiskSummary[];
  records: readonly RiskRecord[];
  relationships: readonly RiskRelationship[];
  attention: readonly (AttentionItem & { rawScore: number })[];
  projectId: string | null;
  selectedDomain: RiskDomain | null;
  recordScopeActive: boolean;
  historyRange: HistoryRange;
  onBack: () => void;
  onRecord: (identity: RecordIdentity) => void;
  onNavigate: (view: ViewId, extra?: QueryUpdate) => void;
}) {
  const summary = resolveScopedProject(projects, projectId);
  if (!summary) {
    return <EmptyState title="Project not found in the active scope" detail="Return to the portfolio or clear the active filters to select an accessible production project." />;
  }

  const projectRecords = records.filter((record) => record.projectId === summary.project.id);
  const projectAllAttention = attention.filter((item) => item.projectId === summary.project.id);
  const projectAttention = projectAllAttention.slice(0, 6);
  const projectHotspots = deriveHotspots(
    projectRecords,
    new Map([[summary.project.id, summary.project.name]]),
    data.asOf,
    "demo-generator",
    data.locations,
  ).filter((hotspot) => hotspot.domains.length >= 2).slice(0, 4);
  const domainSummary = selectedDomain
    ? summary.domainSummaries.find((domain) => domain.domain === selectedDomain && domain.available) ?? null
    : null;
  const visibleDomains = selectedDomain
    ? summary.domainSummaries.filter((domain) => domain.domain === selectedDomain)
    : summary.domainSummaries;
  const displayRisk = domainSummary
    ? {
        index: domainSummary.index,
        severity: domainSummary.severity,
        highRiskOpen: domainSummary.highRiskOpen,
        criticalOverdue: domainSummary.criticalOverdue,
      }
    : summary.risk.value;
  const scopedActionability = actionabilityIndex(projectRecords, data.asOf);
  const projectTrend = rangeSeries(summary.trend, historyRange);
  const scopeLabel = selectedDomain ? cap(selectedDomain) + " domain" : "Whole project";
  const projectRelationships = relationships.filter((edge) => edge.projectId === summary.project.id);
  const projectScheduleExposure = scheduleExposureFromRecords([
    ...projectRecords,
    ...data.records.filter((record) => record.projectId === summary.project.id && record.kind === "schedule-activity"),
  ], projectRelationships);
  const projectBurn = historyRange.coveragePartial
    ? null
    : burnRateFromRecords(projectRecords, historyRange.asOf, historyRange.periodDays, selectedDomain ?? "all", summary.project.id, "demo-generator");
  const persistentRecords = projectRecords.filter((record) => record.open && isConstructionIqRiskApplicable(record) && (record.constructionIqRisk === "critical" || record.constructionIqRisk === "high") && (new Date(data.asOf).getTime() - new Date(record.createdAt).getTime()) / 86_400_000 > 30);
  const affectedCompanies = [...new Set(projectRecords.filter((record) => record.open && record.companyId).map((record) => record.companyId!))];
  const affectedLocations = [...new Set(projectRecords.filter((record) => record.open && record.locationId).map((record) => record.locationId!))];
  const recurringRootCauses = [
    ...recurrenceGroups(projectRecords, "root-cause", data.asOf, 180, "demo-generator"),
    ...recurrenceGroups(projectRecords, "iq-root-cause", data.asOf, 180, "demo-generator"),
  ];
  const potentialCostRecords = projectRecords.filter((record) => record.open && ((record.kind === "rfi" && record.costImpact === "unknown") || (record.kind === "issue" && record.iqCostImpact === "medium")));
  const potentialScheduleIds = new Set([
    ...projectRecords.filter((record) => record.open && record.kind === "rfi" && (record.scheduleImpact === "yes" || record.scheduleImpact === "unknown")).map(recordIdentityKey),
    ...projectScheduleExposure.scheduleLinkedRiskRecords.map(recordIdentityKey),
  ]);
  const factorCounts = new Map<string, number>();
  for (const reason of projectAllAttention.flatMap((item) => item.reasons)) factorCounts.set(reason.label, (factorCounts.get(reason.label) ?? 0) + 1);
  const topFactors = [...factorCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 4);
  const currentTrendPoint = [...summary.trend].reverse().find((point) => point.value !== null);
  const prior30Cutoff = new Date(data.asOf).getTime() - 30 * 86_400_000;
  const prior30Point = [...summary.trend].reverse().find((point) => point.value !== null && new Date(`${point.date.slice(0, 10)}T00:00:00.000Z`).getTime() <= prior30Cutoff);
  const movement30 = currentTrendPoint?.value !== null && currentTrendPoint?.value !== undefined && prior30Point?.value !== null && prior30Point?.value !== undefined
    ? Math.round((currentTrendPoint.value - prior30Point.value) * 10) / 10
    : null;

  return (
    <>
      <section className="project-hero">
        <button className="back-button" onClick={onBack}>← Portfolio</button>
        <div className="project-hero__main">
          <span className="project-code project-code--large">{summary.code}</span>
          <div>
            <p className="eyebrow">PROJECT RISK DETAIL · {scopeLabel.toUpperCase()}</p>
            <h1>{summary.project.name}</h1>
            <p>{summary.descriptor} · {summary.project.city} · {summary.project.value === null || summary.project.value === undefined ? "Value not available" : `${formatCompact(summary.project.value)}${summary.project.currency ? ` ${summary.project.currency}` : ""}`}</p>
          </div>
          {recordScopeActive ? <span className="coverage-pill">Record-filtered scope</span> : <SeverityBadge severity={displayRisk.severity} />}
        </div>
        <div className="project-hero__actions">
          <button className="secondary-button" onClick={() => onNavigate("provenance")}>View provenance</button>
          <button className="filter-button" onClick={() => onNavigate("attention", { filterProject: summary.project.id })}>Open project queue</button>
        </div>
      </section>

      <section className="project-metrics">
        <article>
          <MetricHeader label={selectedDomain ? cap(selectedDomain) + " RISK" : "RISK"} provenance={selectedDomain ? scopedProvenance(summary.risk.provenance, "risk.domain.condition") : summary.risk.provenance} />
          <strong>{recordScopeActive || displayRisk.index === null ? "—" : Math.round(displayRisk.index)}</strong>
          {recordScopeActive ? <span>Not calculated for record scope</span> : <SeverityBadge severity={displayRisk.severity} compact />}
          <p>{recordScopeActive ? `${projectRecords.length} matching evidence records` : `${displayRisk.highRiskOpen} high-risk open · ${displayRisk.criticalOverdue} critical overdue (Submittal mapping approximate) · ${selectedDomain ? "domain evidence point estimate" : `${Math.round(summary.calculation.risk.coverage * 100)}% input coverage`}`}</p>
          <button className="metric-drill" onClick={() => onNavigate("attention", { filterProject: summary.project.id, domain: selectedDomain })}>Drill into records →</button>
        </article>
        <article>
          <MetricHeader label="EXPOSURE" provenance={summary.exposure.provenance} />
          <strong>{recordScopeActive || selectedDomain || summary.exposure.value.index === null ? "—" : Math.round(summary.exposure.value.index)}</strong>
          <span>{recordScopeActive || selectedDomain ? "Not calculated for this scope" : summary.exposure.value.index === null ? "Below the 60% evidence floor" : `${summary.exposure.value.locationsAffected} locations`}</span>
          <p>{recordScopeActive || selectedDomain ? `${new Set(projectRecords.map((record) => record.locationId).filter(Boolean)).size} matching locations · contextual count only` : summary.exposure.value.index === null ? `No eligible exposure population · ${Math.round(summary.calculation.exposure.coverage * 100)}% input coverage` : `${summary.exposure.value.companiesAffected} companies · whole-project context · ${Math.round(summary.calculation.exposure.coverage * 100)}% input coverage`}</p>
          <button className="metric-drill" onClick={() => onNavigate("relationships", { filterProject: summary.project.id })}>Inspect exposure evidence →</button>
        </article>
        <article>
          <MetricHeader label="MOMENTUM" provenance={summary.momentum.provenance} />
          <strong className="metric-text">{recordScopeActive || summary.momentum.value.change7d === null ? "Unavailable" : cap(summary.momentum.value.direction)}</strong>
          {recordScopeActive ? <span>Record-filtered history unavailable</span> : summary.momentum.value.change7d === null ? <span>— · prior observation unavailable</span> : <MomentumBadge direction={summary.momentum.value.direction} change={summary.momentum.value.change7d} />}
          <p>{recordScopeActive ? "Stored snapshot history cannot be retrospectively filtered by record attributes" : summary.momentum.value.change7d === null ? "No direction is inferred without a prior observation" : selectedDomain ? "Current-versus-prior domain condition; daily domain history unavailable" : `${movement30 === null ? "30-day comparison unavailable" : `${movement30 > 0 ? "+" : ""}${movement30} points over 30 days`}`}</p>
          <button className="metric-drill" onClick={() => onNavigate("trends", { filterProject: summary.project.id })}>Open trend history →</button>
        </article>
        <article>
          <MetricHeader label="ACTIONABILITY" provenance={scopedProvenance(summary.risk.provenance, "actionability.index.filtered-records")} />
          <strong>{scopedActionability === null ? "—" : Math.round(scopedActionability)}</strong>
          <span>{scopedActionability === null ? "No eligible records" : "higher = weaker controls"}</span>
          <p>{projectRecords.filter((record) => record.open && !record.assigneeId).length} open records have no named assignee</p>
          <button className="metric-drill" onClick={() => onNavigate("attention", { filterProject: summary.project.id })}>Review accountability →</button>
        </article>
      </section>

      <Panel className="project-context-panel">
        <PanelHead eyebrow="DRILLABLE PROJECT CONTEXT" title="Risk factors, impact, and response" chip={<SourceChip label="Synthetic" />} />
        <div className="project-context-grid">
          <button onClick={() => onNavigate("attention", { filterProject: summary.project.id })}><span>Risk factors</span><b>{topFactors.length || "—"}</b><small>{topFactors.length ? topFactors.map(([label, count]) => `${label} (${count})`).join(" · ") : "No ranked factor population"}</small></button>
          <button onClick={() => onNavigate("companies", { filterProject: summary.project.id })}><span>Affected companies</span><b>{affectedCompanies.length}</b><small>open records with company attribution</small></button>
          <button onClick={() => onNavigate("hotspots", { filterProject: summary.project.id })}><span>Affected locations</span><b>{affectedLocations.length}</b><small>distinct recorded location IDs</small></button>
          <button onClick={() => onNavigate("patterns", { filterProject: summary.project.id })}><span>Recurring root causes</span><b>{recurringRootCauses.length}</b><small>recorded and CIQ-predicted groups shown separately</small></button>
          <button onClick={() => onNavigate("burn", { filterProject: summary.project.id })}><span>Risk burn rate · {historyRange.periodDays} {historyRange.periodDays === 1 ? "day" : "days"}</span><b>{projectBurn?.burnRatio === null || !projectBurn ? "—" : `${projectBurn.burnRatio.toFixed(2)}×`}</b><small>{projectBurn ? `${projectBurn.created} created · ${projectBurn.resolved} resolved` : `Unavailable · retained history begins ${formatDate(data.coverageStart)}`}</small></button>
          <button onClick={() => onNavigate("patterns", { filterProject: summary.project.id, persistence: "persistent" })}><span>Persistence</span><b>{persistentRecords.length}</b><small>open High/Critical longer than 30 days</small></button>
          <button onClick={() => onNavigate("attention", { filterProject: summary.project.id, costExposure: "potential" })}><span>Potential cost exposure</span><b>{potentialCostRecords.length}</b><small>RFI Unknown or CIQ Medium; counts only, never currency</small></button>
          <button onClick={() => onNavigate("relationships", { filterProject: summary.project.id })}><span>Potential schedule exposure</span><b>{potentialScheduleIds.size}</b><small>{projectScheduleExposure.confirmedScheduleEdgeCount} supporting schedule {projectScheduleExposure.confirmedScheduleEdgeCount === 1 ? "edge" : "edges"}; associations are non-causal</small></button>
        </div>
      </Panel>

      {recordScopeActive ? <Panel className="domain-panel"><EmptyState title="Project-level source signals suppressed" detail="Clear record-level filters to inspect whole-project Construction IQ quality and derived safety context." /></Panel> : <section className="truth-grid">
        <Panel>
          <PanelHead eyebrow="SYNTHETIC · AUTODESK-SHAPED FIELD" title="Construction IQ Quality Risk" chip={summary.ciqQuality ? <SourceChip provenance={summary.ciqQuality.provenance} /> : <SourceChip label="Synthetic" syntheticKind="Autodesk-shaped field" />} />
          <div className="truth-card">
            {summary.ciqQuality ? (
              <>
                <SeverityBadge severity={summary.ciqQuality.value.level} />
                <strong>{cap(summary.ciqQuality.value.level)}</strong>
                <p>Observed {formatDate(summary.ciqQuality.value.observedAt)}{summary.ciqQuality.value.forwardFilled ? <> · <span>carried forward to this snapshot</span></> : null}</p>
              </>
            ) : (
              <>
                <SeverityBadge severity="none" />
                <strong>Not Applicable</strong>
                <p>No project-level Construction IQ daily quality row exists in this synthetic scenario.</p>
              </>
            )}
          </div>
        </Panel>
        <Panel>
          <PanelHead eyebrow="SYNTHETIC · DERIVED SIGNAL" title="Project safety condition" chip={<SourceChip label="Synthetic" />} />
          <div className="truth-card">
            <SeverityBadge severity={summary.domainSummaries.find((domain) => domain.domain === "safety")?.severity ?? "none"} />
            <strong>{summary.project.availableDomains.includes("safety") ? cap(summary.domainSummaries.find((domain) => domain.domain === "safety")?.severity ?? "none") : "Not Applicable"}</strong>
            <p>{summary.project.availableDomains.includes("safety") ? "Application-derived safety-domain condition: classified Issue/RFI severity (75%) plus due-date overdue share (25%). Safety observation and checklist signals appear separately. Autodesk supplies no project-level safety risk value." : "No safety signal coverage for this project. Absence is not treated as low risk."}</p>
          </div>
        </Panel>
      </section>}

      <Panel className="domain-panel">
        <PanelHead eyebrow="NINE-DOMAIN VIEW" title={selectedDomain ? cap(selectedDomain) + " risk domain" : "Risk domain breakdown"} chip={<SourceChip label="Synthetic" />} />
        {recordScopeActive ? <EmptyState title="Domain snapshot metrics suppressed" detail="Record filters select evidence, but the stored project/domain snapshots cannot be recomputed from that partial population." /> : <div className="domain-grid">
          {visibleDomains.map((domain) => {
            const drillable = domain.available && domain.evidence.length > 0;
            return <button type="button" key={domain.domain} disabled={!drillable} aria-label={drillable ? `Open ${domain.label} attention evidence` : `${domain.label}: no drillable evidence`} onClick={() => onNavigate("attention", { filterProject: summary.project.id, domain: domain.domain })} className={!domain.available ? "domain-card domain-card--na" : "domain-card"}>
              <div><span className="domain-icon" aria-hidden="true">{domain.domain.slice(0, 1).toUpperCase()}</span><strong>{domain.label}</strong></div>
              {domain.available && domain.index !== null ? (
                <>
                  <span className="domain-index">{domain.index}</span>
                  <SeverityBadge severity={domain.severity} compact />
                  <ProgressBar value={domain.index} tone={domain.severity === "critical" ? "red" : domain.severity === "high" ? "orange" : "blue"} label={domain.label + " risk"} />
                  <small>{domain.highRiskOpen} high · {domain.overdue} {domain.domain === "submittal" ? "approximate overdue" : "overdue"} · {domain.momentum === null ? "— · prior unavailable" : `${domain.momentum > 0 ? "+" : ""}${domain.momentum} pts`}</small>
                </>
              ) : (
                <><span className="domain-index">–</span><SeverityBadge severity="none" compact /><small>{domain.available ? "No eligible evidence" : "No coverage for this project"}</small></>
              )}
            </button>;
          })}
        </div>}
      </Panel>

      <section className="project-detail-grid">
        <Panel>
          <PanelHead eyebrow="HISTORICAL SNAPSHOTS" title="Risk trend" chip={<SourceChip label="Synthetic" />} />
          <div className="chart-panel">
            {recordScopeActive ? (
              <EmptyState title="Filtered trend unavailable" detail="Project snapshot history cannot be retrospectively filtered by record attributes." />
            ) : selectedDomain ? (
              <EmptyState title="Domain trend unavailable" detail="The source contains whole-project snapshot history only, so no domain-specific series is implied." />
            ) : projectTrend.length ? (
              <TrendChart points={projectTrend} label={`${summary.project.name} risk index over ${historyRange.label.toLowerCase()}`} threshold={55} />
            ) : (
              <EmptyState title="No history in this range" detail="The selected window does not include a project snapshot." />
            )}
            {!selectedDomain && !recordScopeActive ? <div className="chart-legend"><span><i className="legend-dot" />Observed snapshot</span><span><i className="legend-line" />Forward-filled daily value</span><span><i className="legend-threshold" />High threshold</span></div> : null}
          </div>
        </Panel>
        <Panel>
          <PanelHead eyebrow="CURRENT EVIDENCE" title="Records driving attention" action={<button className="panel-link" onClick={() => onNavigate("attention", { filterProject: summary.project.id })}>View all →</button>} />
          {projectAttention.length ? <div className="mini-record-list">{projectAttention.map((item) => (
            <button key={item.id} onClick={() => onRecord(item.evidence[0]!)}>
              <span><PriorityBadge priority={item.priority} compact /><strong>{item.title}</strong><small>{cap(item.domain)} · {item.ageDays} days · {item.assigneeId ? "Named owner" : "Unassigned"}</small></span><b aria-label={`Attention priority score ${item.score}`}>{item.score}</b>
            </button>
          ))}</div> : <EmptyState title="No attention records in scope" detail="The active filters exclude every ranked record for this project." />}
        </Panel>
      </section>

      <section className="project-detail-grid project-detail-grid--bottom">
        <Panel>
          <PanelHead eyebrow="MULTI-DOMAIN OVERLAP" title="Location hotspots" chip={<SourceChip label="Synthetic" />} />
          {projectHotspots.length ? <div className="hotspot-mini-list">{projectHotspots.map((hotspot) => (
            <button type="button" key={hotspot.locationId} onClick={() => hotspot.evidence[0] && onRecord(hotspot.evidence[0])}><span className="hotspot-score">{Math.round(hotspot.overlapScore)}</span><span><strong>{hotspot.path}</strong><small>{hotspot.domains.map(cap).join(" + ")} · {hotspot.evidence.length} records</small></span><span className="row-arrow" aria-hidden="true">→</span></button>
          ))}</div> : <EmptyState title="No multi-domain hotspot" detail="The visible records do not overlap across two or more domains at one location." />}
        </Panel>
        <Panel>
          <PanelHead eyebrow="DETERMINISTIC GUIDANCE" title="Suggested next actions" chip={<SourceChip label="Synthetic" />} />
          {projectAttention.some((item) => item.recommendations.length) ? <div className="action-list">{projectAttention.flatMap((item) => item.recommendations).slice(0, 3).map((action, index) => (
            <article key={action.id + "-" + index}><span>{index + 1}</span><div><strong>{action.title}</strong><p>{action.detail}</p><small>Rule-based · {action.citedEvidence.length} cited record</small></div></article>
          ))}</div> : <EmptyState title="No mitigation suggestions in scope" detail="No ranked record is available to support a deterministic recommendation." />}
        </Panel>
      </section>
    </>
  );
}

function FormSignalPanel({ data, records, projectId }: { data: DemoDataset; records: readonly RiskRecord[]; projectId: string | null }) {
  const signals = data.formSignals.flatMap((signal) => {
    if (signal.projectId !== projectId) return [];
    const matching = records.filter((record) => formRecordMatchesSignal(record, signal));
    if (!matching.length) return [];
    const current = matching.filter((record) => record.raw?.period_bucket === "current");
    const previous = matching.filter((record) => record.raw?.period_bucket === "previous");
    return [{
      signal,
      current,
      previous,
      activityChange: previous.length
        ? Math.round((1_000 * (current.length - previous.length)) / previous.length) / 10
        : null,
    }];
  });
  if (!signals.length) return null;
  return (
    <Panel className="form-signal-panel">
      <PanelHead eyebrow="LEADING INDICATOR" title="Checklist and form activity" chip={<SourceChip label="Derived" />} />
      <div className="form-signal-list">{signals.map(({ signal, current, previous, activityChange }) => (
        <div className="form-signal-grid" key={formSignalIdentityKey(signal)}>
          <article><span>Inspections</span><b>{current.length}</b><small>{signal.period} · filtered scope</small></article>
          <article><span>Configured exceptions</span><b>{current.filter((record) => record.raw?.application_defined_exception === true).length}</b><small>Application-defined response map</small></article>
          <article><span>Activity change</span><b className="metric-neutral">{activityChange === null ? "—" : `${activityChange > 0 ? "+" : ""}${activityChange}%`}</b><small>{activityChange === null ? "prior-period evidence outside scope" : `${current.length} current vs ${previous.length} prior · activity only`}</small></article>
          <p><strong>{signal.templateName}</strong><small>Template {signal.templateId} · layout {signal.layoutUid}</small>{signal.note} This is a correlation signal for investigation, not a causal or Autodesk-provided conformance score. <SourceChip provenance={signal.provenance} /></p>
        </div>
      ))}</div>
    </Panel>
  );
}

function TrendsView({ data, projects, records, selectedDomain, recordScopeActive, historyRange }: { data: DemoDataset; projects: readonly ProjectRiskSummary[]; records: readonly RiskRecord[]; selectedDomain: RiskDomain | null; recordScopeActive: boolean; historyRange: HistoryRange }) {
  const [period, setPeriod] = useState<"daily" | "weekly" | "monthly">("daily");
  if (recordScopeActive) {
    return <><DashboardHeader eyebrow="HISTORICAL INTELLIGENCE" title="Filtered risk trends" detail="The stored project snapshots do not retain every record attribute needed to reapply the current evidence filters historically. Whole-project history is intentionally not substituted." /><Panel className="trend-main-panel"><EmptyState title="Record-filtered history is unavailable" detail="Clear company, trade, discipline, location, root cause, record status, severity, persistence, recurrence, or impact filters to view project snapshot history." /></Panel></>;
  }
  if (selectedDomain) {
    return <><DashboardHeader eyebrow="HISTORICAL INTELLIGENCE" title={`${cap(selectedDomain)} risk trends`} detail="The source dataset supports current and prior domain conditions, but not a validated daily domain history. Whole-project time series are intentionally not substituted." /><Panel className="trend-main-panel"><EmptyState title="Domain history is unavailable" detail={`Clear the ${selectedDomain} domain filter to view whole-project history, or use the command center for current-versus-prior ${selectedDomain} momentum.`} /></Panel></>;
  }
  const completePortfolio = portfolioSeries(projects);
  const completeRolling = rollingAverageSeries(completePortfolio);
  const rangeDays = historyRange.periodDays;
  const dailyPortfolio = rangeSeries(completePortfolio, historyRange);
  const chartPoints = aggregateSeries(dailyPortfolio, period);
  const rollingPoints = aggregateSeries(rangeSeries(completeRolling, historyRange), period);
  const previousRange = previousHistoryRange(historyRange, data.coverageStart);
  const previousDaily = previousRange.coveragePartial ? [] : rangeSeries(completePortfolio, previousRange);
  const previousRolling = previousRange.coveragePartial ? [] : rangeSeries(completeRolling, previousRange);
  const previousPoints = aggregateSeries(previousDaily, period);
  const currentRiskMean = average(dailyPortfolio.map((point) => point.value).filter((value): value is number => value !== null));
  const previousRiskMean = average(previousDaily.map((point) => point.value).filter((value): value is number => value !== null));
  const currentBurn = historyRange.coveragePartial
    ? null
    : burnRateFromRecords(records, historyRange.asOf, rangeDays, "all", "hub", "demo-generator");
  const previousBurn = previousRange.coveragePartial
    ? null
    : burnRateFromRecords(records, previousRange.asOf, rangeDays, "all", "hub", "demo-generator");
  const currentExposure = average(projects.map((project) => project.exposure.value.index));
  const riskInputCoverage = coverageRange(projects.map((project) => project.calculation.risk.coverage));
  const exposureInputCoverage = coverageRange(projects.map((project) => project.calculation.exposure.coverage));
  const change7d = average(projects.map((project) => project.momentum.value.change7d).filter((value): value is number => value !== null));
  const change28d = average(projects.map((project) => project.momentum.value.change28d).filter((value): value is number => value !== null));
  const elevated = projects.length ? Math.round(average(projects.map((project) => project.momentum.value.consecutiveElevatedPeriods)) ?? 0) : null;
  const rangeLabel = historyRange.label.toLowerCase();
  const trendProvenance = scopedProvenance(data.portfolio.risk.provenance, "risk.portfolio.filtered-mean-project-index");
  const velocity = buildRiskVelocityEvidence(projects.map((project) => project.momentum), {
    asOf: historyRange.asOf,
    scopeLabel: "Current filtered portfolio",
    sourceSystem: "demo-generator",
    sourceDataset: "project-risk-snapshots",
    series: dailyPortfolio,
  });
  return (
    <>
      <DashboardHeader
        eyebrow="HISTORICAL INTELLIGENCE"
        title="Risk trends"
        detail="Read observed snapshots, carried-forward Construction IQ values, and application-derived momentum without smoothing over coverage or method changes."
        actions={<div className="segmented" aria-label="Trend interval">{(["daily", "weekly", "monthly"] as const).map((item) => <button aria-pressed={period === item} className={period === item ? "active" : ""} onClick={() => setPeriod(item)} key={item}>{cap(item)}</button>)}</div>}
      />
      <section className="trend-kpis">
        <article><span>Mean 7-day change</span><b className={change7d === null || change7d === 0 ? "metric-neutral" : change7d < 0 ? "metric-good" : "metric-up"}>{change7d === null ? "—" : `${change7d > 0 ? "+" : ""}${change7d.toFixed(1)}`}</b><small>project index points</small><SourceChip label="Synthetic" /></article>
        <article><span>Mean 28-day change</span><b className={change28d === null || change28d === 0 ? "metric-neutral" : change28d < 0 ? "metric-good" : "metric-up"}>{change28d === null ? "—" : `${change28d > 0 ? "+" : ""}${change28d.toFixed(1)}`}</b><small>project index points</small><SourceChip label="Synthetic" /></article>
        <article><span>Mean consecutive elevated</span><b>{elevated ?? "—"}</b><small>daily periods</small><SourceChip label="Synthetic" /></article>
        <article><span>Coverage</span><b>{projects.length}/{data.projects.length}</b><small>production projects</small><SourceChip label="Synthetic" /></article>
      </section>
      <RiskVelocityEvidencePanel velocity={velocity} />
      <Panel className="trend-main-panel">
        <PanelHead eyebrow={`${period.toUpperCase()} · ${rangeLabel.toUpperCase()}`} title="Mean project risk index" chip={<SourceChip provenance={trendProvenance} />} action={<span className="coverage-pill">Current projects · {riskInputCoverage}</span>} />
        <div className="large-chart">
          {chartPoints.length ? <TrendChart points={chartPoints} rollingAverage={rollingPoints} comparison={{ points: previousPoints, label: "Previous period" }} label={`Mean filtered-project risk index, ${rangeLabel}, shown ${period}`} threshold={55} /> : <EmptyState title="No trend data matches" detail="Clear one or more filters to restore project history." />}
          <div className="chart-legend"><span><i className="legend-dot" />{period === "daily" ? "Observed source point" : `${cap(period)} period end`}</span><span><i className="legend-line" />Carried value (dashed)</span><span><i className="legend-rolling" />7-day rolling average</span><span><i className="legend-previous" />Previous period</span><span><i className="legend-threshold" />High threshold</span></div>
        </div>
      </Panel>
      <Panel className="trend-compare-panel">
        <PanelHead eyebrow="CURRENT VS PREVIOUS PERIOD" title={`Risk flow comparison · ${historyRange.label}`} chip={<SourceChip label="Synthetic" />} />
        <div className="trend-compare-table" role="table" aria-label={`Current and previous ${rangeDays}-day risk comparison`}>
          <div role="row" className="trend-compare-table__head"><span role="columnheader">Period</span><span role="columnheader">Mean risk</span><span role="columnheader">New records</span><span role="columnheader">Resolved records</span><span role="columnheader">Exposure</span><span role="columnheader">Rolling mean at end</span></div>
          <div role="row"><strong role="cell">Current</strong><span role="cell">{currentRiskMean === null ? "—" : <>{currentRiskMean.toFixed(1)}<small>{riskInputCoverage}{historyRange.coveragePartial ? ` · partial history since ${formatDate(data.coverageStart)}` : ""}</small></>}</span><span role="cell">{currentBurn ? currentBurn.created : <>—<small>incomplete retained coverage</small></>}</span><span role="cell">{currentBurn ? currentBurn.resolved : <>—<small>incomplete retained coverage</small></>}</span><span role="cell">{currentExposure === null ? "—" : <>{currentExposure.toFixed(1)} current snapshot<small>{exposureInputCoverage}</small></>}</span><span role="cell">{rollingPoints.at(-1)?.value?.toFixed(1) ?? "—"}</span></div>
          <div role="row"><strong role="cell">Previous</strong><span role="cell">{previousRiskMean === null ? <>—{previousRange.coveragePartial ? <small>incomplete retained coverage</small> : null}</> : previousRiskMean.toFixed(1)}</span><span role="cell">{previousBurn ? previousBurn.created : <>—<small>incomplete retained coverage</small></>}</span><span role="cell">{previousBurn ? previousBurn.resolved : <>—<small>incomplete retained coverage</small></>}</span><span role="cell">— <small>no historical exposure series</small></span><span role="cell">{previousPoints.length ? previousRolling.at(-1)?.value?.toFixed(1) ?? "—" : "—"}</span></div>
        </div>
        <p className="trend-compare-note">Exposure is a current project snapshot only and is never backfilled into the previous period. New/resolved counts use the same half-open burn windows and eligible record kinds as Burn-down. A burn period that starts before retained history is unavailable rather than treating uncovered days as zero.</p>
      </Panel>
      <section className="small-multiple-grid">{projects.slice(0, 6).map((project) => {
        const points = aggregateSeries(rangeSeries(project.trend, historyRange), period);
        return <article className="small-trend" key={project.project.id}><div><span className="project-code">{project.code}</span><span><strong>{project.project.name}</strong><small>{project.risk.value.severity} risk · {project.coverage.covered}/{project.coverage.total} domains</small></span>{project.momentum.value.change7d === null ? <span aria-label="Momentum prior unavailable">— · prior unavailable</span> : <MomentumBadge direction={project.momentum.value.direction} change={project.momentum.value.change7d} />}</div><TrendChart compact points={points} label={`${project.project.name} trend, ${rangeLabel}, shown ${period}`} /></article>;
      })}</section>
      <p className="method-note"><b>Forward-fill rule:</b> a missing daily Construction IQ row carries the latest prior value as a step function. Observed dates remain marked, and a value older than 90 days is labelled stale rather than silently extended. Weekly and monthly views show the final daily value in each interval. The selected window is [{historyRange.startDate}, {new Date(historyRange.throughExclusive).toISOString().slice(0, 10)}) UTC.{historyRange.coveragePartial ? ` Retained demo history begins ${data.coverageStart}, so the earlier part of this window has no observations and is not rendered as zero.` : ""}{previousRange.coveragePartial ? " The previous-period comparison is withheld because its complete window is not retained." : ""} Current project input-coverage ranges are disclosed; historical per-day formula coverage is not retained in this synthetic fixture.</p>
    </>
  );
}

function HotspotsView({ data, projects, records, onRecord }: { data: DemoDataset; projects: readonly ProjectRiskSummary[]; records: readonly RiskRecord[]; onRecord: (identity: RecordIdentity) => void }) {
  const projectNames = new Map(projects.map((project) => [project.project.id, project.project.name]));
  const eligible = records.filter((record) => record.open && isConstructionIqRiskApplicable(record) && (record.constructionIqRisk === "high" || record.constructionIqRisk === "medium"));
  const resolvedLocationKeys = new Set(data.locations.map((node) => JSON.stringify([node.projectId, node.id])));
  const missingLocationId = eligible.filter((record) => !record.locationId).length;
  const missingLocationPath = eligible.filter((record) =>
    record.locationId && !record.locationPath && !resolvedLocationKeys.has(JSON.stringify([record.projectId, record.locationId]))
  ).length;
  const missingLocationShare = eligible.length ? Math.round((missingLocationId / eligible.length) * 1_000) / 10 : null;
  const hotspots = deriveHotspots(records, projectNames, data.asOf, "demo-generator", data.locations).filter((hotspot) => hotspot.domains.length >= 2);
  return <><DashboardHeader eyebrow="LOCATION INTELLIGENCE" title="Multi-domain hotspots" detail="Only locations with two or more visible risk domains are called hotspots; volume alone cannot create one." /><section className="hotspot-layout"><Panel><PanelHead eyebrow="OVERLAP MAP" title="Portfolio multi-domain location signal" chip={<SourceChip label="Synthetic" />} />{hotspots.length ? <><div className="heatmap" role="group" aria-label="Portfolio multi-domain location overlap scores">{hotspots.slice(0, 12).map((hotspot, index) => <button key={`${hotspot.projectId}:${hotspot.locationId}`} className={`heat-cell heat-cell--${Math.min(4, Math.max(1, Math.ceil(hotspot.overlapScore / 25)))}`} style={{ gridColumn: `${(index * 3) % 7 + 1} / span ${index % 3 === 0 ? 2 : 1}`, gridRow: `${Math.floor(index / 3) + 1} / span ${index % 4 === 0 ? 2 : 1}` }} title={`${hotspot.path}: ${hotspot.overlapScore}`} onClick={() => hotspot.evidence[0] && onRecord(hotspot.evidence[0])}><span>{Math.round(hotspot.overlapScore)}</span><small>{hotspot.path.split(" > ").at(-1)}</small></button>)}</div><div className="heat-legend"><span>Lower overlap</span><i /><i /><i /><i /><span>Higher overlap</span></div></> : <EmptyState title="No multi-domain hotspots in this scope" detail="No location contains open High/Medium records from at least two visible domains." />}</Panel><Panel><PanelHead eyebrow="PRIORITIZED LOCATIONS" title={eligible.length ? `${hotspots.length} multi-domain ${hotspots.length === 1 ? "hotspot" : "hotspots"} in view` : "Hotspot count unavailable"} />{hotspots.length ? <div className="hotspot-list">{hotspots.slice(0, 8).map((hotspot, index) => <button key={`${hotspot.projectId}:${hotspot.locationId}`} onClick={() => hotspot.evidence[0] && onRecord(hotspot.evidence[0])}><span className="queue-rank">{String(index + 1).padStart(2, "0")}</span><span><strong>{hotspot.path}</strong><small>{hotspot.projectName}</small><span className="domain-token-row">{hotspot.domains.map((domain) => <i key={domain}>{cap(domain)}</i>)}</span></span><span className="hotspot-list__score"><b>{Math.round(hotspot.overlapScore)}</b><small>overlap</small><em>{hotspot.evidence.length} records</em></span></button>)}</div> : <EmptyState title="No prioritized locations" detail="Broaden the scope or clear record filters to look for multi-domain overlap." />}</Panel></section><Panel className="location-method"><PanelHead eyebrow="DERIVATION DISCLOSURE" title="How locations are interpreted" chip={<SourceChip label="Synthetic" />} /><div className="location-method__grid"><p><b>Location coverage</b>{eligible.length ? <>{missingLocationId} of {eligible.length} eligible High/Medium records ({missingLocationShare}%) have no location ID and are excluded, never treated as low risk.{missingLocationPath ? ` Another ${missingLocationPath} have an ID but no resolvable location node or path.` : ""}</> : <>No eligible High/Medium record population is available; coverage is not reported as 0%.</>}</p><p><b>Location-capable sources</b>Issues, RFIs, Forms, and clash-linked Issues can contribute locations. Submittals expose no supported location field.</p><p><b>Descendants are re-evaluated</b>Roll-ups traverse explicit synthetic location-node parent identities and use the union of descendant records; display-path text is never treated as hierarchy and child scores are never added.</p><p><b>Overlap, not volume</b>Open High/Medium records combine domain breadth (50%), Simpson diversity (30%), and volume capped at 20 (20%).</p></div></Panel></>;
}

function ConcentrationView({ data, records, params, selectedSeverity, updateQuery, onRecord }: { data: DemoDataset; records: readonly RiskRecord[]; params: ReturnType<typeof useSearchParams>; selectedSeverity: Severity | null; updateQuery: (updates: QueryUpdate, mode?: "push" | "replace") => void; onRecord: (identity: RecordIdentity) => void }) {
  const allowed = ["company", "trade", "discipline", "root-cause", "iq-root-cause", "location", "building-component", "issue-type", "project-type", "project-phase", "business-unit"] as const;
  const requested = params.get("dimension") as typeof allowed[number] | null;
  const dimension = requested && allowed.includes(requested) ? requested : "trade";
  const elevatedPopulation = records.filter((record) => record.open && isConstructionIqRiskApplicable(record) && (selectedSeverity ? true : record.constructionIqRisk === "high"));
  const population = concentrationEligibleRecords(elevatedPopulation, dimension);
  const allBuckets = concentration(population, dimension, data.companies, data.asOf, "demo-generator", { projects: data.projects.map((summary) => summary.project), businessUnits: data.businessUnits });
  const unattributed = allBuckets.find((bucket) => bucket.key === "unattributed");
  const buckets = allBuckets.filter((bucket) => bucket.key !== "unattributed");
  const attributableCount = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const maximum = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const top3Share = buckets.slice(0, 3).reduce((sum, bucket) => sum + bucket.shareOfTotal, 0);
  const populationLabel = selectedSeverity ? `open ${selectedSeverity} records` : "open high-risk records";
  const dimensionLabel = dimension === "root-cause" ? "Recorded root cause" : dimension === "iq-root-cause" ? "CIQ predicted root cause" : dimension === "discipline" ? "Discipline + source" : dimension === "building-component" ? "System / component" : dimension === "issue-type" ? "Project-scoped issue type" : dimension === "project-phase" ? "Project current phase" : cap(dimension);
  const attributableShare = population.length ? Math.round((attributableCount / population.length) * 100) : 0;
  return <><DashboardHeader eyebrow="PORTFOLIO CONCENTRATION" title="Where risk is clustering" detail="Compare attributable elevated conditions by company, trade, source-qualified discipline, recorded issue root cause, Construction IQ predicted root cause, location, or system/component. The two root-cause origins are never merged. Missing keys stay outside the denominator and remain visible." actions={<SourceChip label="Synthetic" />} /><div className="dimension-tabs" role="group" aria-label="Concentration dimension">{allowed.map((item) => <button aria-pressed={dimension === item} className={dimension === item ? "active" : ""} onClick={() => updateQuery({ dimension: item }, "replace")} key={item}>{item === "root-cause" ? "Recorded root cause" : item === "iq-root-cause" ? "CIQ predicted root cause" : item === "discipline" ? "Discipline + source" : item === "building-component" ? "System / component" : cap(item)}</button>)}</div><section className="concentration-layout"><Panel><PanelHead eyebrow="PARETO DISTRIBUTION" title={`${cap(populationLabel)} by ${dimensionLabel.toLowerCase()}`} chip={<SourceChip label="Synthetic" />} action={<span className="coverage-pill">{population.length ? `${attributableCount} of ${population.length} attributable` : "Population unavailable"}</span>} />{population.length === 0 ? <EmptyState title="No elevated records in this scope" detail="No concentration denominator is available. Broaden the filters to restore the population." /> : buckets.length ? <div className="pareto-list">{buckets.map((bucket, index) => <button key={bucket.key} onClick={() => bucket.evidence[0] && onRecord(bucket.evidence[0])}><span className="pareto-rank">{index + 1}</span><span className="pareto-label"><strong>{bucket.label}</strong><small>{bucket.projectsAffected} project{bucket.projectsAffected === 1 ? "" : "s"} affected</small></span><span className="pareto-bar"><i style={{ width: `${(bucket.count / maximum) * 100}%` }} /></span><b>{bucket.count}</b><em>{Math.round(bucket.shareOfTotal * 100)}%</em></button>)}</div> : <EmptyState title={`No attributable ${dimensionLabel.toLowerCase()} values`} detail={`${unattributed?.count ?? population.length} records remain explicitly unattributed for this dimension.`} />}</Panel><aside className="concentration-summary"><article className="dark-insight"><span className="eyebrow">TOP-3 ATTRIBUTABLE SHARE</span><b>{attributableCount ? `${Math.round(top3Share * 100)}%` : "—"}</b><p>{population.length ? `The leading three ${dimensionLabel.toLowerCase()} buckets account for ${buckets.slice(0, 3).reduce((sum, bucket) => sum + bucket.count, 0)} of ${attributableCount} attributable ${populationLabel}.` : "Unavailable because the selected population is empty."}</p><SourceChip label="Synthetic" /></article><article><span className="eyebrow">ATTRIBUTABLE COVERAGE</span><b>{population.length ? `${attributableCount}/${population.length}` : "—"}</b><p>{population.length ? `${attributableShare}% of the selected population has a usable ${dimensionLabel.toLowerCase()} key. Shares use only these attributable records.` : "Coverage is unavailable without a selected population."}</p></article><article><span className="eyebrow">UNATTRIBUTED</span><b>{population.length ? unattributed?.count ?? 0 : "—"}</b><p>{population.length ? "Records with a missing or unresolved key are disclosed here and never merged into Other or counted as zero." : "Unavailable without a selected population."}</p></article></aside></section></>;
}

function PatternsView({ data, projects, records, attention, onRecord }: { data: DemoDataset; projects: readonly ProjectRiskSummary[]; records: readonly RiskRecord[]; attention: readonly (AttentionItem & { rawScore: number })[]; onRecord: (identity: RecordIdentity) => void }) {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const groups = recurrenceGroupsAcrossDimensions(records, data.asOf, 180, "demo-generator");
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;
  const projectNames = new Map(projects.map((summary) => [summary.project.id, summary.project.name]));
  const companyNames = new Map(data.companies.map((company) => [company.id, company.name]));
  const persistent = records.filter((record) => {
    const ageDays = Math.floor((new Date(data.asOf).getTime() - new Date(record.createdAt).getTime()) / 86_400_000);
    const severity = effectiveRecordSeverity(record, attention);
    return record.open && ageDays > 30 && (severity === "critical" || severity === "high");
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const recurringProjects = new Set(groups.flatMap((group) => group.projectsAffected)).size;
  const selectedPopulation = selectedGroup
    ? recurrencePopulationStats(records, selectedGroup.dimension as (typeof RECURRENCE_DIMENSIONS)[number], data.asOf, 180)
    : null;
  const selectedDistinctSignatures = selectedPopulation?.distinctSignatures ?? 0;
  const selectedRelevantEvents = selectedPopulation?.relevantEvents ?? 0;
  if (!records.length) return <><DashboardHeader eyebrow="REPEATED AND AGING CONDITIONS" title="Recurring & persistent risk" detail="Separate repeated signatures from individual high-risk records that remain open." /><EmptyState title="Pattern population unavailable" detail="No source record matches the active scope, so recurrence, persistence, and rates are not reported as zero." /></>;
  return <>
    <DashboardHeader eyebrow="REPEATED AND AGING CONDITIONS" title="Recurring & persistent risk" detail="Separate repeated signatures from individual high-risk records that remain open. Both are investigation signals; neither establishes cause or company performance." />
    <section className="pattern-summary">
      <article><span>Recurring signatures</span><b>{groups.length}</b><small>2+ occurrences within 180 days</small><SourceChip label="Synthetic" /></article>
      <article><span>Projects affected</span><b>{recurringProjects}</b><small>by a visible recurring signature</small><SourceChip label="Synthetic" /></article>
      <article><span>Persistent high risk</span><b>{persistent.length}</b><small>open longer than 30 days</small><SourceChip label="Synthetic" /></article>
    </section>
    <section className="pattern-layout">
      <Panel>
        <PanelHead eyebrow="RECURRENCE" title="Repeated signatures in this scope" />
        {groups.length ? <div className="pattern-list">{groups.map((group) => {
          const displayLabel = group.dimension === "company" ? companyNames.get(group.signature) ?? group.label : group.label;
          const originLabel = group.dimension === "root-cause" ? "recorded issue root cause" : group.dimension === "iq-root-cause" ? "CIQ predicted root cause" : group.dimension.replaceAll("-", " ");
          return <button key={`${group.dimension}:${group.id}`} aria-pressed={selectedGroup?.id === group.id} onClick={() => setSelectedGroupId(group.id)}>
            <span className="pattern-list__metric"><b>{group.occurrences}</b><small>occurrences</small></span>
            <span><strong>{displayLabel}</strong><small>{originLabel} · {group.projectsAffected.length} project{group.projectsAffected.length === 1 ? "" : "s"}</small><em>{formatDate(group.firstSeen)} – {formatDate(group.lastSeen)}</em></span>
            <SourceChip provenance={group.provenance} />
            <span className="row-arrow" aria-hidden="true">→</span>
          </button>;
        })}</div> : <EmptyState title="No recurring signatures in this scope" detail="A group appears only when at least two records share a recorded issue cause, a separate CIQ-predicted cause, location, company, or building-component signature inside 180 days." />}
      </Panel>
      <Panel>
        <PanelHead eyebrow="PERSISTENCE" title="High-risk records open over 30 days" />
        {persistent.length ? <div className="persistent-list">{persistent.map((record) => {
          const severity = effectiveRecordSeverity(record, attention);
          const ageDays = Math.floor((new Date(data.asOf).getTime() - new Date(record.createdAt).getTime()) / 86_400_000);
          return <button key={recordIdentityKey(record)} onClick={() => onRecord(record)}>
            <SeverityBadge severity={severity} compact />
            <span><strong>{record.title}</strong><small>{projectNames.get(record.projectId) ?? "Unknown project"} · {cap(record.domain)}</small></span>
            <span className="pattern-list__metric"><b>{ageDays}</b><small>days open</small></span>
            <span className="row-arrow" aria-hidden="true">→</span>
          </button>;
        })}</div> : <EmptyState title="No persistent high-risk records" detail="No visible critical or high-risk record has remained open longer than 30 days." />}
      </Panel>
    </section>
    {selectedGroup ? <Panel className="recurrence-detail-panel"><PanelHead eyebrow="RECURRENCE GROUP DETAIL" title={selectedGroup.label} chip={<SourceChip provenance={selectedGroup.provenance} />} action={<span className="coverage-pill">{selectedGroup.dimension === "root-cause" ? "Recorded issue root cause" : selectedGroup.dimension === "iq-root-cause" ? "CIQ predicted root cause" : cap(selectedGroup.dimension.replaceAll("-", " "))}</span>} /><div className="recurrence-detail-summary"><article><span>Occurrences</span><b>{selectedGroup.occurrences}</b></article><article><span>Repeated events</span><b>{selectedGroup.occurrences - 1}</b></article><article><span>Total relevant events</span><b>{selectedRelevantEvents}</b></article><article><span>Distinct signatures</span><b>{selectedDistinctSignatures}</b></article><article><span>Recurrence rate</span><b>{selectedDistinctSignatures >= 8 ? `${Math.round(selectedGroup.recurrenceRate * 1000) / 10}%` : "—"}</b><small>{selectedDistinctSignatures >= 8 ? `${selectedGroup.occurrences - 1} repeated / ${selectedRelevantEvents} relevant events` : `Suppressed below 8 distinct signatures; ${selectedPopulation?.excludedEvents ?? 0} in-window records lacked this key`}</small></article></div><div className="recurrence-occurrences"><h3>Underlying occurrences</h3>{selectedGroup.evidence.map((evidence) => { const occurrence = records.find((record) => sameRecordIdentity(record, evidence)); return <button key={recordIdentityKey(evidence)} onClick={() => onRecord(evidence)}><span><strong>{evidence.label ?? occurrence?.title ?? evidence.id}</strong><small>{projectNames.get(evidence.projectId) ?? evidence.projectId} · {occurrence ? `${cap(occurrence.domain)} · ${formatDate(occurrence.createdAt)}` : evidence.kind}</small></span><span className="row-arrow" aria-hidden="true">→</span></button>; })}</div></Panel> : null}
    <p className="method-note"><b>Definitions:</b> recurrence groups configured similarity signatures with at least two occurrences in the trailing 180 days. Recorded causes use the project-scoped Autodesk cause ID in a single project; cross-project groups use the version {RECORDED_ROOT_CAUSE_NORMALIZATION_VERSION} title dictionary. CIQ-predicted causes remain separate. Rates show repeated events divided by total eligible events and are suppressed below eight distinct signatures. Persistence means an effective critical/high condition that is still open more than 30 days after creation. These measures do not infer negligence, causality, or time in the current status.</p>
  </>;
}

function BurnView({ data, projects, records, historyRange, onRecord }: { data: DemoDataset; projects: readonly ProjectRiskSummary[]; records: readonly RiskRecord[]; historyRange: HistoryRange; onRecord: (identity: RecordIdentity) => void }) {
  const rangeDays = historyRange.periodDays;
  const eligiblePopulation = burnEligibleRecords(records);
  const burn = burnRateFromRecords(records, historyRange.asOf, rangeDays, "all", "hub", "demo-generator");
  const monthlyBurn = burnRateFromRecords(records, data.asOf, 30, "all", "hub-month", "demo-generator");
  const history = weeklyBurnHistory(records, historyRange.asOf, rangeDays);
  const growthRecommendation = burnGrowthRecommendation(records, historyRange.asOf, rangeDays, "hub");
  const maximum = Math.max(1, ...history.flatMap((week) => [week.created, week.resolved]));
  const projectRows = projects.map((project) => ({
    project,
    burn: burnRateFromRecords(records.filter((record) => record.projectId === project.project.id), historyRange.asOf, rangeDays, "all", project.project.id, "demo-generator"),
  })).sort((a, b) => (a.burn.burnRatio ?? Number.POSITIVE_INFINITY) - (b.burn.burnRatio ?? Number.POSITIVE_INFINITY));
  const domainRows = uniqueOptions(eligiblePopulation.map((record) => record.domain)).map((domain) => ({
    label: cap(domain),
    burn: burnRateFromRecords(records, historyRange.asOf, rangeDays, domain as RiskDomain, `domain-${domain}`, "demo-generator"),
  }));
  const companyRows = data.companies.map((company) => ({
    label: company.name,
    burn: burnRateFromRecords(records.filter((record) => record.companyId === company.id), historyRange.asOf, rangeDays, "all", company.id, "demo-generator"),
  })).filter((row) => row.burn.created > 0 || row.burn.resolved > 0 || row.burn.backlog > 0)
    .sort((left, right) => right.burn.net - left.burn.net || left.label.localeCompare(right.label));
  return (
    <>
      <DashboardHeader eyebrow="CREATION VS RESOLUTION" title="Risk burn-down" detail="Track whether teams are resolving visible conditions faster than new ones are being created. A ratio below 1 means backlog is growing." />
      {!eligiblePopulation.length ? <><EmptyState title="Burn-down population unavailable" detail="No Issue, RFI, Submittal, Clash Group, or Form matches the current scope. Counts and ratios are not shown as zero." /><p className="method-note"><b>Definition:</b> burn-down excludes Reviews, schedule activities, and change orders.</p></> : historyRange.coveragePartial ? <>
      <EmptyState title="Full-period burn unavailable" detail={`The selected ${historyRange.label.toLowerCase()} window starts ${formatDate(historyRange.startDate)}, before retained history begins ${formatDate(data.coverageStart)}. Selected-period counts, ratios, weekly flow, and comparisons are withheld rather than treating uncovered days as zero.`} />
      <section className="burn-breakdown-grid">
        <Panel><PanelHead eyebrow="MONTHLY FLOW · 30 DAYS" title="Current rolling-month burn rate" chip={<SourceChip label="Synthetic" />} /><div className="burn-breakdown-hero"><b>{monthlyBurn.burnRatio === null ? "—" : `${monthlyBurn.burnRatio.toFixed(2)}×`}</b><span>{monthlyBurn.created} created · {monthlyBurn.resolved} resolved · net {monthlyBurn.net > 0 ? "+" : ""}{monthlyBurn.net}</span><small>{monthlyBurn.burnRatio === null ? "No created records; ratio undefined" : "resolved / created"}</small></div></Panel>
      </section>
      <p className="method-note"><b>Coverage rule:</b> the independent rolling 30-day panel is fully inside retained history. The requested [{historyRange.startDate}, {historyRange.endDate} + 1 day) UTC burn metric is unavailable because its complete source window is not retained.</p>
      </> : <>
      <section className="burn-summary">
        <article><span>Created · {historyRange.label}</span><b>{burn.created}</b><small>visible records</small><SourceChip label="Synthetic" /></article>
        <article><span>Resolved · {historyRange.label}</span><b>{burn.resolved}</b><small>visible records closed</small><SourceChip label="Synthetic" /></article>
        <article><span>Net backlog</span><b className={burn.net === 0 ? "metric-neutral" : burn.net > 0 ? "metric-up" : "metric-good"}>{burn.net > 0 ? "+" : ""}{burn.net}</b><small>records this period</small><SourceChip label="Synthetic" /></article>
        <article><span>Burn ratio</span><b className={burn.burnRatio === null ? "metric-neutral" : burn.burnRatio >= 1 ? "metric-good" : "metric-up"}>{burn.burnRatio === null ? "—" : `${burn.burnRatio.toFixed(2)}×`}</b><small>{burn.burnRatio === null ? "no new items; ratio undefined" : "resolved / created"}</small><SourceChip label="Synthetic" /></article>
      </section>
      {growthRecommendation ? <div className="checklist-suggestion"><strong>Suggested action · advisory</strong><p><b>{growthRecommendation.title}.</b> {growthRecommendation.detail}</p><small>Deterministic rule · {growthRecommendation.ruleId} · {growthRecommendation.citedEvidence.length} cited source record{growthRecommendation.citedEvidence.length === 1 ? "" : "s"}. The recommendation prioritizes review and does not modify Autodesk records.</small><span>{growthRecommendation.citedEvidence.slice(0, 8).map((evidence) => <button key={recordIdentityKey(evidence)} onClick={() => onRecord(evidence)}>{evidence.label ?? evidence.id}</button>)}</span></div> : null}
      <section className="burn-layout">
        <Panel><PanelHead eyebrow={`WEEKLY FLOW · ${rangeDays} DAYS`} title="New records vs resolved records" chip={<SourceChip label="Synthetic" />} /><div className="burn-chart"><div className="burn-chart__plot" role="group" aria-label={`Weekly risk flow over ${rangeDays} days`}>{history.map((week) => <div className="burn-group" key={week.week} role="img" aria-label={`${week.week}: ${week.created} created and ${week.resolved} resolved`}><span aria-hidden="true" className="burn-bar burn-bar--created" style={{ height: `${(week.created / maximum) * 100}%` }}><i>{week.created}</i></span><span aria-hidden="true" className="burn-bar burn-bar--resolved" style={{ height: `${(week.resolved / maximum) * 100}%` }}><i>{week.resolved}</i></span><small>{week.week}</small></div>)}</div><div className="chart-legend"><span><i className="legend-square legend-square--created" />Created</span><span><i className="legend-square legend-square--resolved" />Resolved</span></div></div></Panel>
        <Panel><PanelHead eyebrow="PROJECT COMPARISON" title="Where backlog is growing" /><div className="burn-project-list">{projectRows.map(({ project, burn: projectBurn }) => <div key={project.project.id}><span className="project-code">{project.code}</span><span><strong>{project.project.name}</strong><small>{projectBurn.created} created · {projectBurn.resolved} resolved · net {projectBurn.net > 0 ? "+" : ""}{projectBurn.net}</small></span><b className={projectBurn.burnRatio === null ? "metric-neutral" : projectBurn.burnRatio >= 1 ? "metric-good" : "metric-up"}>{projectBurn.burnRatio === null ? "—" : `${projectBurn.burnRatio.toFixed(2)}×`}</b></div>)}</div></Panel>
      </section>
      <section className="burn-breakdown-grid">
        <Panel><PanelHead eyebrow="MONTHLY FLOW · 30 DAYS" title="Current rolling-month burn rate" chip={<SourceChip label="Synthetic" />} /><div className="burn-breakdown-hero"><b>{monthlyBurn.burnRatio === null ? "—" : `${monthlyBurn.burnRatio.toFixed(2)}×`}</b><span>{monthlyBurn.created} created · {monthlyBurn.resolved} resolved · net {monthlyBurn.net > 0 ? "+" : ""}{monthlyBurn.net}</span><small>{monthlyBurn.burnRatio === null ? "No created records; ratio undefined" : "resolved / created"}</small></div></Panel>
        <Panel><PanelHead eyebrow="DOMAIN BREAKDOWN" title={`Burn rate by risk domain · ${rangeDays} days`} /><div className="burn-project-list">{domainRows.map((row) => <div key={row.label}><span><strong>{row.label}</strong><small>{row.burn.created} created · {row.burn.resolved} resolved · net {row.burn.net > 0 ? "+" : ""}{row.burn.net}</small></span><b>{row.burn.burnRatio === null ? "—" : `${row.burn.burnRatio.toFixed(2)}×`}</b></div>)}</div></Panel>
        <Panel><PanelHead eyebrow="COMPANY BREAKDOWN" title={`Burn rate by attributed company · ${rangeDays} days`} /><div className="burn-project-list">{companyRows.length ? companyRows.slice(0, 8).map((row) => <div key={row.label}><span><strong>{row.label}</strong><small>{row.burn.created} created · {row.burn.resolved} resolved · net {row.burn.net > 0 ? "+" : ""}{row.burn.net}</small></span><b>{row.burn.burnRatio === null ? "—" : `${row.burn.burnRatio.toFixed(2)}×`}</b></div>) : <p className="empty-copy">No attributable company burn population is available in this scope.</p>}</div></Panel>
      </section>
      <p className="method-note"><b>Definition:</b> burn ratio = resolved / created within the selected {historyRange.label.toLowerCase()} period, using [{historyRange.startDate}, {historyRange.endDate} + 1 day) UTC boundaries. The population is Issues, RFIs, Submittals, Clash Groups, and Forms; Reviews, schedule activities, and change orders are excluded. Submittals resolve at response, Forms at latest submission, and draft/void records never count as resolved. When nothing was created, the ratio is undefined.</p>
      </>}
    </>
  );
}

function CompaniesView({ data, projects, records, companyCiqSignals, companySignalsSuppressed, selectedDomain, onRecord }: { data: DemoDataset; projects: readonly ProjectRiskSummary[]; records: readonly RiskRecord[]; companyCiqSignals: DemoDataset["companyCiqSignals"]; companySignalsSuppressed: boolean; selectedDomain: RiskDomain | null; onRecord: (identity: RecordIdentity) => void }) {
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const visibleProjectIds = new Set(projects.map((project) => project.project.id));
  const projectNames = new Map(projects.map((project) => [project.project.id, project.project.name]));
  const showQuality = !selectedDomain || selectedDomain === "quality" || selectedDomain === "subcontractor";
  const showSafety = !selectedDomain || selectedDomain === "safety" || selectedDomain === "subcontractor";
  const rows = data.companies.map((company) => {
    const companyRecords = records.filter((record) => record.companyId === company.id);
    const openRecords = companyRecords.filter((record) => record.open);
    const highRecords = openRecords.filter((record) => isConstructionIqRiskApplicable(record) && (record.constructionIqRisk === "high" || record.constructionIqRisk === "critical"));
    const direct = companyRecords.filter((record) => record.companyAttribution === "direct").length;
    const inferred = companyRecords.filter((record) => record.companyAttribution === "via-assignee-membership" || record.companyAttribution === "via-owner-membership").length;
    const signals = companyCiqSignals
      .filter((signal) => signal.companyId === company.id && visibleProjectIds.has(signal.projectId))
      .filter((signal) => (showQuality && signal.quality) || (showSafety && signal.safety) || (showQuality && showSafety && signal.notApplicable))
      .sort((left, right) => right.snapshotDate.localeCompare(left.snapshotDate));
    const projectCount = new Set([...companyRecords.map((record) => record.projectId), ...signals.map((signal) => signal.projectId)]).size;
    const signalAttention = signals.filter((signal) =>
      signal.quality && ["high", "medium"].includes(signal.quality.dailyRisk.toLowerCase())
    ).length;
    return {
      company,
      records: companyRecords,
      openRecords,
      highRecords,
      open: openRecords.length,
      high: highRecords.length,
      projectCount,
      direct,
      inferred,
      signals,
      signalAttention,
    };
  }).filter((row) => row.records.length > 0 || row.signals.length > 0).sort((a, b) =>
    b.high - a.high || b.signalAttention - a.signalAttention || b.open - a.open || a.company.name.localeCompare(b.company.name)
  );
  const selected = rows.find((row) => row.company.id === selectedCompanyId) ?? rows[0] ?? null;
  const selectedHighIssues = selected?.highRecords.filter((record) => record.kind === "issue") ?? [];
  const selectedAges = selectedHighIssues.map((record) => Math.max(0, Math.floor((new Date(data.asOf).getTime() - new Date(record.createdAt).getTime()) / 86_400_000)));
  const averageAge = selectedAges.length ? Math.round(selectedAges.reduce((sum, age) => sum + age, 0) / selectedAges.length) : null;
  const maximumAge = selectedAges.length ? Math.max(...selectedAges) : null;
  const selectedLocations = uniqueOptions((selected?.highRecords ?? []).map((record) => record.locationPath));
  const selectedForms = (selected?.records ?? []).filter((record) => record.kind === "form");
  const selectedFormExceptions = selectedForms.filter((record) => record.raw?.application_defined_exception === true).length;
  const selectedRecurrence = selected ? [
    ...recurrenceGroups(selected.records, "root-cause", data.asOf, 180, "demo-generator"),
    ...recurrenceGroups(selected.records, "iq-root-cause", data.asOf, 180, "demo-generator"),
  ] : [];
  const crossProjectPatterns = selectedRecurrence.filter((group) => group.projectsAffected.length > 1);
  const factorCounts = new Map<string, number>();
  for (const record of selected?.highRecords ?? []) {
    if (record.rootCause) {
      const factor = `Recorded · ${record.rootCause}`;
      factorCounts.set(factor, (factorCounts.get(factor) ?? 0) + 1);
    }
    if (record.iqRootCause) {
      const factor = `CIQ predicted · ${record.iqRootCause}`;
      factorCounts.set(factor, (factorCounts.get(factor) ?? 0) + 1);
    }
  }
  const contributingFactors = [...factorCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 4);
  const selectedProjectIds = selected ? [...new Set([...selected.records.map((record) => record.projectId), ...selected.signals.map((signal) => signal.projectId)])] : [];
  const waterRecords = records.filter((record) => record.rootCause?.toLowerCase() === "water intrusion");
  const waterProjects = new Set(waterRecords.map((record) => record.projectId)).size;
  const waterLocations = new Set(waterRecords.map((record) => record.locationId).filter(Boolean)).size;
  const direct = records.filter((record) => record.companyAttribution === "direct").length;
  const inferred = records.filter((record) => record.companyAttribution === "via-assignee-membership" || record.companyAttribution === "via-owner-membership").length;
  const unattributed = records.filter((record) => record.companyAttribution === "unattributed").length;

  return (
    <>
      <DashboardHeader eyebrow="CONTEXTUAL COMPANY SIGNALS" title="Company risk patterns" detail="Synthetic Autodesk-shaped daily signals remain project-relative; contextual counts order review without creating a normalized company grade." />
      <section className="company-callout"><span aria-hidden="true">i</span><p><b>{companySignalsSuppressed ? "Aggregate CIQ signals suppressed." : "Context matters."}</b> {companySignalsSuppressed ? "One or more active record-level filters cannot be applied truthfully to company-day Construction IQ rows. Company rows now use matching record evidence only; clear those filters to restore aggregate quality and safety signals." : "These quality and safety values simulate sparse Construction IQ change-log fields. Carried values show their synthetic observation date; raw numeric indicators are not converted into a score. Assignment-based attribution remains inferred."}</p></section>
      <Panel>
        <PanelHead eyebrow="CROSS-PROJECT VIEW" title={rows.length + " companies in scope"} chip={<SourceChip label="Synthetic" />} action={<span className="coverage-pill">Ordered by high/open context · not a grade</span>} />
        {rows.length ? <div className="company-table">
          <div className="company-table__head"><span>Company / category / trade</span><span>Projects</span><span>Open risk</span><span>High risk</span><span>Attribution</span><span>Synthetic CIQ-shaped / evidence</span></div>
          {rows.map((row) => (
            <button key={row.company.id} aria-pressed={selected?.company.id === row.company.id} aria-label={`${row.company.name}, category ${row.company.category ?? "not recorded"}, trade ${row.company.trade ?? "not recorded"}: ${row.projectCount} projects, ${row.open} open risk records, ${row.high} high-risk records, ${row.direct} direct and ${row.inferred} inferred attributions. Open contextual detail.`} title={`Open contextual detail for ${row.company.name}`} onClick={() => setSelectedCompanyId(row.company.id)}>
              <span className="company-name"><i>{row.company.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</i><span><strong>{row.company.name}</strong><small>{row.company.category ?? "No category recorded"}</small><small>{row.company.trade ?? "No trade recorded"}</small></span></span>
              <b><span className="sr-only">Projects: </span>{row.projectCount}</b><b><span className="sr-only">Open risk: </span>{row.open}</b><b><span className="sr-only">High risk: </span>{row.high}</b>
              <span><small>{row.direct} direct</small><small>{row.inferred} inferred</small><small>{row.records.length - row.direct - row.inferred} unattributed</small></span>
              <span className="company-ciq-signals">
                {row.signals.map((signal) => <span className="company-ciq-project" key={signal.projectId}>
                  <b>{projectNames.get(signal.projectId) ?? signal.projectId}</b>
                  {showQuality ? signal.quality ? <span><span><SeverityBadge severity={severityFromConstructionIq(signal.quality.dailyRisk)} compact /><SourceChip provenance={signal.quality.provenance} /></span><strong>Quality {signal.quality.dailyRisk}</strong><small>Observed {formatDate(signal.quality.observedAt)}{signal.quality.forwardFilled ? " · carried forward" : ""} · raw indicator {signal.quality.dailyIndicator ?? "—"}</small></span> : <span><strong>Quality N/A</strong><small>No company quality row</small></span> : null}
                  {showSafety ? signal.safety ? <span><span><SourceChip provenance={signal.safety.provenance} /></span><strong>Safety raw {signal.safety.dailyRisk}</strong><small>Observed {formatDate(signal.safety.observedAt)}{signal.safety.forwardFilled ? " · carried forward" : ""} · scale undocumented</small></span> : <span><strong>Safety N/A</strong><small>No company safety row</small></span> : null}
                </span>)}
                {!row.signals.length ? <span><strong>Construction IQ N/A</strong><small>{companySignalsSuppressed ? "Suppressed: active record filters are incompatible with aggregate signal rows" : "No company change-log row in this scope"}</small></span> : null}
                <small>{row.records.length} contextual evidence row{row.records.length === 1 ? "" : "s"} · not a score</small>
              </span>
            </button>
          ))}
        </div> : <EmptyState title="No company evidence in this scope" detail="No contextual company records or synthetic company CIQ-shaped signals match the active filters." />}
      </Panel>
      {selected ? <Panel className="company-detail-panel">
        <PanelHead eyebrow="COMPANY DETAIL" title={selected.company.name} chip={<SourceChip label="Synthetic" />} action={<span className="coverage-pill">Context only · no company grade</span>} />
        <div className="company-detail-summary">
          <article><span>Autodesk company category</span><b>{selected.company.category ?? "—"}</b><small>{selected.company.trade ?? "No separate trade recorded"}</small></article>
          <article><span>Projects involved</span><b>{selectedProjectIds.length}</b><small>{selectedProjectIds.map((projectId) => projectNames.get(projectId) ?? projectId).join(" · ") || "No project context"}</small></article>
          <article><span>Open high-risk issues</span><b>{selectedHighIssues.length}</b><small>effective source-shaped High/Critical issue classification</small></article>
          <article><span>Issue aging</span><b>{averageAge === null ? "—" : `${averageAge}d`}</b><small>{maximumAge === null ? "No open high-risk issues" : `mean · oldest ${maximumAge} days`}</small></article>
          <article><span>Locations</span><b>{selectedLocations.length}</b><small>with open high-risk contextual records</small></article>
        </div>
        <div className="company-detail-grid">
          <section>
            <h3>Quality and safety indicators</h3>
            {selected.signals.length ? <div className="company-detail-signals">{selected.signals.map((signal) => { const provenance = signal.quality?.provenance ?? signal.safety?.provenance; return <article key={`${signal.projectId}:${signal.snapshotDate}`}><strong>{projectNames.get(signal.projectId) ?? signal.projectId}</strong>{showQuality ? <span>Quality: {signal.quality ? `${signal.quality.dailyRisk} · observed ${formatDate(signal.quality.observedAt)}${signal.quality.forwardFilled ? " · carried" : ""}` : "N/A"}</span> : null}{showSafety ? <span>Safety: {signal.safety ? `raw ${signal.safety.dailyRisk} · observed ${formatDate(signal.safety.observedAt)}${signal.safety.forwardFilled ? " · carried" : ""}` : "N/A"}</span> : null}{provenance ? <SourceChip provenance={provenance} /> : <SourceChip label="Synthetic" syntheticKind="Autodesk-shaped field" />}</article>; })}</div> : <p className="empty-copy">{companySignalsSuppressed ? "Aggregate company Construction IQ rows are suppressed because the active record filters cannot be applied to them." : "No synthetic company quality or safety change-log row is available in this scope."}</p>}
          </section>
          <section>
            <h3>Trend coverage</h3>
            <p className="company-detail-note"><b>Historical trend unavailable.</b> The demo retains one effective company snapshot per project, so cross-project values are not spliced into a false time series. A live trend requires repeated snapshots for the same company-project pair.</p>
          </section>
          <section>
            <h3>Checklist context</h3>
            <p className="company-detail-stat"><b>{selectedForms.length}</b> submitted form records · <b>{selectedFormExceptions}</b> configured exceptions</p>
            <p className="company-detail-note">This is evidence coverage, not a conformance rate; response maps are application-configured.</p>
          </section>
          <section>
            <h3>Contributing factors</h3>
            {contributingFactors.length ? <ul>{contributingFactors.map(([factor, count]) => <li key={factor}><span>{factor}</span><b>{count}</b></li>)}</ul> : <p className="empty-copy">Neither a recorded issue root cause nor a CIQ-predicted root cause is present on an open high-risk contextual record.</p>}
          </section>
          <section>
            <h3>Recurrence and cross-project patterns</h3>
            {selectedRecurrence.length ? <ul>{selectedRecurrence.slice(0, 4).map((group) => <li key={group.id}><span>{group.label}<small>{group.dimension === "root-cause" ? "Recorded issue root cause" : "CIQ predicted root cause"} · {group.projectsAffected.length} project{group.projectsAffected.length === 1 ? "" : "s"} · {group.occurrences} occurrences</small></span><b>{group.occurrences}</b></li>)}</ul> : <p className="empty-copy">No repeated recorded or CIQ-predicted root-cause signature appears within 180 days.</p>}
            <p className="company-detail-note">{crossProjectPatterns.length ? `${crossProjectPatterns.length} configured signature${crossProjectPatterns.length === 1 ? "" : "s"} recur across multiple projects.` : "No configured signature recurs across multiple projects in this scope."} Association does not establish company performance or cause.</p>
          </section>
          <section>
            <h3>Locations</h3>
            {selectedLocations.length ? <ul>{selectedLocations.slice(0, 5).map((location) => <li key={location}><span>{location}</span></li>)}</ul> : <p className="empty-copy">No open high-risk contextual record has a usable location.</p>}
          </section>
        </div>
        <div className="company-evidence-list">
          <h3>Contextual evidence</h3>
          {selected.records.length ? selected.records.slice().sort((left, right) => Number(right.open) - Number(left.open) || right.createdAt.localeCompare(left.createdAt)).slice(0, 8).map((record) => <button key={recordIdentityKey(record)} onClick={() => onRecord(record)}>{isConstructionIqRiskApplicable(record) ? <SeverityBadge severity={record.constructionIqRisk} compact noneLabel="Unclassified" /> : <span className="severity severity--none">CIQ N/A</span>}<span><strong>{record.title}</strong><small>{projectNames.get(record.projectId) ?? record.projectId} · {cap(record.domain)} · {record.open ? "Open" : "Closed"}</small></span><span className="row-arrow" aria-hidden="true">→</span></button>) : <EmptyState title="CIQ-shaped signal only" detail="This company has synthetic source-shaped signal evidence but no contextual risk record in the active scope." />}
        </div>
      </Panel> : <Panel className="company-detail-panel"><EmptyState title="No company detail available" detail="Broaden the scope to restore company evidence." /></Panel>}
      <section className="company-insights">
        <article><p className="eyebrow">CROSS-PROJECT RECURRENCE</p><strong>{waterProjects > 1 ? "Water Intrusion appears across " + waterProjects + " projects" : "No cross-project Water Intrusion recurrence in view"}</strong><p>{waterRecords.length} eligible records share the configured recorded-cause key (dictionary v{RECORDED_ROOT_CAUSE_NORMALIZATION_VERSION}) across {waterLocations} locations. Review record and attribution evidence; no company-performance inference is made.</p><SourceChip label="Synthetic" /></article>
        <article><p className="eyebrow">ATTRIBUTION COVERAGE</p><strong>{direct} direct · {inferred} inferred · {unattributed} unattributed</strong><p>Company counts are only as complete as assignment and project-membership data allow.</p><SourceChip label="Synthetic" /></article>
      </section>
    </>
  );
}

function RelationshipsView({ relationships: allEdges, records, coverage, onRecord }: { relationships: readonly RiskRelationship[]; records: readonly RiskRecord[]; coverage: { excludedDanglingCount: number; excludedByScopeCount: number }; onRecord: (identity: RecordIdentity) => void }) {
  const canonicalEdges = selectCanonicalRelationships(allEdges);
  const edges = canonicalEdges.filter((edge) => edge.confidence !== "none");
  const noRelationshipCandidates = canonicalEdges.length - edges.length;
  const counts = {
    issueRfi: edges.filter((edge) => [edge.from.kind, edge.to.kind].includes("issue") && [edge.from.kind, edge.to.kind].includes("rfi")).length,
    cost: edges.filter((edge) => [edge.from.kind, edge.to.kind].includes("change-order")).length,
    schedule: edges.filter((edge) => [edge.from.kind, edge.to.kind].includes("schedule-activity")).length,
  };
  return <>
    <DashboardHeader eyebrow="CONNECTED EVIDENCE" title="Risk relationship graph" detail="Explore synthetic record pairs that mirror source-system links or application associations. Endpoint placement is visual only; direction, time order, and causality are never inferred from an edge." />
    <section className="edge-counts">
      <article><b>{counts.issueRfi}</b><span>Issue ↔ RFI</span><SourceChip label="Synthetic" /></article>
      <article><b>{counts.cost}</b><span>Record ↔ cost entity</span><SourceChip label="Synthetic" /></article>
      <article><b>{counts.schedule}</b><span>Record ↔ activity</span><SourceChip label="Synthetic" /></article>
      <article><b>{edges.filter((edge) => edge.serviceOwned).length}</b><span>System-created edges</span><SourceChip label="Synthetic" /></article>
    </section>
    <RelationshipConversionFunnel relationships={allEdges} records={records} onContributor={onRecord} />
    {coverage.excludedByScopeCount || coverage.excludedDanglingCount ? <p className="method-note"><b>Relationship coverage:</b> {coverage.excludedByScopeCount} authorized canonical edge{coverage.excludedByScopeCount === 1 ? " is" : "s are"} outside the active filters. {coverage.excludedDanglingCount} edge{coverage.excludedDanglingCount === 1 ? " was" : "s were"} withheld because both endpoint records were not present in the authorized source population; hidden endpoint details are never rendered.</p> : null}
    {noRelationshipCandidates ? <p className="method-note"><b>Excluded candidates:</b> {noRelationshipCandidates} pair{noRelationshipCandidates === 1 ? " is" : "s are"} marked confidence “none.” They are not established relationships and are excluded from the headline counts, graph, and evidence table.</p> : null}
    <Panel className="relationship-panel">
      <PanelHead eyebrow="UNDIRECTED ASSOCIATIONS" title="Linked record pairs" chip={<SourceChip label="Synthetic" />} />
      {edges.length ? <>
        <div className="relationship-graph" role="group" aria-label="Undirected pairs of issue, RFI, cost, and schedule records">
          <div className="graph-column"><span>ENDPOINT A</span>{edges.slice(0, 4).map((edge) => <button key={`from-${edge.projectId}-${edge.id}`} onClick={() => onRecord(edge.from)}><i>{edge.from.kind.slice(0, 1).toUpperCase()}</i><strong>{edge.from.label}</strong><small>{edge.from.kind}</small></button>)}</div>
          <div className="graph-edges" aria-hidden="true">{edges.slice(0, 4).map((edge, index) => <span key={`${edge.projectId}-${edge.id}`} style={{ transform: `rotate(${index % 2 ? -5 : 5}deg)` }}><i>{edge.confidence}</i></span>)}</div>
          <div className="graph-column"><span>ENDPOINT B</span>{edges.slice(0, 4).map((edge) => <button key={`to-${edge.projectId}-${edge.id}`} onClick={() => onRecord(edge.to)}><i>{edge.to.kind.slice(0, 1).toUpperCase()}</i><strong>{edge.to.label}</strong><small>{edge.to.kind}</small></button>)}</div>
        </div>
        <p className="graph-caption">Each row is an undirected pair. The evidence method and confidence below explain why it is shown; column position does not imply sequence, direction, ownership, or causality.</p>
      </> : <EmptyState title="No relationship evidence in this scope" detail="No supported or inferred edge includes a record matching the current filters. Absence of an edge does not establish that records are unrelated." />}
    </Panel>
    <Panel className="relationship-table-panel">
      <PanelHead eyebrow="EDGE EVIDENCE" title="Methods and confidence" />
      {edges.length ? <div className="relationship-table">{edges.map((edge) => <div key={`${edge.projectId}-${edge.id}`}><span className={`confidence confidence--${edge.confidence}`}>{cap(edge.confidence)}</span><span><strong>{edge.from.label} ↔ {edge.to.label}</strong><small>{edge.evidence}</small></span><span><b>{edge.method.replaceAll("-", " ")}</b><small>{edge.serviceOwned ? "System-created edge" : "User-created or application-associated edge"}</small></span></div>)}</div> : <EmptyState title="No edge rows" detail="Change or clear filters to inspect relationship evidence." />}
    </Panel>
  </>;
}

function ProvenanceView({ data, scopedLineage, requestedMetricId, scopeBounded }: { data: DemoDataset; scopedLineage: readonly DemoDataset["lineage"][number][]; requestedMetricId: string | null; scopeBounded: boolean }) {
  const lineage = useMemo(() => scopeBounded ? [...scopedLineage] : [...scopedLineage, ...data.lineage], [data.lineage, scopeBounded, scopedLineage]);
  const [category, setCategory] = useState<"all" | DemoDataset["lineage"][number]["category"]>("all");
  const [selectedId, setSelectedId] = useState(requestedMetricId ?? scopedLineage[0]?.id ?? data.lineage[0]?.id ?? "");
  const visible = category === "all" ? lineage : lineage.filter((entry) => entry.category === category);
  const selected = resolveVisibleLineageSelection(visible, selectedId);
  const selectedDefinition = selected ? metricDefinitionFor(selected.provenance.definitionId) : null;
  const categories = ["all", "portfolio", "project", "domain", "attention", "analytics", "form"] as const;

  return (
    <>
      <DashboardHeader eyebrow="TRUST AND AUDITABILITY" title="Data provenance" detail={scopeBounded ? "Trace only the current authorized filter scope; unrelated baseline evidence stays hidden." : "Trace current calculations and immutable baseline metrics to source, definition, calculation time, contributors, and ingestion state."} />
      <section className="provenance-status">
        <article><span className="status-orb status-orb--good" aria-hidden="true">✓</span><span><small>LAST INGESTION</small><strong>Complete</strong><em>{formatDate(data.ingestion.completedAt)}</em></span></article>
        <article><span className="status-orb" aria-hidden="true">◇</span><span><small>DATA MODE</small><strong>Synthetic demo</strong><em>No Autodesk customer records</em></span></article>
        <article><span className="status-orb" aria-hidden="true">↻</span><span><small>LINEAGE ENTRIES</small><strong>{lineage.length}</strong><em>{scopedLineage.length} current-scope · {data.lineage.length} baseline</em></span></article>
        <article><span className="status-orb status-orb--warn" aria-hidden="true">!</span><span><small>WARNINGS</small><strong>{data.ingestion.warnings.length}</strong><em>Coverage and mapping notes</em></span></article>
      </section>

      <div className="lineage-filter" role="group" aria-label="Filter metric lineage">
        {categories.map((item) => <button key={item} className={category === item ? "active" : ""} aria-pressed={category === item} onClick={() => setCategory(item)}>{cap(item)}</button>)}
      </div>

      <section className="provenance-grid">
        <Panel>
          <PanelHead eyebrow="METRIC LINEAGE" title={visible.length + " registered metrics"} />
          {visible.length ? <div className="lineage-list">{visible.map((entry) => (
            <article key={entry.id} className={selected?.id === entry.id ? "lineage-row lineage-row--selected" : "lineage-row"}>
              <SourceChip provenance={entry.provenance} />
              <span><strong>{entry.label}</strong><small>{entry.provenance.definitionId} · {entry.category}</small></span>
              <span><b>v{entry.provenance.definitionVersion}</b><small>{entry.evidence.length} contributor{entry.evidence.length === 1 ? "" : "s"}</small></span>
              <button aria-label={"Inspect " + entry.label} aria-pressed={selected?.id === entry.id} onClick={() => setSelectedId(entry.id)}>→</button>
            </article>
          ))}</div> : <EmptyState title="No lineage entries" detail="Choose another metric category." />}
        </Panel>

        <Panel>
          <PanelHead eyebrow="LINEAGE INSPECTOR" title={selected?.label ?? "Select a metric"} chip={selected ? <SourceChip provenance={selected.provenance} /> : null} />
          {selected ? <div className="lineage-detail">
            <dl className="job-details">
              <div><dt>Definition</dt><dd>{selected.provenance.definitionId}</dd></div>
              <div><dt>Version</dt><dd>{selected.provenance.definitionVersion}</dd></div>
              <div><dt>Catalog</dt><dd>{selectedDefinition?.catalogSection ?? "Unregistered"}</dd></div>
              <div><dt>Definition title</dt><dd>{selectedDefinition?.title ?? "Registry entry unavailable"}</dd></div>
              <div><dt>Value kind</dt><dd>{selected.provenance.valueKind}</dd></div>
              <div><dt>Source system</dt><dd>{selected.provenance.sourceSystem}</dd></div>
              <div><dt>Source dataset</dt><dd>{selected.provenance.sourceDataset}</dd></div>
              <div><dt>Extracted</dt><dd>{formatDate(selected.provenance.extractedAt)}</dd></div>
              <div><dt>Calculated</dt><dd>{formatDate(selected.provenance.calculatedAt)}</dd></div>
              <div><dt>Contributors</dt><dd>{selected.evidence.length}</dd></div>
            </dl>
            <h3>Result</h3>
            <pre className="lineage-json">{JSON.stringify(selected.value, null, 2)}</pre>
            <h3>Inputs</h3>
            <pre className="lineage-json">{JSON.stringify(selected.inputs, null, 2)}</pre>
            <h3>Complete contributor list</h3>
            {selected.evidence.length ? <div className="lineage-evidence">{selected.evidence.map((evidence) => <code key={recordIdentityKey(evidence)}>{evidence.id} · {evidence.kind} · {evidence.projectId}</code>)}</div> : <p className="empty-copy">No source record contributes to this value. This commonly indicates an unavailable or suppressed metric.</p>}
          </div> : <EmptyState title="No metric selected" detail="Choose a lineage row to inspect its calculation." />}
        </Panel>
      </section>

      <section className="provenance-grid">
        <Panel>
          <PanelHead eyebrow="INGESTION JOB" title={data.ingestion.id} chip={<span className="job-status">Complete</span>} />
          <dl className="job-details">
            <div><dt>Source</dt><dd>{data.ingestion.source}</dd></div><div><dt>Started</dt><dd>{formatDate(data.ingestion.startedAt)}</dd></div>
            <div><dt>Source extracted</dt><dd>{formatDate(data.ingestion.sourceExtractedAt)}</dd></div><div><dt>Rows processed</dt><dd>{data.ingestion.rowsProcessed}</dd></div>
            <div><dt>Failures</dt><dd>{data.ingestion.failures}</dd></div><div><dt>Status</dt><dd>{data.ingestion.status}</dd></div>
          </dl>
          <div className="warning-list">{data.ingestion.warnings.map((warning) => <p key={warning}><span aria-hidden="true">!</span>{warning}</p>)}</div>
        </Panel>
        <Panel>
          <PanelHead eyebrow="AUDIT GUARANTEE" title="Lineage behavior" />
          <div className="warning-list">
            <p><span aria-hidden="true">✓</span>Calculation traces retain every contributing record ID; display cards may show a shorter evidence preview.</p>
            <p><span aria-hidden="true">✓</span>Derived metrics remain labelled separately from Autodesk-provided fields.</p>
            <p><span aria-hidden="true">✓</span>Unavailable and low-sample values remain explicit; missing data is never coerced to zero risk.</p>
          </div>
        </Panel>
      </section>

      <Panel className="column-panel">
        <PanelHead eyebrow="SCHEMA COVERAGE" title="Column mapping report" chip={<SourceChip label="Synthetic" />} />
        <div className="column-table">
          <div className="column-table__head"><span>Dataset</span><span>Source column</span><span>Canonical destination</span><span>Non-null rows</span><span>Note</span></div>
          {data.columnReport.map((row) => <div key={row.table + "-" + row.column}><code>{row.table}</code><code>{row.column}</code><span>{row.mappedTo ?? <em>Unmapped</em>}</span><b>{row.nonNullRows}</b><p>{row.note}</p></div>)}
        </div>
      </Panel>
      <section className="disclosure-list" id="risk-disclosures"><h2>Mandatory method and data limits</h2>{RISK_DISCLOSURES.map((disclosure, index) => <article key={disclosure.id}><span>{String(index + 1).padStart(2, "0")}</span><p><strong>{disclosure.title}</strong><br />{disclosure.detail}<small>{disclosure.source}</small></p></article>)}</section>
    </>
  );
}

function SearchResults({ projects: scopedProjects, records: scopedRecords, query, onProject, onRecord }: { projects: readonly ProjectRiskSummary[]; records: readonly RiskRecord[]; query: string; onProject: (id: string) => void; onRecord: (identity: RecordIdentity) => void }) {
  const normalized = query.toLowerCase();
  const projects = scopedProjects.filter((project) => project.project.name.toLowerCase().includes(normalized) || project.code.toLowerCase().includes(normalized)).slice(0, 4);
  const records = scopedRecords.filter((record) => record.title.toLowerCase().includes(normalized) || record.displayId?.toLowerCase().includes(normalized)).slice(0, 6);
  return <div className="search-results" role="dialog" aria-label="Search results"><p className="eyebrow">SEARCH RESULTS</p>{projects.map((project) => <button key={project.project.id} onClick={() => onProject(project.project.id)}><span className="project-code">{project.code}</span><span><strong>{project.project.name}</strong><small>Project · {project.descriptor}</small></span><span>→</span></button>)}{records.map((record) => <button key={recordIdentityKey(record)} onClick={() => onRecord(record)}><span className="search-type">{record.kind.slice(0, 1).toUpperCase()}</span><span><strong>{record.title}</strong><small>{record.displayId} · {cap(record.domain)}</small></span><span>→</span></button>)}{!projects.length && !records.length ? <p>No project or record matched “{query}”.</p> : null}</div>;
}

function FilterPanel({ data, filters, historyRange, updateQuery, onClose }: { data: DemoDataset; filters: DashboardScopeFilters; historyRange: HistoryRange; updateQuery: (updates: QueryUpdate, mode?: "push" | "replace") => void; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("keydown", onEscape);
      previousFocus.current?.focus();
    };
  }, []);
  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>("button, a[href], input, select, [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("disabled"));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const select = (key: string) => (event: React.ChangeEvent<HTMLSelectElement>) => updateQuery({ [key]: event.target.value }, "replace");
  const selectRange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (value === "custom") {
      const startDate = historyRange.startDate < data.coverageStart ? data.coverageStart : historyRange.startDate;
      updateQuery({ range: "custom", rangeFrom: startDate, rangeTo: historyRange.endDate }, "replace");
    } else {
      updateQuery({ range: value, rangeFrom: null, rangeTo: null }, "replace");
    }
  };
  const projectTypes = uniqueOptions(data.projects.map((summary) => summary.project.type));
  const projectPhases = uniqueOptions(data.projects.map((summary) => summary.project.currentPhase));
  const businessUnits = data.businessUnits.filter((unit) => data.projects.some((summary) => summary.project.businessUnitId === unit.id));
  const trades = uniqueOptions(data.companies.map((company) => company.trade));
  const disciplines = [...new Map(data.records.flatMap((record) => {
    const key = disciplineIdentityKey(record);
    const label = disciplineIdentityLabel(record);
    return key && label ? [[key, label] as const] : [];
  })).entries()].sort((left, right) => left[1].localeCompare(right[1]));
  const locations = uniqueOptions(data.records.map((record) => record.locationPath));
  const rootCauses = uniqueOptions(data.records.map((record) => record.rootCause));
  const iqRootCauses = uniqueOptions(data.records.map((record) => record.iqRootCause));
  const statuses = uniqueOptions(data.records.map((record) => record.status));
  const reset = () => updateQuery({ hub: null, filterProject: null, businessUnit: null, projectType: null, projectPhase: null, domain: null, severity: null, momentum: null, company: null, trade: null, discipline: null, location: null, rootCause: null, iqRootCause: null, status: null, persistence: null, recurrence: null, costExposure: null, scheduleExposure: null, range: null, rangeFrom: null, rangeTo: null }, "replace");
  return <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="filter-panel" role="dialog" aria-modal="true" aria-labelledby="filters-title" tabIndex={-1} ref={panelRef} onKeyDown={onDialogKey}><div className="drawer-head"><div><p className="eyebrow">GLOBAL FILTER MODEL</p><h2 id="filters-title">Refine every view</h2></div><button onClick={onClose} aria-label="Close filters">×</button></div><p className="filter-intro">Filters live in the URL and persist through project and record drill-downs. Record-level filters retain only projects with matching evidence.</p><div className="filter-fields">
    <label><span>History range</span><select value={historyRange.key} onChange={selectRange}><option value="1d">Today / current snapshot</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option><option value="180d">Last 6 months</option><option value="365d">Last 12 months</option><option value="custom">Custom date range</option></select><small>Affects trends and burn-down. Current risk remains an as-of snapshot; coverage begins {formatDate(data.coverageStart)}.{historyRange.coveragePartial ? " The selected preset extends before retained history, so charts disclose partial coverage." : ""}</small></label>
    {historyRange.custom ? <><label><span>Custom start · inclusive</span><input type="date" min={data.coverageStart} max={historyRange.endDate} value={historyRange.startDate} onChange={(event) => updateQuery({ range: "custom", rangeFrom: event.target.value }, "replace")} /></label><label><span>Custom end · inclusive</span><input type="date" min={historyRange.startDate} max={data.asOf.slice(0, 10)} value={historyRange.endDate} onChange={(event) => updateQuery({ range: "custom", rangeTo: event.target.value }, "replace")} /><small>Calculations use strict UTC boundaries: start included, day after end excluded.</small></label></> : null}
    <label><span>Hub</span><select value={filters.hubId ?? "all"} onChange={select("hub")}><option value="all">All accessible hubs</option><option value={data.hub.id}>{data.hub.name}</option></select></label>
    <label><span>Project</span><select value={filters.projectId ?? "all"} onChange={select("filterProject")}><option value="all">All production projects</option>{data.projects.map((project) => <option key={project.project.id} value={project.project.id}>{project.project.name}</option>)}</select></label>
    <label><span>Business unit</span><select value={filters.businessUnitId ?? "all"} onChange={select("businessUnit")}><option value="all">All business units</option>{businessUnits.map((unit) => <option key={`${unit.hubId}:${unit.id}`} value={unit.id}>{unit.path}</option>)}</select></label>
    <label><span>Project type</span><select value={filters.projectType ?? "all"} onChange={select("projectType")}><option value="all">All project types</option>{projectTypes.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <label><span>Project current phase</span><select value={filters.projectPhase ?? "all"} onChange={select("projectPhase")}><option value="all">All phases</option>{projectPhases.map((value) => <option key={value} value={value}>{value}</option>)}</select><small>Uses the Autodesk Hub Admin currentPhase field; lifecycle status stays separate.</small></label>
    <label><span>Risk domain</span><select value={filters.domain ?? "all"} onChange={select("domain")}><option value="all">All domains</option>{["design", "rfi", "quality", "safety", "subcontractor", "submittal", "coordination", "cost", "schedule"].map((domain) => <option key={domain} value={domain}>{cap(domain)}</option>)}</select></label>
    <label><span>Construction IQ source risk</span><select value={filters.severity ?? "all"} onChange={select("severity")}><option value="all">Any applicable CIQ classification</option>{["high", "medium", "low", "unmapped"].map((severity) => <option key={severity} value={severity}>{cap(severity)}</option>)}<option value="none">Unclassified / no CIQ classification</option></select><small>Applies only to Issue and RFI source models; unsupported record kinds are excluded.</small></label>
    <label><span>Momentum</span><select value={filters.momentum ?? "all"} onChange={select("momentum")}><option value="all">Any direction</option>{["accelerating", "increasing", "stable", "improving"].map((direction) => <option key={direction} value={direction}>{cap(direction)}</option>)}</select></label>
    <label><span>Company</span><select value={filters.companyId ?? "all"} onChange={select("company")}><option value="all">All companies</option>{data.companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
    <label><span>Trade</span><select value={filters.trade ?? "all"} onChange={select("trade")}><option value="all">All trades</option><option value={UNATTRIBUTED_TRADE_FILTER}>No trade recorded</option>{trades.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <label><span>Discipline and source</span><select value={filters.discipline ?? "all"} onChange={select("discipline")}><option value="all">All discipline sources</option>{disciplines.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><small>Operational/project-configured and CIQ-predicted values are never merged.</small></label>
    <label><span>Location</span><select value={filters.location ?? "all"} onChange={select("location")}><option value="all">All locations</option>{locations.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <label><span>Recorded issue root cause</span><select value={filters.rootCause ?? "all"} onChange={select("rootCause")}><option value="all">All recorded causes</option>{rootCauses.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <label><span>Construction IQ predicted root cause</span><select value={filters.iqRootCause ?? "all"} onChange={select("iqRootCause")}><option value="all">All CIQ-predicted causes</option>{iqRootCauses.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <label><span>Record status</span><select value={filters.status ?? "all"} onChange={select("status")}><option value="all">All statuses</option>{statuses.map((value) => <option key={value} value={value}>{cap(value.replaceAll("_", " "))}</option>)}</select></label>
    <label><span>Persistence</span><select value={filters.persistence ?? "all"} onChange={select("persistence")}><option value="all">Persistent and non-persistent</option><option value="persistent">Persistent high risk (open &gt; 30 days)</option><option value="non-persistent">Non-persistent</option></select></label>
    <label><span>Recurrence</span><select value={filters.recurrence ?? "all"} onChange={select("recurrence")}><option value="all">Recurring and non-recurring</option><option value="recurring">Recurring signature</option><option value="non-recurring">Non-recurring</option></select></label>
    <label><span>Cost exposure classification</span><select value={filters.costExposure ?? "all"} onChange={select("costExposure")}><option value="all">Any cost classification</option><option value="confirmed">Confirmed category · RFI Yes or CIQ High</option><option value="potential">Potential category · RFI Unknown or CIQ Medium</option><option value="explicit-negative">Explicit negative/low · RFI No or CIQ Low</option><option value="unclassified">Field unavailable / not classified</option><option value="unmapped">Unmapped source value</option></select><small>Open Issue/RFI records only; counts never imply an issue-level monetary value.</small></label>
    <label><span>Schedule exposure evidence</span><select value={filters.scheduleExposure ?? "all"} onChange={select("scheduleExposure")}><option value="all">Any schedule evidence</option><option value="flagged">RFI schedule-impact field · Yes</option><option value="potential">RFI schedule-impact field · Unknown</option><option value="linked">Confirmed schedule-activity link</option><option value="explicit-negative">RFI schedule-impact field · No</option><option value="unavailable">RFI field unavailable / disabled</option><option value="unmapped">Unmapped source value</option></select><small>Open RFIs or linked risk records only. Links are undirected associations and do not establish causality.</small></label>
    <div className="toggle-label"><span>Project population</span><div className="toggle-row"><i /><span><b>Production projects only</b><small>Template, training, and demonstration projects excluded</small></span></div></div><div className="toggle-label"><span>Data provenance</span><div className="toggle-row"><i /><span><b>Autodesk + derived</b><small>Every value remains individually labelled</small></span></div></div></div><div className="filter-panel__foot"><button className="secondary-button" onClick={reset}>Reset filters</button><button className="filter-button" onClick={onClose}>Show results</button></div></div></div>;
}

function RecordDrawer({ data, projects, records, relationships, record, attention, returnFocus, onClose }: { data: DemoDataset; projects: readonly ProjectRiskSummary[]; records: readonly RiskRecord[]; relationships: readonly RiskRelationship[]; record: RiskRecord; attention?: AttentionItem & { rawScore: number }; returnFocus: HTMLElement | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(returnFocus);
  const project = projects.find((item) => item.project.id === record.projectId);
  const company = data.companies.find((item) => item.id === record.companyId);
  const related = relationships.filter((edge) => edge.confidence !== "none" && (sameRecordIdentity(edge.from, record) || sameRecordIdentity(edge.to, record)));
  const modelRisk = record.constructionIqModelRisk;
  const autodeskHref = normalizeAutodeskDeepLink(record.href);
  const recurrence = RECURRENCE_DIMENSIONS
    .flatMap((dimension) => recurrenceGroups(records, dimension, data.asOf, 180, "demo-generator"))
    .filter((group) => group.evidence.some((evidence) => sameRecordIdentity(evidence, record)));
  const ageThrough = record.open ? data.asOf : record.closedAt ?? record.respondedAt ?? record.updatedAt ?? data.asOf;
  const daysOpen = Math.max(0, Math.floor((new Date(ageThrough).getTime() - new Date(record.createdAt).getTime()) / 86_400_000));
  const scheduleEdges = related.filter((edge) => edge.from.kind === "schedule-activity" || edge.to.kind === "schedule-activity");
  const costEdges = related.filter((edge) => edge.from.kind === "change-order" || edge.to.kind === "change-order");
  const costImpactLabel = record.kind === "rfi"
    ? `${triStateLabel(record.costImpact)} · Autodesk RFI tri-state field`
    : record.kind === "issue"
      ? record.iqCostImpact === "none" ? "Not classified by Construction IQ" : record.iqCostImpact === "unmapped" ? "Unmapped Construction IQ source value" : `${cap(record.iqCostImpact)} · categorical only`
      : "Not applicable to this record type";
  const scheduleImpactLabel = record.kind === "rfi" ? `${triStateLabel(record.scheduleImpact)} · Autodesk RFI tri-state field` : "Not applicable to this record type";
  useEffect(() => {
    if (!previousFocus.current) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);
  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button, a[href], input, select, [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("disabled"));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="modal-layer modal-layer--drawer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="record-drawer" role="dialog" aria-modal="true" aria-labelledby="record-title" ref={dialogRef} tabIndex={-1} onKeyDown={onDialogKey}><div className="drawer-head"><div><p className="eyebrow">SOURCE RECORD EVIDENCE</p><h2 id="record-title">{record.displayId ?? record.id}</h2></div><button autoFocus onClick={onClose} aria-label="Close record detail">×</button></div><div className="record-summary"><div>{isConstructionIqRiskApplicable(record) ? <SeverityBadge severity={record.constructionIqRisk} noneLabel="Source unclassified" /> : <span className="severity severity--none">CIQ risk · N/A</span>}{attention ? <PriorityBadge priority={attention.priority} /> : null}<SourceChip label="Synthetic" syntheticKind="Autodesk-shaped field" /><span className="record-kind">{cap(record.kind)}</span></div><h3>{record.title}</h3><p>{project?.project.name} · {cap(record.domain)} · {record.status.replaceAll("_", " ")}</p>{attention ? <div className="attention-meter"><span><b>{attention.score}</b><small>Attention priority score{attention.rawScore > 100 ? " · displayed cap" : ""}{attention.rawScore > 100 ? <em>Ranking key {attention.rawScore}; queue ordering uses the unclamped factor sum.</em> : null}</small></span><ProgressBar value={attention.score} tone={attention.score >= 75 ? "red" : "orange"} label="Attention priority score" /></div> : null}</div><div className="drawer-scroll"><section className="drawer-section"><div className="drawer-section__head"><h4>Why this is prioritized</h4><SourceChip label="Synthetic" /></div>{attention ? <div className="drawer-reasons">{attention.reasons.map((reason) => <article key={reason.code}><b>{reason.points > 0 ? "+" : ""}{reason.points}</b><span><strong>{reason.label}</strong><p>{reason.detail}</p><code>{reason.code}</code></span></article>)}</div> : <p className="empty-copy">This source record is evidence in the current view but does not enter the ranked attention queue.</p>}</section><section className="drawer-section"><div className="drawer-section__head"><h4>Canonical record</h4></div><dl className="record-fields"><div><dt>Project</dt><dd>{project?.project.name ?? "Unknown"}</dd></div><div><dt>Type</dt><dd>{record.typeName ?? "Not recorded"}</dd></div><div><dt>Subtype</dt><dd>{record.subtypeName ?? "Not recorded"}</dd></div><div><dt>Status</dt><dd>{record.status}</dd></div><div><dt>Company</dt><dd>{company?.name ?? "No company attribution"}<small>{record.companyAttribution.replaceAll("-", " ")}</small></dd></div><div><dt>Assignee</dt><dd>{record.assigneeName ?? (record.assigneeId ? "Named assignee · label unavailable" : "Unassigned")}</dd></div><div><dt>Owner</dt><dd>{record.ownerName ?? (record.ownerId ? "Named owner · label unavailable" : "Not recorded")}</dd></div><div><dt>Created</dt><dd>{formatDate(record.createdAt)}</dd></div><div><dt>{record.kind === "submittal" ? "Due · approximate" : "Due"}</dt><dd>{record.dueDate ? formatDate(record.dueDate) : "No due date"}{record.kind === "submittal" ? <small>State-aware field mapping pending validation</small> : null}</dd></div><div><dt>Days open</dt><dd>{daysOpen}<small>{record.open ? "through the dashboard as-of date" : "creation to recorded resolution"}</small></dd></div><div><dt>Location</dt><dd>{record.locationPath ?? "No location"}</dd></div><div><dt>Recorded root cause</dt><dd>{record.rootCause ?? "Not recorded"}{record.rootCauseId ? <small>Project-scoped ID: {record.rootCauseId}</small> : null}</dd></div><div><dt>CIQ root cause · effective</dt><dd>{record.iqRootCause ?? "Not classified"}<small>{record.iqRootCauseUserOverridden ? `Human override; model predicted ${record.iqRootCauseModel ?? "no value"}` : record.iqRootCauseModel ? "Model prediction · no human override" : "No model prediction"}</small></dd></div><div><dt>Discipline</dt><dd>{disciplineIdentityLabel(record) ?? "Not recorded"}</dd></div><div><dt>Building component · effective</dt><dd>{record.buildingComponent ?? "Not classified"}<small>{record.buildingComponentUserOverridden ? `Human override; model predicted ${record.buildingComponentModel ?? "no value"}` : record.buildingComponentModel ? "Model prediction · no human override" : "No model prediction"}</small></dd></div><div><dt>Cost impact</dt><dd>{costImpactLabel}<small>No issue-level monetary value</small></dd></div><div><dt>Schedule impact</dt><dd>{scheduleImpactLabel}</dd></div></dl></section><section className="drawer-section"><div className="drawer-section__head"><h4>Recurrence and downstream exposure</h4></div><dl className="record-fields"><div><dt>Recurring signatures</dt><dd>{recurrence.length || "None in scope"}{recurrence.length ? <small>{recurrence.map((group) => `${group.dimension === "root-cause" ? "Recorded cause" : group.dimension === "iq-root-cause" ? "CIQ predicted cause" : cap(group.dimension.replaceAll("-", " "))}: ${group.label}`).join(" · ")}</small> : null}</dd></div><div><dt>Schedule associations</dt><dd>{scheduleEdges.length}<small>confirmed/inferred links shown below; direction and causality are not asserted</small></dd></div><div><dt>Cost-record associations</dt><dd>{costEdges.length}<small>no linked amount is attributed to this risk record</small></dd></div></dl></section>{isConstructionIqRiskApplicable(record) ? <section className="drawer-section"><div className="drawer-section__head"><h4>ML classification and override</h4></div><div className="classification-compare"><div><small>Risk model</small><SeverityBadge severity={modelRisk} noneLabel="Unclassified" /><p>Synthetic Autodesk-shaped value</p></div><span aria-hidden="true">→</span><div><small>Risk effective value</small><SeverityBadge severity={record.constructionIqRisk} noneLabel="Unclassified" /><p>{record.riskUserOverridden ? "Human override takes precedence" : "Model value · no override"}</p></div></div><div className="classification-compare"><div><small>Root-cause model</small><strong>{record.iqRootCauseModel ?? "Not classified"}</strong><p>Construction IQ prediction</p></div><span aria-hidden="true">→</span><div><small>Root-cause effective value</small><strong>{record.iqRootCause ?? "Not classified"}</strong><p>{record.iqRootCauseUserOverridden ? "Human override takes precedence" : "Model value · no override"}</p></div></div><div className="classification-compare"><div><small>Component model</small><strong>{record.buildingComponentModel ?? "Not classified"}</strong><p>Construction IQ prediction</p></div><span aria-hidden="true">→</span><div><small>Component effective value</small><strong>{record.buildingComponent ?? "Not classified"}</strong><p>{record.buildingComponentUserOverridden ? "Human override takes precedence" : "Model value · no override"}</p></div></div></section> : <section className="drawer-section"><div className="drawer-section__head"><h4>ML classification and override</h4></div><p className="empty-copy">Construction IQ record-level risk is not applicable to this record type. No model value or human override is implied.</p></section>}<section className="drawer-section"><div className="drawer-section__head"><h4>Related records</h4><span>{related.length} edge{related.length === 1 ? "" : "s"}</span></div>{related.length ? <div className="related-list">{related.map((edge) => { const other = sameRecordIdentity(edge.from, record) ? edge.to : edge.from; return <article key={`${edge.projectId}:${edge.id}`}><span className={`confidence confidence--${edge.confidence}`}>{cap(edge.confidence)}</span><span><strong>{other.label}</strong><small>{other.kind} · {edge.method.replaceAll("-", " ")}</small><p>{edge.evidence}</p></span></article>; })}</div> : <p className="empty-copy">No supported relationship edge is present. Absence of an edge is not evidence that records are unrelated.</p>}</section>{attention?.recommendations.length ? <section className="drawer-section"><div className="drawer-section__head"><h4>Suggested actions</h4><span>Advisory only</span></div><div className="drawer-actions">{attention.recommendations.map((recommendation) => <article key={recommendation.id}><span aria-hidden="true">✓</span><div><strong>{recommendation.title}</strong><p>{recommendation.detail}</p><small>Deterministic rule · {recommendation.citedEvidence.length} cited record</small></div></article>)}</div></section> : null}<section className="drawer-section"><div className="drawer-section__head"><h4>Raw source row</h4><SourceChip label="Synthetic" syntheticKind="Autodesk-shaped field" /></div><div className="raw-table">{Object.entries(record.raw ?? {}).map(([key, value]) => <div key={key}><code>{key}</code><span>{value === null ? "null" : String(value)}</span></div>)}</div></section></div><div className="drawer-foot">{autodeskHref ? <a className="secondary-button" href={autodeskHref} target="_blank" rel="noopener noreferrer">Open corresponding item in Autodesk ↗</a> : <span>Synthetic record · Autodesk link unavailable in demo mode</span>}<button className="secondary-button" onClick={onClose}>Close</button></div></div></div>;
}
