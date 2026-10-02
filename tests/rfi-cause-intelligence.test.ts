import assert from "node:assert/strict";
import test from "node:test";
import type { RiskRecord } from "../src/lib/canonical/types";
import { generateDemoDataset } from "../src/lib/demo/generator";
import { ALL_RFI_CAUSE_SOURCES_AVAILABLE, buildRfiCauseIntelligence, operationalRfiCause, rfiCauseIdentityKey, rfiCauseSourceAvailabilityForProjects } from "../src/lib/risk/rfi-cause-intelligence";

const base = generateDemoDataset().records[0]!;
function rfi(id: string, projectId: string, overrides: Partial<RiskRecord> = {}): RiskRecord {
  return { ...base, id, projectId, kind: "rfi", domain: "rfi", title: id, displayId: id, open: true, status: "open", createdAt: "2026-08-01T00:00:00.000Z", respondedAt: null, rfiCategory: null, iqRootCause: null, discipline: null, disciplineOrigin: null, companyId: null, raw: {}, ...overrides };
}

test("RFI cause intelligence keeps CIQ and project-configured origins separate", () => {
  const records = [
    rfi("a", "p1", { iqRootCause: "Design Coordination", rfiCategory: "Design Coordination", raw: { category: "Conflicting raw value" }, companyId: "c1", discipline: "Mechanical", disciplineOrigin: "construction-iq", respondedAt: "2026-08-06T00:00:00.000Z" }),
    rfi("b", "p1", { iqRootCause: "Design Coordination", rfiCategory: "Design Coordination", raw: { category_name: "Conflicting raw value" }, companyId: "c2", createdAt: "2026-08-10T00:00:00.000Z" }),
    rfi("c", "p2", { iqRootCause: "Design Coordination", rfiCategory: "Design Coordination", raw: { category: "Conflicting raw value" }, companyId: "c1", createdAt: "2026-08-20T00:00:00.000Z" }),
    rfi("d", "p2", { iqRootCause: null, raw: {} }),
    { ...base, id: "issue", kind: "issue" as const, iqRootCause: "Design Coordination" },
  ];
  const result = buildRfiCauseIntelligence({ records, asOf: "2026-09-09T00:00:00.000Z", sourceSystem: "demo-generator", projectLabels: { p1: "Project One", p2: "Project Two" }, sourceAvailability: ALL_RFI_CAUSE_SOURCES_AVAILABLE });
  assert.equal(result.totalRfis, 4);
  assert.equal(result.ciqAttributed, 3);
  assert.equal(result.ciqUnattributed, 1);
  assert.equal(result.operationalAttributed, 3);
  const ciq = result.groups.find((group) => group.origin === "construction-iq-predicted")!;
  assert.equal(ciq.count, 3);
  assert.equal(ciq.projectsAffected, 2);
  assert.equal(ciq.companiesAffected, 2);
  assert.equal(ciq.recurrence.repeatedEvents, 2);
  assert.equal(ciq.recurrence.occurrencesWithinWindow, 3);
  assert.equal(ciq.recurrence.populationRate, null);
  assert.equal(ciq.recurrence.populationDistinctSignatures, 1);
  assert.ok(ciq.recurrence.suppressedReason);
  assert.equal(ciq.responseDuration.median, 5);
  const operational = result.groups.filter((group) => group.origin === "operational-category");
  assert.equal(operational.length, 2);
  assert.ok(operational.every((group) => group.projectId !== null));
  assert.notEqual(ciq.key, operational[0]!.key);
  assert.notEqual(operational[0]!.key, operational[1]!.key);
  assert.equal(operationalRfiCause(records[0]!), "Design Coordination");
  assert.throws(() => rfiCauseIdentityKey("operational-category", "Design Coordination"), RangeError);
});

test("RFI recurrence uses the full origin population and requires eight distinct signatures", () => {
  const labels = ["A", "A", "B", "C", "D", "E", "F", "G", "H"];
  const records = labels.map((label, index) => rfi(`population-${index}`, "p1", { iqRootCause: label }));
  const result = buildRfiCauseIntelligence({ records, asOf: "2026-09-09T00:00:00.000Z", sourceAvailability: ALL_RFI_CAUSE_SOURCES_AVAILABLE });
  const population = result.recurrencePopulations.find((item) => item.origin === "construction-iq-predicted")!;
  assert.equal(population.totalRelevant, 9);
  assert.equal(population.distinctSignatures, 8);
  assert.equal(population.repeatedEvents, 1);
  assert.equal(population.rate, 1 / 9);
  assert.equal(population.suppressedReason, null);
  const groupA = result.groups.find((group) => group.origin === "construction-iq-predicted" && group.label === "A")!;
  assert.equal(groupA.recurrence.repeatedEvents, 1);
  assert.equal(groupA.recurrence.populationRate, 1 / 9);
});

test("RFI cause intelligence reports empty and rejects an invalid as-of timestamp", () => {
  const empty = buildRfiCauseIntelligence({ records: [], asOf: "2026-09-09T00:00:00.000Z", sourceAvailability: ALL_RFI_CAUSE_SOURCES_AVAILABLE });
  assert.equal(empty.state, "empty");
  assert.equal(empty.groups.length, 0);
  assert.throws(() => buildRfiCauseIntelligence({ records: [], asOf: "bad", sourceAvailability: ALL_RFI_CAUSE_SOURCES_AVAILABLE }), RangeError);
});

test("RFI cause intelligence separates an unavailable source from null cause values", () => {
  const records = [rfi("source-unavailable", "p1", { iqRootCause: "Envelope", rfiCategory: "Coordination", raw: { category: "Conflicting raw value" } })];
  const result = buildRfiCauseIntelligence({
    records,
    asOf: "2026-09-09T00:00:00.000Z",
    sourceAvailability: {
      "construction-iq-predicted": { available: false, reason: "CIQ extract not delivered" },
      "operational-category": { available: true },
    },
  });
  const ciq = result.sourceCoverage.find((source) => source.origin === "construction-iq-predicted")!;
  assert.deepEqual(ciq, {
    origin: "construction-iq-predicted",
    available: false,
    unavailableReason: "CIQ extract not delivered",
    attributed: null,
    unattributed: null,
    eligibleRfis: null,
    coveredProjects: null,
    scopeProjects: null,
  });
  assert.equal(result.ciqAttributed, null);
  assert.equal(result.ciqUnattributed, null);
  assert.equal(result.groups.some((group) => group.origin === "construction-iq-predicted"), false);
  assert.equal(result.operationalAttributed, 1);
});

test("partial RFI CIQ coverage uses only covered projects in its denominator", () => {
  const records = [
    rfi("covered", "p1", { iqRootCause: "Envelope", rfiCategory: "Coordination" }),
    rfi("uncovered", "p2", { iqRootCause: "Should not be visible", rfiCategory: "Coordination" }),
  ];
  const result = buildRfiCauseIntelligence({
    records,
    asOf: "2026-09-09T00:00:00.000Z",
    sourceAvailability: rfiCauseSourceAvailabilityForProjects(["p1", "p2"], ["p1"]),
  });
  const ciq = result.sourceCoverage.find((source) => source.origin === "construction-iq-predicted")!;
  const operational = result.sourceCoverage.find((source) => source.origin === "operational-category")!;
  assert.deepEqual(
    {
      available: ciq.available,
      attributed: ciq.attributed,
      unattributed: ciq.unattributed,
      eligibleRfis: ciq.eligibleRfis,
      coveredProjects: ciq.coveredProjects,
      scopeProjects: ciq.scopeProjects,
    },
    { available: true, attributed: 1, unattributed: 0, eligibleRfis: 1, coveredProjects: 1, scopeProjects: 2 },
  );
  assert.equal(result.groups.some((group) =>
    group.origin === "construction-iq-predicted" && group.contributors.some((item) => item.projectId === "p2")
  ), false);
  assert.equal(operational.eligibleRfis, 2);
  assert.equal(result.operationalAttributed, 2);

  const unavailable = buildRfiCauseIntelligence({
    records: [records[1]!],
    asOf: "2026-09-09T00:00:00.000Z",
    sourceAvailability: rfiCauseSourceAvailabilityForProjects(["p2"], ["p1"]),
  });
  assert.equal(unavailable.ciqAttributed, null);
  assert.equal(unavailable.sourceCoverage.find((source) => source.origin === "construction-iq-predicted")?.available, false);
});
