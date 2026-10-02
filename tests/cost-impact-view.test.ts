import assert from "node:assert/strict";
import test from "node:test";
import type { RiskRecord } from "../src/lib/canonical/types";
import { generateDemoDataset } from "../src/lib/demo/generator";
import { buildCostImpactRiskView, costImpactCategoryForRecord } from "../src/lib/risk/cost-impact-view";

const base = generateDemoDataset().records[0]!;
function record(id: string, overrides: Partial<RiskRecord>): RiskRecord {
  return { ...base, id, projectId: "project-cost-test", kind: "issue", open: true, status: "open", costImpact: "unknown", iqCostImpact: "none", ...overrides };
}

test("cost-impact categories preserve source semantics and partition the classifiable population", () => {
  const records = [
    record("rfi-yes", { kind: "rfi", costImpact: "yes" }),
    record("issue-high", { iqCostImpact: "high" }),
    record("rfi-unknown", { kind: "rfi", costImpact: "unknown" }),
    record("issue-medium", { iqCostImpact: "medium" }),
    record("rfi-no", { kind: "rfi", costImpact: "no" }),
    record("issue-low", { iqCostImpact: "low" }),
    record("rfi-null", { kind: "rfi", costImpact: null }),
    record("issue-none", { iqCostImpact: "none" }),
    record("rfi-unmapped", { kind: "rfi", costImpact: "unmapped" }),
    record("issue-unmapped", { iqCostImpact: "unmapped" }),
    record("closed", { iqCostImpact: "high", open: false, status: "closed" }),
    record("form", { kind: "form" }),
  ];
  assert.equal(costImpactCategoryForRecord(records[0]!), "confirmed");
  assert.equal(costImpactCategoryForRecord(records[2]!), "potential");
  assert.equal(costImpactCategoryForRecord(records[4]!), "explicit-negative");
  assert.equal(costImpactCategoryForRecord(records[6]!), "unclassified");
  assert.equal(costImpactCategoryForRecord(records[8]!), "unmapped");
  assert.equal(costImpactCategoryForRecord(records[10]!), null);
  assert.equal(costImpactCategoryForRecord(records[11]!), null);

  const model = buildCostImpactRiskView(records, { asOf: "2026-09-09T00:00:00.000Z", sourceSystem: "demo-generator" });
  assert.equal(model.state, "available");
  assert.equal(model.denominator, 10);
  assert.equal(model.excludedRecordCount, 2);
  assert.deepEqual(model.buckets.map((bucket) => bucket.count), [2, 2, 2, 2, 2]);
  assert.ok(Math.abs(model.buckets.reduce((sum, bucket) => sum + (bucket.share ?? 0), 0) - 100) <= 0.2);
  assert.equal(model.unquantifiedSignalCount, 4);
  assert.equal(model.rfiUnknownCount, 1);
  const identities = model.buckets.flatMap((bucket) => bucket.contributors.map((item) => item.identityKey));
  assert.equal(new Set(identities).size, identities.length);
  assert.equal(model.provenance.valueKind, "application-derived");
});

test("cost-impact view distinguishes empty, unavailable, and malformed time", () => {
  const empty = buildCostImpactRiskView([], { asOf: "2026-09-09T00:00:00.000Z" });
  assert.equal(empty.state, "empty");
  const unavailable = buildCostImpactRiskView([], { asOf: "2026-09-09T00:00:00.000Z", sourceAvailable: false, unavailableReason: "permission gap" });
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.unavailableReason, "permission gap");
  assert.throws(() => buildCostImpactRiskView([], { asOf: "not-a-date" }), RangeError);
});
