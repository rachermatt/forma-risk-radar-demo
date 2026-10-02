import assert from "node:assert/strict";
import test from "node:test";
import { recordIdentityKey } from "../src/lib/canonical/types";
import { generateDemoDataset } from "../src/lib/demo/generator";
import { buildPortfolioIndicators } from "../src/lib/demo/portfolio-indicators";
import {
  PORTFOLIO_RECORD_INDICATOR_LABELS,
  disciplineIdentityKey,
  isOpenCiqClassifiedIssue,
  isOpenHighCiqIssue,
  isOpenHighCiqRfi,
  isOpenIssueWithRecordedCause,
  isOpenSafetySignalIssue,
  RECURRENCE_DIMENSIONS,
  recurrenceGroups,
  recurrenceGroupsAcrossDimensions,
  scheduleExposureFromRecords,
} from "../src/lib/risk/analytics";
import {
  UNATTRIBUTED_TRADE_FILTER,
  companyIdsWithHighRiskSignals,
  dashboardScopeFiltersFromQuery,
  effectiveRecordSeverity,
  resolveScopedProject,
  scopeDashboardData,
  selectSignedMomentumMovers,
} from "../src/lib/demo/scope";
import { buildScopedLineage, resolveVisibleLineageSelection } from "../src/lib/demo/scoped-lineage";

test("severity filtering uses source risk and never attention priority", () => {
  const data = generateDemoDataset();
  const item = data.attention.find((candidate) => {
    const record = data.records.find((entry) => candidate.evidence.some((evidence) => recordIdentityKey(evidence) === recordIdentityKey(entry)));
    const project = data.projects.find((entry) => entry.project.id === candidate.projectId);
    return candidate.priority === "critical" && record?.constructionIqRisk === "high" && project?.risk.value.severity === "critical";
  });
  assert.ok(item, "fixture must include a critical escalation over an Autodesk high classification");
  const record = data.records.find((entry) => item.evidence.some((evidence) => recordIdentityKey(evidence) === recordIdentityKey(entry)));
  assert.ok(record);
  assert.equal(effectiveRecordSeverity(record, data.attention), "high");

  const highScoped = scopeDashboardData(data, { severity: "high" });
  const criticalScoped = scopeDashboardData(data, { severity: "critical" });
  assert.ok(highScoped.records.some((entry) => recordIdentityKey(entry) === recordIdentityKey(record)));
  assert.ok(highScoped.attention.some((entry) => entry.id === item.id));
  assert.ok(!criticalScoped.records.some((entry) => recordIdentityKey(entry) === recordIdentityKey(record)));
});

test("domain selection projects the matching domain summary without implying rank", () => {
  const data = generateDemoDataset();
  const candidate = data.projects.flatMap((project) => project.domainSummaries.map((domain) => ({ project, domain })))
    .find(({ project, domain }) => domain.available && domain.severity !== project.risk.value.severity);
  assert.ok(candidate, "fixture must include a domain severity that differs from the project headline");

  const scoped = scopeDashboardData(data, {
    projectId: candidate.project.project.id,
    domain: candidate.domain.domain,
  });
  assert.equal(scoped.projects.length, 1);
  assert.equal(scoped.projects[0]?.project.id, candidate.project.project.id);
  assert.equal(scoped.projects[0]?.risk.value.index, candidate.domain.index);
  assert.equal(scoped.projects[0]?.risk.value.severity, candidate.domain.severity);
  assert.equal(scoped.projects[0]?.momentum.value.change7d, candidate.domain.momentum);
  assert.equal(scoped.projects[0]?.calculation.risk.ranking.eligible, false);
  assert.equal(scoped.projects[0]?.calculation.risk.ranking.value, null);
  assert.ok(scoped.records.every((record) => record.domain === candidate.domain.domain));
  assert.ok(scoped.attention.every((item) => item.domain === candidate.domain.domain));
});

test("domain momentum remains unavailable when no prior observation exists", () => {
  const data = generateDemoDataset();
  const candidate = data.projects.flatMap((project) => project.domainSummaries.map((domain) => ({ project, domain })))
    .find(({ domain }) => domain.available && domain.index !== null && domain.momentum === null);
  assert.ok(candidate, "fixture must include an indexed domain without prior-period momentum");
  const scoped = scopeDashboardData(data, { projectId: candidate.project.project.id, domain: candidate.domain.domain });
  assert.equal(scoped.projects[0]?.momentum.value.change7d, null);
  const falselyStable = scopeDashboardData(data, { projectId: candidate.project.project.id, domain: candidate.domain.domain, momentum: "stable" });
  assert.equal(falselyStable.projects.length, 0);
});

test("single-project momentum movers never invert increase and improvement semantics", () => {
  const data = generateDemoDataset();
  const increasing = data.projects.find((project) => (project.momentum.value.change7d ?? 0) > 0);
  const improving = data.projects.find((project) => (project.momentum.value.change7d ?? 0) < 0);
  assert.ok(increasing && improving);
  assert.deepEqual(selectSignedMomentumMovers([increasing]), {
    increase: increasing,
    improvement: null,
  });
  assert.deepEqual(selectSignedMomentumMovers([improving]), {
    increase: null,
    improvement: improving,
  });
});

test("portfolio record indicator labels remain coupled to source-supported predicates", () => {
  const data = generateDemoDataset();
  assert.equal(PORTFOLIO_RECORD_INDICATOR_LABELS.highCiqIssues, "Open issues Construction IQ rates High");
  assert.equal(PORTFOLIO_RECORD_INDICATOR_LABELS.highCiqRfis, "Open RFIs Construction IQ rates High");
  assert.equal(PORTFOLIO_RECORD_INDICATOR_LABELS.classifiedCiqIssues, "Open issues with CIQ classification");
  assert.equal(PORTFOLIO_RECORD_INDICATOR_LABELS.safetySignalIssues, "Open issues with safety signals");
  assert.equal(PORTFOLIO_RECORD_INDICATOR_LABELS.recordedWaterCauseIssues, "Open issues · recorded cause: Water Intrusion");

  const highIssues = data.records.filter(isOpenHighCiqIssue);
  const highRfis = data.records.filter(isOpenHighCiqRfi);
  const classifiedIssues = data.records.filter(isOpenCiqClassifiedIssue);
  const safetySignals = data.records.filter(isOpenSafetySignalIssue);
  const waterCause = data.records.filter((record) => isOpenIssueWithRecordedCause(record, "Water Intrusion"));
  assert.ok(highIssues.length > 0 && highIssues.every((record) => record.kind === "issue" && record.open && record.constructionIqRisk === "high"));
  assert.ok(highRfis.length > 0 && highRfis.every((record) => record.kind === "rfi" && record.open && record.constructionIqRisk === "high"));
  assert.ok(classifiedIssues.length >= highIssues.length);
  assert.ok(safetySignals.length > 0 && safetySignals.every((record) =>
    record.kind === "issue" && record.open && (
      (record.iqSafetyRiskCategory !== null && record.iqSafetyRiskCategory !== "unmapped") ||
      Boolean(record.iqSafetyHazardCategory?.trim()) ||
      record.iqSafetyObservationCategory === "negative"
    )
  ));
  assert.ok(waterCause.length > 0 && waterCause.every((record) =>
    record.kind === "issue" && record.open && record.rootCause?.toLowerCase() === "water intrusion"
  ));

  const indicators = buildPortfolioIndicators({
    data,
    projects: data.projects,
    records: data.records,
    companySignals: data.companyCiqSignals,
    recordScopeActive: false,
  });
  assert.equal(indicators.length, 10);
  const expectedEvidence = new Map([
    ["scoped:indicator:high-ciq-issues", new Set(highIssues.map(recordIdentityKey))],
    ["scoped:indicator:high-ciq-rfis", new Set(highRfis.map(recordIdentityKey))],
    ["scoped:indicator:classified-ciq-issues", new Set(classifiedIssues.map(recordIdentityKey))],
    ["scoped:indicator:safety-signal-issues", new Set(safetySignals.map(recordIdentityKey))],
    ["scoped:indicator:recorded-water-cause", new Set(waterCause.map(recordIdentityKey))],
  ]);
  for (const [id, identities] of expectedEvidence) {
    const indicator = indicators.find((entry) => entry.id === id);
    assert.ok(indicator);
    assert.equal(indicator.value, identities.size);
    assert.deepEqual(new Set(indicator.evidence.map(recordIdentityKey)), identities);
    assert.equal(indicator.lineage.provenance.valueKind, "application-derived");
    assert.deepEqual(indicator.lineage.evidence, indicator.evidence);
  }
});

test("company high-risk signals preserve company categories instead of implying subcontractors", () => {
  const data = generateDemoDataset();
  const companyIds = companyIdsWithHighRiskSignals(
    data.records,
    data.companyCiqSignals,
    new Set(data.projects.map((project) => project.project.id)),
  );
  const categories = new Set(data.companies
    .filter((company) => companyIds.has(company.id))
    .map((company) => company.category));
  assert.ok(companyIds.size > 0);
  assert.ok(categories.has("Subcontractor"));
  assert.ok([...categories].some((category) => category !== "Subcontractor"));
});

test("CIQ indicators ignore unsupported record kinds and preserve no-coverage as unavailable", () => {
  const data = generateDemoDataset();
  const form = data.records.find((record) => record.kind === "form")!;
  const impossibleHighForm = { ...form, constructionIqModelRisk: "high" as const, constructionIqRisk: "high" as const, open: true };
  const baseline = buildPortfolioIndicators({ data, projects: data.projects, records: data.records, companySignals: data.companyCiqSignals, recordScopeActive: false });
  const mixed = buildPortfolioIndicators({ data, projects: data.projects, records: [...data.records, impossibleHighForm], companySignals: data.companyCiqSignals, recordScopeActive: false });
  for (const id of ["scoped:indicator:high-ciq-issues", "scoped:indicator:high-ciq-rfis", "scoped:indicator:companies-high-risk-signals"]) {
    assert.equal(mixed.find((entry) => entry.id === id)?.value, baseline.find((entry) => entry.id === id)?.value, id);
  }

  const unavailableProjects = data.projects.filter((project) =>
    !data.ciqSourceCoverage.issueQualityProjectIds.includes(project.project.id) &&
    !data.ciqSourceCoverage.rfiRiskProjectIds.includes(project.project.id) &&
    !data.ciqSourceCoverage.issueSafetyProjectIds.includes(project.project.id)
  );
  assert.ok(unavailableProjects.length > 0);
  const unavailableIds = new Set(unavailableProjects.map((project) => project.project.id));
  const unavailable = buildPortfolioIndicators({
    data,
    projects: unavailableProjects,
    records: data.records.filter((record) => unavailableIds.has(record.projectId)),
    companySignals: data.companyCiqSignals.filter((signal) => unavailableIds.has(signal.projectId)),
    recordScopeActive: false,
  });
  for (const id of ["scoped:indicator:high-ciq-issues", "scoped:indicator:high-ciq-rfis", "scoped:indicator:classified-ciq-issues", "scoped:indicator:safety-signal-issues"]) {
    assert.equal(unavailable.find((entry) => entry.id === id)?.value, null, id);
  }
});

test("Issue, RFI, and safety CIQ indicators use independent extracted-source coverage", () => {
  const data = generateDemoDataset();
  const project = data.projects.find((summary) =>
    data.records.some((record) => record.projectId === summary.project.id && isOpenSafetySignalIssue(record))
  );
  assert.ok(project);
  const projectId = project.project.id;
  const records = data.records.filter((record) => record.projectId === projectId);
  const companySignals = data.companyCiqSignals.filter((signal) => signal.projectId === projectId);
  const build = (ciqSourceCoverage: typeof data.ciqSourceCoverage) => buildPortfolioIndicators({
    data: { ...data, ciqSourceCoverage },
    projects: [project],
    records,
    companySignals,
    recordScopeActive: false,
  });

  const issueOnly = build({
    issueQualityProjectIds: [projectId],
    rfiRiskProjectIds: [],
    rfiCauseProjectIds: [],
    issueSafetyRiskProjectIds: [],
    issueSafetyHazardProjectIds: [],
    issueSafetyObservationProjectIds: [],
    issueSafetyProjectIds: [],
  });
  assert.notEqual(issueOnly.find((entry) => entry.id === "scoped:indicator:high-ciq-issues")?.value, null);
  assert.notEqual(issueOnly.find((entry) => entry.id === "scoped:indicator:classified-ciq-issues")?.value, null);
  assert.equal(issueOnly.find((entry) => entry.id === "scoped:indicator:high-ciq-rfis")?.value, null);
  assert.equal(issueOnly.find((entry) => entry.id === "scoped:indicator:safety-signal-issues")?.value, null);

  const safetyOnly = build({
    issueQualityProjectIds: [],
    rfiRiskProjectIds: [],
    rfiCauseProjectIds: [],
    issueSafetyRiskProjectIds: [projectId],
    issueSafetyHazardProjectIds: [projectId],
    issueSafetyObservationProjectIds: [projectId],
    issueSafetyProjectIds: [projectId],
  });
  assert.equal(
    safetyOnly.find((entry) => entry.id === "scoped:indicator:safety-signal-issues")?.value,
    records.filter(isOpenSafetySignalIssue).length,
  );
  assert.equal(safetyOnly.find((entry) => entry.id === "scoped:indicator:high-ciq-issues")?.value, null);
  assert.equal(safetyOnly.find((entry) => entry.id === "scoped:indicator:high-ciq-rfis")?.value, null);
});

test("scoped drill-downs retain only fully visible edges or schedule metadata attached to a visible risk endpoint", () => {
  const data = generateDemoDataset();
  const chosen = data.projects[0]!;
  const domain = chosen.domainSummaries.find((entry) => entry.available)?.domain;
  assert.ok(domain);
  const scoped = scopeDashboardData(data, { projectId: chosen.project.id, domain });
  const recordIds = new Set(scoped.records.map(recordIdentityKey));

  assert.equal(resolveScopedProject(scoped.projects, "outside-scope"), null);
  assert.equal(resolveScopedProject(scoped.projects, null), null);
  assert.ok(scoped.relationships.every((edge) => {
    const fromVisible = recordIds.has(recordIdentityKey(edge.from));
    const toVisible = recordIds.has(recordIdentityKey(edge.to));
    return (fromVisible && toVisible) || (
      (edge.from.kind === "schedule-activity" || edge.to.kind === "schedule-activity") &&
      (fromVisible || toVisible)
    );
  }));
  assert.ok(scoped.projects.every((project) => project.project.id === chosen.project.id));
  assert.ok(scoped.records.every((record) => record.projectId === chosen.project.id && record.domain === domain));
  const baseline = scopeDashboardData(data, {});
  assert.equal(scoped.relationshipCoverage.excludedByScopeCount, baseline.relationships.length - scoped.relationships.length);
});

test("relationship scoping drops a dangling counterparty before any user-visible model", () => {
  const data = generateDemoDataset();
  const base = data.relationships.find((edge) => edge.confidence !== "none");
  assert.ok(base);
  const dangling = {
    ...base,
    id: "relationship-dangling-permission-gap",
    to: { ...base.to, id: "not-authorized", label: "Hidden counterparty" },
  };
  const scoped = scopeDashboardData({ ...data, relationships: [...data.relationships, dangling] }, {});
  assert.equal(scoped.relationships.some((edge) => edge.id === dangling.id), false);
  assert.equal(scoped.relationshipCoverage.excludedDanglingCount, 1);
  assert.equal(JSON.stringify(scoped.relationships).includes("Hidden counterparty"), false);
});

test("project schedule support counts only edges whose risk endpoint remains in scope", () => {
  const data = generateDemoDataset();
  const scheduleEdge = data.relationships.find((edge) =>
    edge.confidence === "confirmed" &&
    (edge.from.kind === "schedule-activity" || edge.to.kind === "schedule-activity")
  );
  assert.ok(scheduleEdge);
  const project = data.projects.find((summary) => summary.project.id === scheduleEdge.projectId);
  assert.ok(project);
  const riskEndpoint = scheduleEdge.from.kind === "schedule-activity" ? scheduleEdge.to : scheduleEdge.from;
  const riskRecord = data.records.find((record) => record.projectId === riskEndpoint.projectId && record.kind === riskEndpoint.kind && record.id === riskEndpoint.id);
  assert.ok(riskRecord);
  const scoped = scopeDashboardData(data, { projectId: project.project.id, domain: riskRecord.domain });
  const recordsWithActivityMetadata = [
    ...scoped.records,
    ...data.records.filter((record) => record.projectId === project.project.id && record.kind === "schedule-activity"),
  ];
  const projectEdges = data.relationships.filter((edge) => edge.projectId === project.project.id);
  const result = scheduleExposureFromRecords(recordsWithActivityMetadata, projectEdges);
  const eligible = new Set(scoped.records.filter((record) =>
    record.open && record.kind !== "schedule-activity" && ["high", "medium"].includes(record.constructionIqRisk)
  ).map(recordIdentityKey));
  const expectedEdges = projectEdges.filter((edge) => {
    if (edge.confidence !== "confirmed" || (edge.from.kind !== "schedule-activity" && edge.to.kind !== "schedule-activity")) return false;
    const risk = edge.from.kind === "schedule-activity" ? edge.to : edge.from;
    return eligible.has(recordIdentityKey(risk));
  });
  assert.equal(result.confirmedScheduleEdgeCount, expectedEdges.length);
  assert.ok(result.scheduleLinkedRiskRecords.every((record) => record.domain === riskRecord.domain));
});

test("record-level global filters retain only matching evidence and projects", () => {
  const data = generateDemoDataset();
  const companyRecord = data.records.find((candidate) => candidate.companyId);
  const disciplineRecord = data.records.find((candidate) => candidate.discipline);
  const locationRecord = data.records.find((candidate) => candidate.locationPath);
  const rootCauseRecord = data.records.find((candidate) => candidate.rootCause);
  const iqRootCauseRecord = data.records.find((candidate) => candidate.iqRootCause);
  assert.ok(companyRecord && disciplineRecord && locationRecord && rootCauseRecord && iqRootCauseRecord);
  const company = data.companies.find((candidate) => candidate.id === companyRecord.companyId);
  assert.ok(company?.trade);

  const companyScoped = scopeDashboardData(data, {
    companyId: companyRecord.companyId,
    trade: company.trade,
  });
  assert.ok(companyScoped.records.length > 0);
  assert.ok(companyScoped.records.every((candidate) => candidate.companyId === companyRecord.companyId));
  const selectedDisciplineKey = disciplineIdentityKey(disciplineRecord);
  assert.ok(selectedDisciplineKey);
  const disciplineScoped = scopeDashboardData(data, { discipline: selectedDisciplineKey });
  assert.ok(disciplineScoped.records.every((candidate) => disciplineIdentityKey(candidate) === selectedDisciplineKey));
  assert.ok(!disciplineScoped.records.some((candidate) =>
    candidate.discipline === disciplineRecord.discipline && candidate.disciplineOrigin !== disciplineRecord.disciplineOrigin
  ));
  const locationScoped = scopeDashboardData(data, { location: locationRecord.locationPath });
  assert.ok(locationScoped.records.every((candidate) => candidate.locationPath === locationRecord.locationPath));
  const rootCauseScoped = scopeDashboardData(data, { rootCause: rootCauseRecord.rootCause, status: rootCauseRecord.status });
  assert.ok(rootCauseScoped.records.every((candidate) => candidate.rootCause === rootCauseRecord.rootCause && candidate.status === rootCauseRecord.status));
  const iqRootCauseScoped = scopeDashboardData(data, { iqRootCause: iqRootCauseRecord.iqRootCause });
  assert.ok(iqRootCauseScoped.records.every((candidate) => candidate.iqRootCause === iqRootCauseRecord.iqRootCause));
  const predictedOnlyRfi = data.records.find((candidate) => candidate.kind === "rfi" && !candidate.rootCause && candidate.iqRootCause);
  assert.ok(predictedOnlyRfi);
  const recordedDoesNotBorrowPrediction = scopeDashboardData(data, { rootCause: predictedOnlyRfi.iqRootCause });
  const predictedUsesPrediction = scopeDashboardData(data, { iqRootCause: predictedOnlyRfi.iqRootCause });
  assert.ok(!recordedDoesNotBorrowPrediction.records.some((candidate) => recordIdentityKey(candidate) === recordIdentityKey(predictedOnlyRfi)));
  assert.ok(predictedUsesPrediction.records.some((candidate) => recordIdentityKey(candidate) === recordIdentityKey(predictedOnlyRfi)));
  const noTrade = scopeDashboardData(data, { trade: UNATTRIBUTED_TRADE_FILTER });
  assert.ok(noTrade.records.length > 0);
  assert.ok(noTrade.records.every((candidate) => !data.companies.find((companyCandidate) => companyCandidate.id === candidate.companyId)?.trade));
  for (const scoped of [companyScoped, disciplineScoped, locationScoped, rootCauseScoped, iqRootCauseScoped]) {
    const projectIds = new Set(scoped.records.map((candidate) => candidate.projectId));
    assert.ok(scoped.projects.every((summary) => projectIds.has(summary.project.id)));
  }
});

test("invalid URL filter enums and dataset values never activate negative predicates", () => {
  const data = generateDemoDataset();
  const filters = dashboardScopeFiltersFromQuery(
    data,
    new URLSearchParams("persistence=anything&recurrence=anything&domain=fiction&severity=urgent&momentum=faster&costExposure=maybe&scheduleExposure=caused&company=unknown&status=invented"),
  );
  assert.equal(filters.persistence, null);
  assert.equal(filters.recurrence, null);
  assert.equal(filters.domain, null);
  assert.equal(filters.severity, null);
  assert.equal(filters.momentum, null);
  assert.equal(filters.costExposure, null);
  assert.equal(filters.scheduleExposure, null);
  assert.equal(filters.companyId, null);
  assert.equal(filters.status, null);
  const scoped = scopeDashboardData(data, filters);
  assert.equal(scoped.projects.length, data.projects.length);
  assert.equal(scoped.records.length, data.records.length);
});

test("persistence, recurrence, and exposure filters use explicit record predicates", () => {
  const data = generateDemoDataset();
  const persistent = scopeDashboardData(data, { persistence: "persistent" });
  assert.ok(persistent.records.length > 0);
  assert.ok(persistent.records.every((record) => {
    const age = (new Date(data.asOf).getTime() - new Date(record.createdAt).getTime()) / 86_400_000;
    const severity = effectiveRecordSeverity(record, data.attention);
    return record.open && age > 30 && (severity === "critical" || severity === "high");
  }));

  const recurringIds = new Set(
    (["root-cause", "iq-root-cause", "location", "company", "building-component"] as const)
      .flatMap((dimension) => recurrenceGroups(data.records, dimension, data.asOf, 180, "demo-generator"))
      .flatMap((group) => group.evidence.map(recordIdentityKey)),
  );
  const recurring = scopeDashboardData(data, { recurrence: "recurring" });
  assert.ok(recurring.records.length > 0);
  assert.ok(recurring.records.every((record) => recurringIds.has(recordIdentityKey(record))));

  const confirmedCost = scopeDashboardData(data, { costExposure: "confirmed" });
  assert.ok(confirmedCost.records.length > 0);
  assert.ok(confirmedCost.records.every((record) => record.open && ((record.kind === "rfi" && record.costImpact === "yes") || (record.kind === "issue" && record.iqCostImpact === "high"))));
  const potentialCost = scopeDashboardData(data, { costExposure: "potential" });
  assert.ok(potentialCost.records.length > 0);
  assert.ok(potentialCost.records.every((record) => record.open && ((record.kind === "rfi" && record.costImpact === "unknown") || (record.kind === "issue" && record.iqCostImpact === "medium"))));
  const flaggedSchedule = scopeDashboardData(data, { scheduleExposure: "flagged" });
  assert.ok(flaggedSchedule.records.length > 0);
  assert.ok(flaggedSchedule.records.every((record) => record.open && record.kind === "rfi" && record.scheduleImpact === "yes"));
  const potentialSchedule = scopeDashboardData(data, { scheduleExposure: "potential" });
  assert.ok(potentialSchedule.records.length > 0);
  assert.ok(potentialSchedule.records.every((record) => record.open && record.kind === "rfi" && record.scheduleImpact === "unknown"));
  const linkedRiskIdentities = new Set(scheduleExposureFromRecords(data.records, data.relationships).scheduleLinkedRiskRecords.map(recordIdentityKey));
  const linkedIdentities = new Set(linkedRiskIdentities);
  for (const edge of data.relationships) {
    if (edge.confidence !== "confirmed" || (edge.from.kind !== "schedule-activity" && edge.to.kind !== "schedule-activity")) continue;
    const riskEndpoint = edge.from.kind === "schedule-activity" ? edge.to : edge.from;
    if (!linkedRiskIdentities.has(recordIdentityKey(riskEndpoint))) continue;
    linkedIdentities.add(recordIdentityKey(edge.from));
    linkedIdentities.add(recordIdentityKey(edge.to));
  }
  const linkedSchedule = scopeDashboardData(data, { scheduleExposure: "linked" });
  assert.ok(linkedSchedule.records.length > 0);
  assert.ok(linkedSchedule.records.every((record) => linkedIdentities.has(recordIdentityKey(record))));
});

test("recurrence membership is recomputed after narrower record filters", () => {
  const data = generateDemoDataset();
  const base = scopeDashboardData(data, { domain: "design", severity: "medium" });
  const expected = new Set(
    (["root-cause", "iq-root-cause", "location", "company", "building-component"] as const)
      .flatMap((dimension) => recurrenceGroups(base.records, dimension, data.asOf, 180, "demo-generator"))
      .flatMap((group) => group.evidence.map(recordIdentityKey)),
  );
  const recurring = scopeDashboardData(data, { domain: "design", severity: "medium", recurrence: "recurring" });
  assert.deepEqual(new Set(recurring.records.map(recordIdentityKey)), expected);
});

test("recurrence headline groups are recomputed inside project and domain scopes", () => {
  const data = generateDemoDataset();
  const scopedPopulations = [
    ...data.projects.map((project) => scopeDashboardData(data, { projectId: project.project.id })),
    ...(["design", "quality", "safety", "rfi", "submittal"] as const)
      .map((domain) => scopeDashboardData(data, { domain })),
  ];
  let leakyScopeCount = 0;
  for (const scoped of scopedPopulations) {
    const recomputed = recurrenceGroupsAcrossDimensions(
      scoped.records,
      data.asOf,
      180,
      "demo-generator",
    );
    const manual = RECURRENCE_DIMENSIONS.flatMap((dimension) =>
      recurrenceGroups(scoped.records, dimension, data.asOf, 180, "demo-generator")
    );
    assert.equal(recomputed.length, manual.length);

    const visible = new Set(scoped.records.map(recordIdentityKey));
    const intersectedGlobalCount = data.recurrence.filter((group) =>
      group.evidence.some((evidence) => visible.has(recordIdentityKey(evidence)))
    ).length;
    if (intersectedGlobalCount > recomputed.length) leakyScopeCount += 1;
  }
  assert.ok(leakyScopeCount >= 2, "fixture must catch global recurrence leaking into narrow scopes");
});

test("unsupported record filters suppress aggregate company CIQ rows", () => {
  const data = generateDemoDataset();
  assert.ok(scopeDashboardData(data, {}).companyCiqSignals.length > 0);
  assert.equal(scopeDashboardData(data, { severity: "high" }).companyCiqSignals.length, 0);
  const companyId = data.companyCiqSignals[0]?.companyId;
  assert.ok(companyId);
  assert.ok(scopeDashboardData(data, { companyId }).companyCiqSignals.every((signal) => signal.companyId === companyId));
});

test("current-scope lineage records every recomputed dashboard metric with complete IDs", () => {
  const data = generateDemoDataset();
  const filters = { projectId: data.projects[0]!.project.id, domain: "quality" as const };
  const scoped = scopeDashboardData(data, filters);
  const lineage = buildScopedLineage(data, scoped, { filters, rangeDays: 30, concentrationDimension: "trade" });
  const ids = new Set(lineage.map((entry) => entry.id));
  for (const id of [
    "scoped:portfolio:risk",
    "scoped:portfolio:exposure",
    "scoped:portfolio:momentum",
    "scoped:portfolio:burn:30d",
    "scoped:persistence:over-30d",
  ]) assert.ok(ids.has(id), `expected ${id}`);
  const exposure = lineage.find((entry) => entry.id === "scoped:portfolio:exposure");
  assert.deepEqual(exposure?.value, { index: null, unavailableReason: "No validated domain-level exposure index" });
  assert.equal(exposure?.evidence.length, 0);
  assert.ok(lineage.every((entry) => entry.provenance.valueKind !== "autodesk-provided" || Boolean(entry.provenance.autodeskTerm)));
  assert.ok(lineage.some((entry) => entry.id.startsWith("scoped:ciq-project-quality:")));
  assert.ok(lineage.some((entry) => entry.id.startsWith("scoped:ciq-company-quality:")));
  const visibleRecordIds = new Set(scoped.records.map(recordIdentityKey));
  for (const entry of lineage.filter((candidate) => candidate.id.startsWith("scoped:"))) {
    assert.ok(entry.evidence.every((evidence) => visibleRecordIds.has(recordIdentityKey(evidence))), `${entry.id} leaked out-of-scope evidence`);
  }
});

test("current-scope lineage withholds burn metrics when the selected source window is incomplete", () => {
  const data = generateDemoDataset();
  const scoped = scopeDashboardData(data, {});
  const lineage = buildScopedLineage(data, scoped, {
    filters: {},
    rangeDays: 365,
    rangeAsOf: data.asOf,
    rangeCoverageComplete: false,
    concentrationDimension: "trade",
  });
  assert.equal(lineage.some((entry) => entry.id === "scoped:portfolio:burn:365d"), false);
  assert.equal(lineage.some((entry) => entry.id.includes(":burn:365d")), false);
});

test("scoped Form lineage separates same-name templates by template and layout identity", () => {
  const data = generateDemoDataset();
  const filters = { projectId: "project-harbor-point" };
  const scoped = scopeDashboardData(data, filters);
  const lineage = buildScopedLineage(data, scoped, { filters, rangeDays: 30, concentrationDimension: "company" });
  const entries = lineage.filter((entry) =>
    entry.id.startsWith("scoped:form:") && entry.label === "Building Envelope Inspection filtered activity"
  );
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 2);
  const evidence = entries.map((entry) => new Set(entry.evidence.map(recordIdentityKey)));
  assert.ok([...evidence[0]!].every((key) => !evidence[1]!.has(key)));
});

test("provenance selection cannot escape the visible category", () => {
  const data = generateDemoDataset();
  const formEntries = data.lineage.filter((entry) => entry.category === "form");
  const portfolioEntry = data.lineage.find((entry) => entry.category === "portfolio");
  assert.ok(formEntries.length > 0 && portfolioEntry);
  const resolved = resolveVisibleLineageSelection(formEntries, portfolioEntry.id);
  assert.equal(resolved?.id, formEntries[0]?.id);
  assert.equal(resolveVisibleLineageSelection([], portfolioEntry.id), null);
});

test("company-filtered lineage suppresses snapshot composites and never leaks evidence", () => {
  const data = generateDemoDataset();
  const companyId = data.records.find((record) => record.companyId)?.companyId;
  assert.ok(companyId);
  const filters = { companyId };
  const scoped = scopeDashboardData(data, filters);
  const lineage = buildScopedLineage(data, scoped, { filters, rangeDays: 30, concentrationDimension: "company" });
  const visible = new Set(scoped.records.map(recordIdentityKey));
  for (const id of ["scoped:portfolio:risk", "scoped:portfolio:exposure", "scoped:portfolio:momentum"]) {
    const entry = lineage.find((candidate) => candidate.id === id);
    assert.ok(entry);
    assert.equal(entry.evidence.length, 0);
    assert.equal((entry.value as { index?: number | null }).index ?? null, null);
  }
  assert.ok(scoped.companyCiqSignals.every((signal) => signal.companyId === companyId));
  assert.ok(lineage.every((entry) => entry.evidence.every((evidence) => visible.has(recordIdentityKey(evidence)))));
});
