import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceRef, RiskRelationship, SourceRecordKind } from "../src/lib/canonical/types";
import { buildRelationshipConversionEvidence, RELATIONSHIP_CONVERSION_CAPTION, relationshipOwnershipLabel, selectAuthorizedRelationships, selectCanonicalRelationships } from "../src/lib/risk/relationship-conversion-evidence";
import { derivedProvenance } from "../src/lib/risk/provenance";

function ref(id: string, kind: SourceRecordKind): EvidenceRef {
  return { id, kind, projectId: "project-relationship-test", label: `${kind} ${id}` };
}

function edge(id: string, from: EvidenceRef, to: EvidenceRef, overrides: Partial<RiskRelationship> = {}): RiskRelationship {
  return { id, projectId: "project-relationship-test", from, to, confidence: "confirmed", method: "acc-relationship-service", evidence: "Stored link", serviceOwned: true, createdAt: "2026-09-01T00:00:00.000Z", snapshotDate: "2026-09-09", deletedAt: null, algorithmVersion: "risk-config-v1", provenance: derivedProvenance({ timestamp: "2026-09-09T00:00:00.000Z", definitionId: "relationship.test" }), ...overrides };
}

test("relationship conversion evidence deduplicates undirected pairs and never invents conversion", () => {
  const issue = ref("issue", "issue");
  const rfi = ref("rfi", "rfi");
  const change = ref("change", "change-order");
  const schedule = ref("schedule", "schedule-activity");
  const clash = ref("clash", "clash-group");
  const relationships = [
    edge("issue-rfi", issue, rfi, { createdAt: "2026-09-03T00:00:00.000Z" }),
    edge("mirrored", rfi, issue, { createdAt: "2026-09-04T00:00:00.000Z" }),
    edge("issue-change", issue, change, { serviceOwned: false, createdAt: "2026-09-02T00:00:00.000Z" }),
    edge("rfi-change", rfi, change, { confidence: "inferred", serviceOwned: false, createdAt: null }),
    edge("schedule", issue, schedule, { createdAt: "invalid" }),
    edge("other", clash, issue, { createdAt: "2026-09-01T00:00:00.000Z" }),
    edge("none", ref("other-rfi", "rfi"), issue, { confidence: "none" }),
  ];
  const records = [
    { projectId: issue.projectId, kind: issue.kind, id: issue.id, domain: "design" as const },
  ];
  const model = buildRelationshipConversionEvidence(relationships, { minimumEdgeCount: 2, records });
  assert.deepEqual(model.stages.map((stage) => stage.rawEdgeCount), [1, 0, 1, 1, null, 1]);
  assert.ok(model.stages.every((stage) => stage.conversionRate === null));
  assert.equal(model.stages[0]!.coverageState, "insufficient-data");
  assert.equal(model.stages[4]!.coverageState, "unsupported");
  assert.equal(model.unclassifiedEdgeCount, 1);
  assert.equal(model.noRelationshipCandidateCount, 1);
  assert.equal(model.caption, RELATIONSHIP_CONVERSION_CAPTION);
  assert.deepEqual(model.contributors.map((item) => item.edge.id), ["issue-change", "issue-rfi", "rfi-change", "schedule"]);
  assert.equal(model.contributors.at(-1)!.recordedAt, null);
  assert.equal(relationshipOwnershipLabel(relationships[0]!), "System-created ACC link");
  assert.equal(relationshipOwnershipLabel(relationships[2]!), "User-created ACC link");
  assert.equal(relationshipOwnershipLabel(relationships[3]!), "Application-inferred association; creator not recorded");
});

test("relationship dedup deterministically prefers confirmed source evidence", () => {
  const issue = ref("issue-precedence", "issue");
  const rfi = ref("rfi-precedence", "rfi");
  const inferred = edge("z-inferred", issue, rfi, { confidence: "inferred", method: "shared-location-window", serviceOwned: false });
  const confirmed = edge("a-confirmed", rfi, issue, { confidence: "confirmed", method: "acc-relationship-service", serviceOwned: false });
  for (const input of [[inferred, confirmed], [confirmed, inferred]]) {
    const result = buildRelationshipConversionEvidence(input, { minimumEdgeCount: 1, records: [{ projectId: issue.projectId, kind: issue.kind, id: issue.id, domain: "quality" }] });
    assert.equal(result.contributors.length, 1);
    assert.equal(result.contributors[0]!.edge.id, "a-confirmed");
    assert.equal(result.contributors[0]!.ownershipLabel, "User-created ACC link");
  }
});

test("relationship coverage exposes zero/minimum states and validates its threshold", () => {
  const empty = buildRelationshipConversionEvidence([], { minimumEdgeCount: 1 });
  assert.ok(empty.stages.filter((stage) => stage.id !== "rework").every((stage) => stage.coverageState === "no-links-recorded"));
  const issue = ref("one", "issue");
  const rfi = ref("two", "rfi");
  const enough = buildRelationshipConversionEvidence([edge("one", issue, rfi)], { minimumEdgeCount: 1, records: [{ projectId: issue.projectId, kind: issue.kind, id: issue.id, domain: "quality" }] });
  assert.equal(enough.stages[1]!.coverageState, "minimum-met");
  assert.throws(() => buildRelationshipConversionEvidence([], { minimumEdgeCount: 0 }), RangeError);
  assert.throws(() => buildRelationshipConversionEvidence([], { minimumEdgeCount: 1.5 }), RangeError);
});

test("relationship selection keeps the latest as-of version and honors soft deletion", () => {
  const issue = ref("versioned-issue", "issue");
  const rfi = ref("versioned-rfi", "rfi");
  const live = edge("versioned", issue, rfi, { snapshotDate: "2026-09-01" });
  const deleted = edge("versioned", issue, rfi, { snapshotDate: "2026-09-08", deletedAt: "2026-09-08T00:00:00.000Z" });
  assert.deepEqual(selectCanonicalRelationships([deleted, live], { asOf: "2026-09-05T00:00:00.000Z" }).map((item) => item.snapshotDate), ["2026-09-01"]);
  assert.equal(selectCanonicalRelationships([live, deleted], { asOf: "2026-09-09T00:00:00.000Z" }).length, 0);
});

test("relationship algorithm selection is explicit and input-order independent", () => {
  const issue = ref("algorithm-issue", "issue");
  const rfi = ref("algorithm-rfi", "rfi");
  const v1 = edge("algorithm-edge", issue, rfi, { algorithmVersion: "v1" });
  const v2 = edge("algorithm-edge", issue, rfi, { algorithmVersion: "v2", evidence: "new rule" });
  for (const input of [[v1, v2], [v2, v1]]) {
    assert.equal(selectCanonicalRelationships(input)[0]!.algorithmVersion, "v2");
    assert.equal(selectCanonicalRelationships(input, { algorithmVersion: "v1" })[0]!.algorithmVersion, "v1");
  }
});

test("relationship authorization drops dangling counterparties without exposing their identity", () => {
  const visibleIssue = ref("visible-issue", "issue");
  const visibleRfi = ref("visible-rfi", "rfi");
  const hiddenRfi = ref("hidden-rfi", "rfi");
  const result = selectAuthorizedRelationships(
    [edge("visible-pair", visibleIssue, visibleRfi), edge("dangling-pair", visibleIssue, hiddenRfi)],
    [visibleIssue, visibleRfi],
  );

  assert.deepEqual(result.relationships.map((item) => item.id), ["visible-pair"]);
  assert.equal(result.excludedDanglingCount, 1);
  assert.equal(JSON.stringify(result).includes(hiddenRfi.id), false);
});
