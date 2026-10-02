import assert from "node:assert/strict";
import test from "node:test";
import { RISK_DOMAINS, recordIdentityKey, sameRecordIdentity, type RiskRecord } from "../src/lib/canonical/types";
import { DEMO_COVERAGE_START, generateDemoDataset } from "../src/lib/demo/generator";
import { formRecordMatchesSignal, formSignalIdentityKey } from "../src/lib/demo/types";
import {
  calculateAttentionItem,
  actionabilityIndex,
  attentionExposureSummary,
  attentionRecurringRecordKeys,
  concentration,
  disciplineIdentityKey,
  hasSupportedSafetySignal,
  hotspots,
  RECORDED_ROOT_CAUSE_NORMALIZATION_VERSION,
  recurrenceGroups,
  recurrencePopulationStats,
  scheduleExposureFromRecords,
} from "../src/lib/risk/analytics";
import { calculateRiskIndex, per100Active } from "../src/lib/risk/metrics";

const DAY_MS = 86_400_000;

function isHigh(record: RiskRecord): boolean {
  return record.constructionIqRisk === "high" || record.constructionIqRisk === "critical";
}

function isOverdue(record: RiskRecord, asOf: string): boolean {
  return (record.kind === "issue" || record.kind === "rfi" || record.kind === "submittal") &&
    Boolean(record.dueDate && new Date(record.dueDate).getTime() < new Date(asOf).getTime());
}

function isCriticalOverdue(record: RiskRecord, asOf: string): boolean {
  return isOverdue(record, asOf) && (
    isHigh(record) ||
    (record.kind === "submittal" && typeof record.raw?.revision === "number" && record.raw.revision >= 2)
  );
}

function hasSafetySignal(record: RiskRecord): boolean {
  return hasSupportedSafetySignal(record);
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator ? 100 * numerator / denominator : null;
}

test("demo fixture covers required portfolio stories", () => {
  const data = generateDemoDataset();
  assert.equal(data.projects.length, 10);
  assert.ok(data.companies.length >= 5);
  assert.ok(data.projects.some((project) => project.momentum.value.direction === "accelerating"));
  assert.ok(data.projects.some((project) => project.momentum.value.direction === "improving"));
  assert.ok(data.projects.some((project) => project.project.availableDomains.includes("safety") === false));
  assert.ok(data.attention.some((item) => item.reasons.some((reason) => reason.code === "UNASSIGNED")));
  assert.ok(data.hotspots.some((hotspot) => hotspot.domains.length >= 2));
  assert.ok(data.relationships.length > 0);
  assert.equal(data.ingestion.rowsProcessed, data.records.length);
});

test("attention display clamps at 100 but raw score remains rankable", () => {
  const data = generateDemoDataset();
  const capped = data.attention.find((item) => item.rawScore > 100);
  assert.ok(capped);
  assert.equal(capped.score, 100);
  assert.ok(capped.reasons.length > 1);
});

test("only a downward human override subtracts attention points", () => {
  const data = generateDemoDataset();
  const baseline = data.records.find((record) => record.kind === "issue" && record.constructionIqModelRisk === "high");
  assert.ok(baseline);
  const context = { projectName: "Test", asOf: data.asOf, projectMomentum: "stable" as const };
  const downgrade = calculateAttentionItem({ ...baseline, riskUserOverridden: true, constructionIqModelRisk: "high", constructionIqRisk: "low" }, context);
  const upgrade = calculateAttentionItem({ ...baseline, riskUserOverridden: true, constructionIqModelRisk: "low", constructionIqRisk: "high" }, context);
  assert.ok(downgrade.reasons.some((reason) => reason.code === "CIQ_USER_OVERRIDE_DOWNGRADE" && reason.points === -10));
  assert.ok(!upgrade.reasons.some((reason) => reason.code === "CIQ_USER_OVERRIDE_DOWNGRADE"));
});

test("attention does not invent or score momentum without a prior observation", () => {
  const data = generateDemoDataset();
  const record = data.records.find((candidate) => candidate.open && (candidate.kind === "issue" || candidate.kind === "rfi"))!;
  const item = calculateAttentionItem(record, { projectName: "Test", asOf: data.asOf, projectMomentum: null });
  assert.equal(item.momentum, null);
  assert.equal(item.reasons.some((entry) => entry.code === "PROJECT_MOMENTUM_WORSENING"), false);
});

test("unsupported record kinds cannot gain ownership, due-date, overdue, or stale attention factors", () => {
  const data = generateDemoDataset();
  const base = data.records.find((record) => record.kind === "form")!;
  const item = calculateAttentionItem({ ...base, open: true, dueDate: "2026-01-01T00:00:00.000Z", assigneeId: null, assigneeType: null }, {
    projectName: "Test",
    asOf: data.asOf,
    projectMomentum: "stable",
    stale: true,
  });
  const forbidden = new Set(["OVERDUE", "OVERDUE_AGE", "UNASSIGNED", "NO_DUE_DATE", "STALE"]);
  assert.ok(item.reasons.every((reason) => !forbidden.has(reason.code)));
});

test("CIQ-derived analytics reject classified lookalikes on unsupported record kinds", () => {
  const data = generateDemoDataset();
  const base = data.records.find((record) => record.kind === "form")!;
  const first = {
    ...base,
    id: "classified-form-a",
    open: true,
    constructionIqModelRisk: "high" as const,
    constructionIqRisk: "high" as const,
    domain: "quality" as const,
  };
  const second = {
    ...first,
    id: "classified-form-b",
    domain: "safety" as const,
  };
  assert.equal(actionabilityIndex([first, second], data.asOf), null);
  assert.deepEqual(hotspots([first, second], new Map([[first.projectId, "Test"]]), data.asOf), []);
});

test("supported safety signals use canonical Issue sidecars only", () => {
  const data = generateDemoDataset();
  const issue = data.records.find((record) => record.kind === "issue")!;
  assert.equal(hasSupportedSafetySignal({
    ...issue,
    iqSafetyRiskCategory: "unmapped",
    iqSafetyHazardCategory: "   ",
    iqSafetyObservationCategory: "positive",
    raw: { safety_risk_category: "fall", safety_observation_category: "negative" },
  }), false);
  assert.equal(hasSupportedSafetySignal({
    ...issue,
    iqSafetyRiskCategory: null,
    iqSafetyHazardCategory: "ladder",
    iqSafetyObservationCategory: null,
  }), true);
  assert.equal(hasSupportedSafetySignal({
    ...issue,
    kind: "form",
    iqSafetyRiskCategory: "fall",
  }), false);
});

test("recurrence keeps recorded and CIQ-predicted root causes separate", () => {
  const data = generateDemoDataset();
  const recordedGroups = recurrenceGroups(data.records, "root-cause", data.asOf);
  const iqGroups = recurrenceGroups(data.records, "iq-root-cause", data.asOf);
  const windowStart = new Date(data.asOf).getTime() - 180 * 86_400_000;
  const inWindow = (record: RiskRecord) => new Date(record.createdAt).getTime() >= windowStart && new Date(record.createdAt).getTime() <= new Date(data.asOf).getTime();
  const totalRecordedRelevant = data.records.filter((record) => record.rootCause && inWindow(record)).length;
  const totalIqRelevant = data.records.filter((record) => record.iqRootCause && inWindow(record)).length;
  assert.ok(recordedGroups.length > 0);
  assert.ok(iqGroups.length > 0);
  assert.ok(recordedGroups.every((group) => group.recurrenceRate === (group.occurrences - 1) / totalRecordedRelevant));
  assert.ok(iqGroups.every((group) => group.recurrenceRate === (group.occurrences - 1) / totalIqRelevant));
  assert.ok(recordedGroups.every((group) => group.evidence.every((evidence) => {
    const record = data.records.find((candidate) => sameRecordIdentity(candidate, evidence));
    return Boolean(record?.rootCause);
  })));
  assert.ok(iqGroups.every((group) => group.evidence.every((evidence) => {
    const record = data.records.find((candidate) => sameRecordIdentity(candidate, evidence));
    return Boolean(record?.iqRootCause);
  })));
});

test("recurrence applies an explicit inclusive as-of window", () => {
  const data = generateDemoDataset();
  const examples = data.records.filter((record) => record.kind === "issue").slice(0, 3);
  const records = examples.map((record, index) => ({
    ...record,
    id: `window-${index}`,
    rootCause: "Window Test",
    iqRootCause: null,
    createdAt: index === 0 ? "2026-03-12T12:00:00.000Z" : index === 1 ? "2026-03-11T12:00:00.000Z" : "2026-09-09T12:00:00.000Z",
  }));
  const groups = recurrenceGroups(records, "root-cause", "2026-09-08T12:00:00.000Z", 180);
  assert.equal(groups.length, 0, "only the event exactly on the lower boundary is inside the window");
});

test("attention recurrence includes a non-root-cause signature across the exact 90-day window", () => {
  const data = generateDemoDataset();
  const base = data.records.find((record) => record.kind === "issue");
  assert.ok(base);
  const locationOnly = [0, 1, 2].map((index): RiskRecord => ({
    ...base,
    id: `location-only-${index}`,
    rootCauseId: null,
    rootCause: null,
    iqRootCause: null,
    companyId: null,
    buildingComponent: null,
    locationId: "location-only-signature",
    locationPath: "Test building > Level 01 > Location only",
    createdAt: `2026-08-0${index + 1}T12:00:00.000Z`,
  }));
  const recurring = attentionRecurringRecordKeys(locationOnly, data.asOf, "demo-generator");
  assert.deepEqual(
    [...recurring].sort(),
    locationOnly.map(recordIdentityKey).sort(),
  );
  const item = calculateAttentionItem(locationOnly[0]!, {
    projectName: "Location-only recurrence",
    asOf: data.asOf,
    projectMomentum: "stable",
    recurring: recurring.has(recordIdentityKey(locationOnly[0]!)),
  });
  assert.ok(item.reasons.some((reason) => reason.code === "RECURRING_SIGNATURE" && reason.points === 7));
  const recurrenceRecommendation = item.recommendations.find((recommendation) =>
    recommendation.ruleId === "mitigation.recurrence.v1"
  );
  assert.match(recurrenceRecommendation?.detail ?? "", /shared signature; the grouping itself does not establish causality/u);
});

test("attention exposure labels keep confirmed and potential cost categories distinct", () => {
  const data = generateDemoDataset();
  const issue = data.records.find((record) => record.kind === "issue");
  const rfi = data.records.find((record) => record.kind === "rfi");
  assert.ok(issue);
  assert.ok(rfi);
  assert.equal(attentionExposureSummary({ ...issue, iqCostImpact: "high" }), "Cost confirmed");
  assert.equal(attentionExposureSummary({ ...issue, iqCostImpact: "medium" }), "Cost potential");
  assert.equal(attentionExposureSummary({ ...rfi, costImpact: "yes", scheduleImpact: "no" }), "Cost confirmed");
  assert.equal(attentionExposureSummary({ ...rfi, costImpact: "unknown", scheduleImpact: "no" }), "Cost potential");
});

test("recorded-root recurrence uses project ids locally and a versioned dictionary across projects", () => {
  const data = generateDemoDataset();
  const base = data.records.find((record) => record.kind === "issue" && record.rootCauseId);
  assert.ok(base);
  const localDifferentIds = [
    { ...base, id: "local-a", rootCauseId: "configured-cause-a", rootCause: "Water Intrusion", createdAt: "2026-08-01T12:00:00.000Z" },
    { ...base, id: "local-b", rootCauseId: "configured-cause-b", rootCause: "Water Intrusion", createdAt: "2026-08-02T12:00:00.000Z" },
  ];
  assert.equal(recurrenceGroups(localDifferentIds, "root-cause", data.asOf).length, 0, "same display text must not merge two project-configured ids");

  const localSameId = localDifferentIds.map((record) => ({ ...record, rootCauseId: "configured-cause-a" }));
  assert.equal(recurrenceGroups(localSameId, "root-cause", data.asOf)[0]?.occurrences, 2);

  const crossProject = [
    { ...localDifferentIds[0]!, projectId: "project-a", rootCause: "Water Ingress" },
    { ...localDifferentIds[1]!, projectId: "project-b", rootCause: "Water Intrusion" },
  ];
  const crossProjectGroup = recurrenceGroups(crossProject, "root-cause", data.asOf)[0];
  assert.equal(crossProjectGroup?.occurrences, 2);
  assert.match(crossProjectGroup?.signature ?? "", new RegExp(RECORDED_ROOT_CAUSE_NORMALIZATION_VERSION.replaceAll(".", "\\.")));
  assert.deepEqual(recurrencePopulationStats(crossProject, "root-cause", data.asOf), {
    relevantEvents: 2,
    distinctSignatures: 1,
    excludedEvents: 0,
    crossProject: true,
  });
});

test("operational and CIQ-predicted disciplines never share a concentration key", () => {
  const data = generateDemoDataset();
  const base = data.records.find((record) => record.discipline);
  assert.ok(base);
  const operational = { ...base, id: "discipline-operational", discipline: "Mechanical", disciplineOrigin: "operational" as const };
  const predicted = { ...base, id: "discipline-ciq", discipline: "Mechanical", disciplineOrigin: "construction-iq" as const };
  assert.notEqual(disciplineIdentityKey(operational), disciplineIdentityKey(predicted));
  const buckets = concentration([operational, predicted], "discipline", data.companies, data.asOf);
  assert.equal(buckets.length, 2);
  assert.ok(buckets.some((bucket) => bucket.label.includes("Operational")));
  assert.ok(buckets.some((bucket) => bucket.label.includes("CIQ predicted")));
});

test("hotspot scoring follows the published breadth, diversity, and capped-volume formula", () => {
  const data = generateDemoDataset();
  const identity = (projectId: string, locationId: string) => JSON.stringify([projectId, locationId]);
  const locations = new Map(data.locations.map((node) => [identity(node.projectId, node.id), node] as const));
  const leafLocations = new Set(data.records.flatMap((record) =>
    record.locationId ? [identity(record.projectId, record.locationId)] : []
  ));
  assert.ok(data.hotspots.some((hotspot) => !leafLocations.has(identity(hotspot.projectId, hotspot.locationId))));
  for (const hotspot of data.hotspots) {
    const counts = Object.values(hotspot.domainCounts).filter((value): value is number => typeof value === "number");
    const total = counts.reduce((sum, value) => sum + value, 0);
    const breadth = (hotspot.domains.length - 1) / 8;
    const diversity = 1 - counts.reduce((sum, value) => sum + (value / total) ** 2, 0);
    const expected = Math.round(100 * (0.5 * breadth + 0.3 * diversity + 0.2 * (Math.min(total, 20) / 20)) * 10) / 10;
    assert.equal(hotspot.totalHighRisk, total);
    assert.equal(hotspot.overlapScore, expected);
    assert.ok(locations.has(identity(hotspot.projectId, hotspot.locationId)));
    assert.ok(hotspot.evidence.every((entry) => {
      const record = data.records.find((candidate) => sameRecordIdentity(candidate, entry))!;
      if (!(record.open && ["high", "medium"].includes(record.constructionIqRisk) && record.locationId)) return false;
      let node = locations.get(identity(record.projectId, record.locationId));
      const visited = new Set<string>();
      while (node && !visited.has(identity(node.projectId, node.id))) {
        const key = identity(node.projectId, node.id);
        if (key === identity(hotspot.projectId, hotspot.locationId)) return true;
        visited.add(key);
        node = node.parentId ? locations.get(identity(node.projectId, node.parentId)) : undefined;
      }
      return false;
    }));
  }
});

test("every displayed project dimension carries synthetic provenance", () => {
  const data = generateDemoDataset();
  for (const project of data.projects) {
    assert.equal(project.risk.provenance.sourceSystem, "demo-generator");
    assert.equal(project.exposure.provenance.sourceSystem, "demo-generator");
    assert.equal(project.momentum.provenance.sourceSystem, "demo-generator");
  }
});

test("project headline counts and risk inputs are recalculated from canonical records", () => {
  const data = generateDemoDataset();

  for (const summary of data.projects) {
    const records = data.records.filter((record) => record.projectId === summary.project.id);
    const open = records.filter((record) => record.open);
    const openIssues = open.filter((record) => record.kind === "issue");
    const high = open.filter(isHigh);
    const highIssues = openIssues.filter(isHigh);
    const overduePopulation = open.filter((record) =>
      record.kind === "issue" || record.kind === "rfi" || record.kind === "submittal"
    );
    const overdue = overduePopulation.filter((record) => isOverdue(record, data.asOf));
    const criticalOverdue = open.filter((record) => isCriticalOverdue(record, data.asOf));
    const safetySignals = openIssues.filter(hasSafetySignal);
    const classifiedRfis = records.filter((record) =>
      record.kind === "rfi" && ["critical", "high", "medium", "low"].includes(record.constructionIqRisk)
    );
    const persistent = high.filter((record) =>
      new Date(data.asOf).getTime() - new Date(record.createdAt).getTime() > 30 * DAY_MS
    );
    const inputs = summary.calculation.risk.inputs;
    const normalizations = summary.calculation.risk.normalizations;

    assert.equal(summary.risk.value.highRiskOpen, high.length, summary.project.id);
    assert.equal(summary.risk.value.criticalOverdue, criticalOverdue.length, summary.project.id);
    const issueCiqCovered = data.ciqSourceCoverage.issueQualityProjectIds.includes(summary.project.id);
    const rfiCiqCovered = data.ciqSourceCoverage.rfiRiskProjectIds.includes(summary.project.id);
    assert.equal(inputs.highRiskPer100, issueCiqCovered ? percentage(highIssues.length, openIssues.length) : null);
    assert.equal(inputs.overduePer100, percentage(overdue.length, overduePopulation.length));
    assert.equal(
      inputs.safetySignalsPer100,
      summary.project.availableDomains.includes("safety") && safetySignals.length >= 5
        ? percentage(safetySignals.length, openIssues.length)
        : null,
    );
    assert.equal(
      inputs.rfiHighShare,
      rfiCiqCovered && classifiedRfis.length ? classifiedRfis.filter(isHigh).length / classifiedRfis.length : null,
    );
    assert.equal(inputs.persistenceOver30Share, (issueCiqCovered || rfiCiqCovered) && high.length ? persistent.length / high.length : null);
    assert.deepEqual(normalizations.highRiskPer100, per100Active(highIssues.length, openIssues.length));
    assert.deepEqual(normalizations.overduePer100, per100Active(overdue.length, overduePopulation.length));
    assert.deepEqual(
      normalizations.safetySignalsPer100,
      summary.project.availableDomains.includes("safety") && safetySignals.length >= 5
        ? per100Active(safetySignals.length, openIssues.length)
        : null,
    );

    const recalculated = calculateRiskIndex(inputs);
    assert.equal(summary.calculation.risk.value, recalculated.value);
    assert.equal(summary.calculation.risk.coverage, recalculated.coverage);
    assert.deepEqual(summary.calculation.risk.missing, recalculated.missing);
    const rankingInputs = {
      ...inputs,
      highRiskPer100: issueCiqCovered ? normalizations.highRiskPer100.rankingValue : null,
      overduePer100: normalizations.overduePer100.rankingValue,
      safetySignalsPer100: normalizations.safetySignalsPer100?.rankingValue ?? null,
    };
    const recalculatedRanking = calculateRiskIndex(rankingInputs);
    const hasLowSample = Object.values(normalizations).some((normalization) => normalization?.lowSample === true);
    const rankingEligible = summary.calculation.risk.ranking.cohort === "ciq-covered" && !hasLowSample && !recalculatedRanking.suppressed;
    assert.deepEqual(summary.calculation.risk.ranking.inputs, rankingInputs);
    assert.equal(summary.calculation.risk.ranking.eligible, rankingEligible);
    assert.equal(summary.calculation.risk.ranking.value, rankingEligible ? recalculatedRanking.value : null);
    assert.equal(summary.calculation.risk.ranking.coverage, recalculatedRanking.coverage);

    const recordById = new Map(records.map((record) => [recordIdentityKey(record), record]));
    for (const evidence of summary.risk.evidence ?? []) {
      const record = recordById.get(recordIdentityKey(evidence));
      assert.ok(record?.open, `${summary.project.id}/${evidence.id} must be open`);
      assert.ok(
        record && (isHigh(record) || isCriticalOverdue(record, data.asOf)),
        `${summary.project.id}/${evidence.id} must contribute to the displayed risk`,
      );
    }
    const completeEvidenceIds = new Set(summary.calculation.risk.evidenceRecords.map(recordIdentityKey));
    assert.ok((summary.risk.evidence ?? []).every((entry) => completeEvidenceIds.has(recordIdentityKey(entry))));
    assert.ok(summary.calculation.risk.evidenceRecordKeys.length >= (summary.risk.evidence?.length ?? 0));
    assert.ok(summary.calculation.risk.evidenceRecordKeys.every((key) => key.split("\u001f").length === 3));
  }
});

test("demo ranking separates comparable cohorts and visibly retains low-sample projects", () => {
  const data = generateDemoDataset();
  const eligible = data.projects.filter((project) => project.calculation.risk.ranking.eligible);
  const insufficient = data.projects.filter((project) => !project.calculation.risk.ranking.eligible);
  assert.ok(eligible.some((project) => project.calculation.risk.ranking.cohort === "ciq-covered"));
  assert.ok(data.projects.filter((project) => project.calculation.risk.ranking.cohort === "ciq-unavailable").every((project) =>
    !project.calculation.risk.ranking.eligible && project.calculation.risk.ranking.value === null
  ));
  assert.ok(insufficient.length > 0);
  assert.ok(insufficient.every((project) => project.calculation.risk.ranking.exclusionReason !== null));
});

test("company Construction IQ fixtures exercise observed, carried, and unavailable states", () => {
  const data = generateDemoDataset();
  assert.equal(data.companyCiqSignals.length, data.projects.length);
  assert.ok(data.companyCiqSignals.some((signal) => signal.quality && !signal.quality.forwardFilled));
  assert.ok(data.companyCiqSignals.some((signal) => signal.quality?.forwardFilled));
  assert.ok(data.companyCiqSignals.some((signal) => signal.safety));
  assert.ok(data.companyCiqSignals.some((signal) => signal.notApplicable));
  for (const signal of data.companyCiqSignals) {
    if (signal.quality) {
      assert.equal(signal.quality.provenance.valueKind, "autodesk-provided");
      assert.equal(signal.quality.provenance.sourceDataset, "iq_company_daily_quality_risk_changes");
    }
    if (signal.safety) {
      assert.equal(signal.safety.provenance.valueKind, "autodesk-provided");
      assert.equal(signal.safety.provenance.sourceDataset, "iq_company_daily_safety_risk_changes");
    }
    assert.equal(signal.notApplicable, !signal.quality && !signal.safety);
  }
});

test("lineage registry retains complete contributors for every registered metric", () => {
  const data = generateDemoDataset();
  const recordIds = new Set(data.records.map(recordIdentityKey));
  assert.equal(new Set(data.lineage.map((entry) => entry.id)).size, data.lineage.length);
  assert.ok(data.lineage.some((entry) => entry.category === "domain"));
  assert.ok(data.lineage.some((entry) => entry.category === "attention"));
  assert.ok(data.lineage.some((entry) => entry.category === "analytics"));
  assert.ok(data.lineage.some((entry) => entry.category === "form"));
  assert.ok(data.lineage.every((entry) => entry.provenance.definitionId.length > 0));
  assert.ok(data.lineage.every((entry) => entry.evidence.every((evidence) => recordIds.has(recordIdentityKey(evidence)))));

  const expectedPortfolioRisk = new Set(data.projects.flatMap((project) => project.calculation.risk.evidenceRecords).map(recordIdentityKey));
  assert.deepEqual(new Set(data.portfolioCalculation.risk.evidenceRecords.map(recordIdentityKey)), expectedPortfolioRisk);
  const portfolioLineage = data.lineage.find((entry) => entry.id === "portfolio:risk");
  assert.ok(portfolioLineage);
  assert.deepEqual(new Set(portfolioLineage.evidence.map(recordIdentityKey)), expectedPortfolioRisk);
});

test("company attribution always matches its canonical relationship", () => {
  const data = generateDemoDataset();
  const membershipCompany = new Map<string, string>();
  for (const record of data.records) {
    if (record.companyAttribution === "unattributed") {
      assert.equal(record.companyId, null, record.id);
      continue;
    }
    assert.ok(record.companyId, record.id);
    if (record.companyAttribution === "direct") {
      if (record.kind === "issue") {
        assert.equal(record.assigneeType, "company", record.id);
        assert.equal(record.assigneeId, record.companyId, record.id);
      }
      continue;
    }
    const userId = record.companyAttribution === "via-assignee-membership"
      ? record.assigneeId
      : record.ownerId;
    if (record.companyAttribution === "via-assignee-membership") {
      assert.equal(record.assigneeType, "user", record.id);
    }
    assert.ok(userId, record.id);
    const key = `${record.projectId}:${userId}`;
    const existing = membershipCompany.get(key);
    assert.ok(!existing || existing === record.companyId, `${record.id} conflicts with ${key}`);
    membershipCompany.set(key, record.companyId!);
  }
});

test("every domain summary is an auditable projection of that domain's records", () => {
  const data = generateDemoDataset();

  for (const summary of data.projects) {
    assert.equal(summary.domainSummaries.length, RISK_DOMAINS.length);
    const projectRecords = data.records.filter((record) => record.projectId === summary.project.id);
    for (const domain of summary.domainSummaries) {
      const records = projectRecords.filter((record) => record.domain === domain.domain);
      const open = records.filter((record) => record.open);
      const classified = open.filter((record) =>
        (record.kind === "issue" || record.kind === "rfi") &&
        ["critical", "high", "medium", "low"].includes(record.constructionIqRisk)
      );
      const overdue = open.filter((record) => isOverdue(record, data.asOf));
      const severityPoints = classified.reduce((sum, record) => {
        if (isHigh(record)) return sum + 1;
        if (record.constructionIqRisk === "medium") return sum + 0.6;
        return sum + 0.25;
      }, 0);

      assert.equal(domain.available, summary.project.availableDomains.includes(domain.domain));
      assert.equal(domain.highRiskOpen, open.filter(isHigh).length);
      assert.equal(domain.overdue, overdue.length);
      assert.equal(domain.calculation.openRecords, open.length);
      assert.equal(domain.calculation.classifiedOpenRecords, classified.length);
      assert.equal(domain.calculation.severityPoints, severityPoints);
      assert.equal(domain.calculation.overdueDenominatorRecords, open.length);
      assert.equal(domain.calculation.overdueRecords, overdue.length);
      const severityShare = classified.length ? severityPoints / classified.length : null;
      const overdueShare = open.length ? overdue.length / open.length : null;
      const expectedIndex = severityShare === null && overdueShare === null
        ? null
        : Math.round(1000 * (0.75 * (severityShare ?? 0) + 0.25 * (overdueShare ?? 0))) / 10;
      assert.equal(domain.calculation.currentIndex, expectedIndex);
      assert.equal(domain.calculation.coverage, (severityShare === null ? 0 : 0.75) + (overdueShare === null ? 0 : 0.25));
      for (const evidence of domain.evidence) {
        const record = records.find((candidate) => sameRecordIdentity(candidate, evidence));
        assert.ok(record?.open, `${summary.project.id}/${domain.domain}/${evidence.id} must be open`);
        assert.ok(record && open.includes(record), `${summary.project.id}/${domain.domain}/${evidence.id} must contribute to the open-record denominator`);
      }
      assert.deepEqual(new Set(domain.evidence.map(recordIdentityKey)), new Set(open.map(recordIdentityKey)));
    }
  }
});

test("project and portfolio trends cover the declared history and remain deterministic", () => {
  const first = generateDemoDataset();
  const second = generateDemoDataset();
  const expectedDays = Math.floor(
    (new Date(`${first.asOf.slice(0, 10)}T00:00:00.000Z`).getTime() -
      new Date(`${DEMO_COVERAGE_START}T00:00:00.000Z`).getTime()) / DAY_MS,
  ) + 1;

  assert.deepEqual(first, second);
  assert.equal(first.coverageStart, DEMO_COVERAGE_START);
  assert.equal(first.portfolioTrend.length, expectedDays);
  for (const project of first.projects) {
    assert.equal(project.trend.length, expectedDays, project.project.id);
    assert.equal(project.trend[0]?.date, DEMO_COVERAGE_START);
    assert.equal(project.trend.at(-1)?.date, first.asOf.slice(0, 10));
    assert.ok(project.trend.slice(-90).length === 90);
  }
});

test("synthetic location ids and paths are one-to-one", () => {
  const data = generateDemoDataset();
  const pathById = new Map<string, string>();
  const idByPath = new Map<string, string>();

  for (const record of data.records) {
    if (record.kind === "submittal") {
      assert.equal(record.locationId, null, `${record.id} must not invent a submittal location id`);
      assert.equal(record.locationPath, null, `${record.id} must not invent a submittal location path`);
      continue;
    }
    assert.ok(record.locationId);
    assert.ok(record.locationPath);
    const pathKey = `${record.projectId}\u0000${record.locationPath}`;
    const knownPath = pathById.get(record.locationId);
    const knownId = idByPath.get(pathKey);
    assert.ok(!knownPath || knownPath === record.locationPath, `${record.locationId} aliases multiple paths`);
    assert.ok(!knownId || knownId === record.locationId, `${pathKey} maps to multiple ids`);
    pathById.set(record.locationId, record.locationPath);
    idByPath.set(pathKey, record.locationId);
  }
});

test("form and review fixtures have source records, no CIQ sidecars, and derived form-signal counts", () => {
  const data = generateDemoDataset();
  const forms = data.records.filter((record) => record.kind === "form");
  const reviews = data.records.filter((record) => record.kind === "review");
  assert.ok(forms.length >= 3);
  assert.ok(reviews.length >= 3);

  for (const record of [...forms, ...reviews]) {
    assert.equal(record.constructionIqRisk, "none");
    assert.equal(record.iqCostImpact, "none");
    assert.equal(record.iqRootCauseModel, null);
    assert.equal(record.iqRootCause, null);
    assert.equal(record.buildingComponentModel, null);
    assert.equal(record.buildingComponent, null);
    assert.equal(record.iqSafetyRiskCategory, null);
    assert.equal(record.iqSafetyHazardCategory, null);
    assert.equal(record.iqSafetyObservationCategory, null);
    assert.equal(record.riskUserOverridden, false);
    assert.equal(record.raw?.risk, null);
    assert.equal(record.raw?.user_risk, null);
  }

  for (const signal of data.formSignals) {
    const matching = forms.filter((record) => formRecordMatchesSignal(record, signal));
    const current = matching.filter((record) => record.raw?.period_bucket === "current");
    const previous = matching.filter((record) => record.raw?.period_bucket === "previous");
    assert.equal(signal.inspections, current.length);
    assert.equal(
      signal.applicationDefinedExceptions,
      current.filter((record) => record.raw?.application_defined_exception === true).length,
    );
    assert.equal(
      signal.activityChange,
      previous.length ? Math.round((1_000 * (current.length - previous.length)) / previous.length) / 10 : 0,
    );
    assert.ok(signal.evidence.length > 0);
    assert.ok(signal.evidence.every((entry) => current.some((record) => sameRecordIdentity(record, entry))));
  }
});

test("same-name Form templates retain independent project/template/layout identities", () => {
  const data = generateDemoDataset();
  const duplicates = data.formSignals.filter((signal) =>
    signal.projectId === "project-harbor-point" && signal.templateName === "Building Envelope Inspection"
  );
  assert.equal(duplicates.length, 2);
  assert.equal(new Set(duplicates.map(formSignalIdentityKey)).size, 2);
  const evidenceSets = duplicates.map((signal) => {
    const matching = data.records.filter((record) => formRecordMatchesSignal(record, signal));
    const current = matching.filter((record) => record.raw?.period_bucket === "current");
    assert.equal(current.length, signal.inspections);
    assert.ok(matching.length > current.length);
    assert.ok(matching.every((record) =>
      record.raw?.template_id === signal.templateId && record.raw?.layout_uid === signal.layoutUid
    ));
    return new Set(matching.map(recordIdentityKey));
  });
  assert.ok([...evidenceSets[0]!].every((key) => !evidenceSets[1]!.has(key)));
  const lineage = data.lineage.filter((entry) => entry.category === "form" && entry.label === "Building Envelope Inspection activity");
  assert.equal(lineage.length, 2);
  assert.equal(new Set(lineage.map((entry) => entry.id)).size, 2);
});

test("portfolio means, counts, evidence, and provenance describe the same population", () => {
  const data = generateDemoDataset();
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const high = data.records.filter((record) => record.open && isHigh(record));
  const criticalOverdue = data.records.filter((record) => record.open && isCriticalOverdue(record, data.asOf));

  assert.equal(data.portfolio.risk.value.index, mean(data.projects.map((project) => project.risk.value.index).filter((value): value is number => value !== null)));
  assert.equal(data.portfolio.exposure.value.index, mean(data.projects.map((project) => project.exposure.value.index).filter((value): value is number => value !== null)));
  assert.equal(data.portfolio.risk.value.highRiskOpen, high.length);
  assert.equal(data.portfolio.risk.value.criticalOverdue, criticalOverdue.length);
  assert.equal(data.portfolio.risk.provenance.definitionId, "risk.portfolio.mean-project-index");
  assert.equal(data.portfolio.exposure.provenance.definitionId, "exposure.portfolio.mean-project-index");
  assert.deepEqual(
    data.portfolioCalculation.risk.inputs.projectIndexes,
    data.projects.flatMap((project) => project.risk.value.index === null ? [] : [{ projectId: project.project.id, value: project.risk.value.index }]),
  );
  const recordById = new Map(data.records.map((record) => [recordIdentityKey(record), record]));
  for (const evidence of data.portfolio.risk.evidence ?? []) {
    const record = recordById.get(recordIdentityKey(evidence));
    assert.ok(record?.open);
    assert.ok(record && (isHigh(record) || isCriticalOverdue(record, data.asOf)));
  }
});

test("synthetic CIQ and RFI evidence is limited to source-supported record kinds", () => {
  const data = generateDemoDataset();
  const records = new Map(data.records.map((record) => [recordIdentityKey(record), record]));
  assert.notDeepEqual(data.ciqSourceCoverage.issueQualityProjectIds, data.ciqSourceCoverage.rfiRiskProjectIds);
  assert.notDeepEqual(data.ciqSourceCoverage.rfiRiskProjectIds, data.ciqSourceCoverage.rfiCauseProjectIds);
  assert.notDeepEqual(data.ciqSourceCoverage.issueSafetyRiskProjectIds, data.ciqSourceCoverage.issueSafetyHazardProjectIds);
  assert.notDeepEqual(data.ciqSourceCoverage.issueSafetyHazardProjectIds, data.ciqSourceCoverage.issueSafetyObservationProjectIds);
  assert.deepEqual(
    new Set(data.ciqSourceCoverage.issueSafetyProjectIds),
    new Set([
      ...data.ciqSourceCoverage.issueSafetyRiskProjectIds,
      ...data.ciqSourceCoverage.issueSafetyHazardProjectIds,
      ...data.ciqSourceCoverage.issueSafetyObservationProjectIds,
    ]),
  );

  for (const record of data.records) {
    if (record.kind !== "issue" && record.kind !== "rfi") {
      assert.equal(record.constructionIqRisk, "none");
      assert.equal(record.iqRootCause, null);
    }
    if (record.kind !== "issue") assert.equal(record.iqCostImpact, "none");
    if (record.kind !== "rfi") {
      assert.equal(record.raw?.cost_impact, null);
      assert.equal(record.raw?.schedule_impact, null);
      assert.equal(record.raw?.priority, null);
      assert.equal(record.raw?.score, null);
    }
  }

  for (const project of data.projects) {
    const projectRecords = data.records.filter((record) => record.projectId === project.project.id);
    if (!data.ciqSourceCoverage.issueQualityProjectIds.includes(project.project.id)) {
      assert.ok(projectRecords.filter((record) => record.kind === "issue").every((record) =>
        record.constructionIqRisk === "none" && record.iqCostImpact === "none" && record.iqRootCause === null
      ));
    }
    if (!data.ciqSourceCoverage.rfiRiskProjectIds.includes(project.project.id)) {
      assert.ok(projectRecords.filter((record) => record.kind === "rfi").every((record) => record.constructionIqRisk === "none"));
    }
    if (!data.ciqSourceCoverage.rfiCauseProjectIds.includes(project.project.id)) {
      assert.ok(projectRecords.filter((record) => record.kind === "rfi").every((record) => record.iqRootCause === null));
    }
    if (!data.ciqSourceCoverage.issueSafetyObservationProjectIds.includes(project.project.id)) {
      assert.ok(projectRecords.every((record) => record.iqSafetyObservationCategory === null));
    }
    if (!data.ciqSourceCoverage.issueSafetyRiskProjectIds.includes(project.project.id)) {
      assert.ok(projectRecords.every((record) => record.iqSafetyRiskCategory === null));
    }
  }

  for (const item of data.attention) {
    const record = records.get(recordIdentityKey(item.evidence[0]!))!;
    const codes = new Set(item.reasons.map((reason) => reason.code));
    if (codes.has("CIQ_QUALITY_HIGH") || codes.has("CIQ_QUALITY_MEDIUM") || codes.has("CIQ_COST_IMPACT_HIGH") || codes.has("CIQ_COST_IMPACT_MEDIUM")) {
      assert.equal(record.kind, "issue");
    }
    if ([...codes].some((code) => code.startsWith("CIQ_RFI") || ["RFI_COST_IMPACT_YES", "RFI_COST_IMPACT_UNKNOWN", "RFI_SCHEDULE_IMPACT_YES", "RFI_SCHEDULE_IMPACT_UNKNOWN", "RFI_PRIORITY_HIGH"].includes(code))) {
      assert.equal(record.kind, "rfi");
    }
  }
});

test("every demo relationship, hotspot, and recurrence reason has matching evidence", () => {
  const data = generateDemoDataset();
  const records = new Map(data.records.map((record) => [recordIdentityKey(record), record]));

  for (const item of data.attention) {
    const record = records.get(recordIdentityKey(item.evidence[0]!))!;
    const codes = new Set(item.reasons.map((reason) => reason.code));
    const incident = data.relationships.filter((edge) => edge.confidence === "confirmed" && (sameRecordIdentity(edge.from, record) || sameRecordIdentity(edge.to, record)));
    const otherFor = (edge: (typeof incident)[number]) => sameRecordIdentity(edge.from, record) ? edge.to : edge.from;

    if (codes.has("CLASH_LINKED")) assert.ok(incident.some((edge) => edge.method === "clash-group-issue-id"));
    if (codes.has("SCHEDULE_LINKED")) assert.ok(incident.some((edge) => otherFor(edge).kind === "schedule-activity"));
    if (codes.has("CRITICAL_PATH_LINKED")) {
      assert.ok(incident.some((edge) => {
        const other = otherFor(edge);
        const activity = records.get(recordIdentityKey(other));
        return other.kind === "schedule-activity" &&
          (activity?.raw?.is_critical_path === true || activity?.raw?.is_critical === true);
      }));
    }
    if (codes.has("COST_EDGE")) assert.ok(incident.some((edge) => otherFor(edge).kind === "change-order"));
    if (codes.has("RFI_EDGE")) assert.ok(incident.some((edge) => new Set([edge.from.kind, edge.to.kind]).has("rfi") && new Set([edge.from.kind, edge.to.kind]).has("issue")));
    if (codes.has("USER_CREATED_EDGE_BONUS")) assert.ok(incident.some((edge) => !edge.serviceOwned));
    if (codes.has("HOTSPOT_MEMBER")) assert.ok(data.hotspots.some((hotspot) => hotspot.domains.length >= 2 && hotspot.evidence.some((entry) => sameRecordIdentity(entry, record))));
    if (codes.has("RECURRING_SIGNATURE")) assert.ok(data.recurrence.some((group) => group.occurrences >= 3 && group.evidence.some((entry) => sameRecordIdentity(entry, record))));
  }
});

test("demo relationships exercise confirmed, inferred, and explicitly excluded candidates", () => {
  const data = generateDemoDataset();
  assert.ok(data.relationships.some((edge) => edge.confidence === "confirmed"));
  assert.ok(data.relationships.some((edge) => edge.confidence === "inferred" && edge.method.startsWith("shared-")));
  assert.ok(data.relationships.some((edge) => edge.confidence === "none" && edge.evidence.includes("no relationship is asserted")));
});

test("human CIQ overrides preserve the model prediction and expose the effective value", () => {
  const data = generateDemoDataset();
  const overridden = data.records.filter((record) => record.riskUserOverridden);
  assert.ok(overridden.length > 0);
  for (const record of overridden) {
    assert.equal(record.kind, "issue");
    assert.equal(record.raw?.risk, "high");
    assert.equal(record.raw?.user_risk, "low");
    assert.equal(record.constructionIqRisk, "low");
  }
});

test("canonical cause/component overrides, RFI categories, and actor labels retain source semantics", () => {
  const data = generateDemoDataset();
  const rootOverrides = data.records.filter((record) => record.iqRootCauseUserOverridden);
  const componentOverrides = data.records.filter((record) => record.buildingComponentUserOverridden);
  assert.ok(rootOverrides.length > 0);
  assert.ok(componentOverrides.length > 0);
  for (const record of rootOverrides) {
    assert.equal(record.kind, "issue");
    assert.equal(record.iqRootCauseModel, record.raw?.root_cause);
    assert.equal(record.iqRootCause, record.raw?.user_root_cause);
  }
  assert.ok(rootOverrides.some((record) => record.iqRootCause !== record.iqRootCauseModel));
  for (const record of componentOverrides) {
    assert.equal(record.kind, "issue");
    assert.equal(record.buildingComponentModel, record.raw?.building_component);
    assert.equal(record.buildingComponent, record.raw?.user_building_component);
  }
  const rfis = data.records.filter((record) => record.kind === "rfi");
  assert.ok(rfis.length > 0);
  assert.ok(rfis.every((record) => record.rfiCategory && record.rfiCategory === record.rfiCategory.trim()));
  assert.ok(data.records.every((record) => record.assigneeId === null || Boolean(record.assigneeName?.trim())));
  assert.ok(data.records.every((record) => record.ownerId === null || Boolean(record.ownerName?.trim())));
});

test("exposure counts use documented cost categories and distinct eligible risks on confirmed schedule edges", () => {
  const data = generateDemoDataset();
  const confirmed = data.records.filter((record) => record.open && ((record.kind === "rfi" && record.costImpact === "yes") || (record.kind === "issue" && record.iqCostImpact === "high"))).length;
  const potential = data.records.filter((record) => record.open && ((record.kind === "rfi" && record.costImpact === "unknown") || (record.kind === "issue" && record.iqCostImpact === "medium"))).length;
  const schedule = scheduleExposureFromRecords(data.records, data.relationships);
  assert.equal(data.portfolio.exposure.value.confirmedCostImpact, confirmed);
  assert.equal(data.portfolio.exposure.value.potentialCostExposure, potential);
  assert.equal(data.portfolio.exposure.value.unquantifiedCostImpact, confirmed + potential);
  assert.equal(data.portfolio.exposure.value.scheduleLinkedItems, schedule.scheduleLinkedRiskRecords.length);
  assert.equal(data.portfolio.exposure.value.criticalPathLinkedItems, schedule.criticalPathLinkedRiskRecords.length);
});
