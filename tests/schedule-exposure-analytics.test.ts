import assert from "node:assert/strict";
import test from "node:test";
import { recordIdentityKey, type EvidenceRef, type RiskRecord, type RiskRelationship, type Severity } from "../src/lib/canonical/types";
import { generateDemoDataset } from "../src/lib/demo/generator";
import { scheduleExposureFromRecords } from "../src/lib/risk/analytics";
import { derivedProvenance } from "../src/lib/risk/provenance";

function record(id: string, kind: RiskRecord["kind"], severity: Severity, overrides: Partial<RiskRecord> = {}): RiskRecord {
  const base = generateDemoDataset().records[0]!;
  return {
    ...base,
    id,
    projectId: "project-schedule-test",
    kind,
    open: true,
    status: "open",
    constructionIqModelRisk: severity,
    constructionIqRisk: severity,
    raw: {},
    ...overrides,
  };
}

function ref(value: RiskRecord): EvidenceRef {
  return {
    id: value.id,
    kind: value.kind,
    projectId: value.projectId,
    label: value.title,
  };
}

function edge(id: string, from: RiskRecord, to: RiskRecord, confidence: RiskRelationship["confidence"] = "confirmed"): RiskRelationship {
  return {
    id,
    projectId: from.projectId,
    from: ref(from),
    to: ref(to),
    confidence,
    method: "acc-relationship-service",
    evidence: "Test relationship",
    serviceOwned: true,
    createdAt: null,
    snapshotDate: "2026-09-09",
    deletedAt: null,
    algorithmVersion: "risk-config-v1",
    provenance: derivedProvenance({ timestamp: "2026-09-09T00:00:00.000Z", definitionId: "relationship.test" }),
  };
}

test("schedule exposure counts distinct eligible risks while preserving raw confirmed edge volume", () => {
  const high = record("high", "issue", "high");
  const medium = record("medium", "rfi", "medium");
  const closedHigh = record("closed-high", "issue", "high", { open: false, status: "closed" });
  const unclassified = record("unclassified", "issue", "none");
  const inferredOnly = record("inferred-only", "issue", "high");
  const syntheticCritical = record("synthetic-critical", "schedule-activity", "none", { raw: { is_critical: true } });
  const sourceCritical = record("source-critical", "schedule-activity", "none", { raw: { is_critical_path: true } });
  const nonCritical = record("non-critical", "schedule-activity", "none");
  const records = [high, medium, closedHigh, unclassified, inferredOnly, syntheticCritical, sourceCritical, nonCritical];
  const relationships = [
    edge("duplicate-a", high, syntheticCritical),
    edge("duplicate-b", high, syntheticCritical),
    edge("medium-critical", sourceCritical, medium),
    edge("medium-non-critical", medium, nonCritical),
    edge("closed", closedHigh, syntheticCritical),
    edge("unclassified", unclassified, syntheticCritical),
    edge("inferred", inferredOnly, syntheticCritical, "inferred"),
  ];

  const result = scheduleExposureFromRecords(records, relationships);

  assert.deepEqual(result.eligibleRiskRecords.map(recordIdentityKey), [high, medium, inferredOnly].map(recordIdentityKey));
  assert.deepEqual(result.scheduleLinkedRiskRecords.map(recordIdentityKey), [high, medium].map(recordIdentityKey));
  assert.deepEqual(result.criticalPathLinkedRiskRecords.map(recordIdentityKey), [high, medium].map(recordIdentityKey));
  assert.equal(result.confirmedScheduleEdgeCount, 6);
});

test("a critical-path edge cannot promote a closed or unclassified endpoint into exposure", () => {
  const openMedium = record("open-medium", "issue", "medium");
  const closedMedium = record("closed-medium", "issue", "medium", { open: false, status: "closed" });
  const unmapped = record("unmapped", "rfi", "unmapped");
  const schedule = record("critical-path", "schedule-activity", "none", { raw: { is_critical_path: true } });
  const result = scheduleExposureFromRecords(
    [openMedium, closedMedium, unmapped, schedule],
    [edge("open", schedule, openMedium), edge("closed", schedule, closedMedium), edge("unmapped", schedule, unmapped)],
  );

  assert.deepEqual(result.scheduleLinkedRiskRecords.map(recordIdentityKey), [recordIdentityKey(openMedium)]);
  assert.deepEqual(result.criticalPathLinkedRiskRecords.map(recordIdentityKey), [recordIdentityKey(openMedium)]);
  assert.equal(result.confirmedScheduleEdgeCount, 3);
});

test("a CIQ-like value on an unsupported kind cannot enter schedule exposure", () => {
  const impossibleForm = record("impossible-form", "form", "high");
  const schedule = record("critical-path", "schedule-activity", "none", { raw: { is_critical_path: true } });
  const result = scheduleExposureFromRecords(
    [impossibleForm, schedule],
    [edge("unsupported", impossibleForm, schedule)],
  );
  assert.deepEqual(result.eligibleRiskRecords, []);
  assert.deepEqual(result.scheduleLinkedRiskRecords, []);
  assert.deepEqual(result.criticalPathLinkedRiskRecords, []);
  assert.equal(result.confirmedScheduleEdgeCount, 1, "raw edge volume remains a separate coverage disclosure");
});
