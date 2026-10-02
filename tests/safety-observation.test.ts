import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalUtcTimestamp,
  safetyObservationCategoryFromConstructionIq,
  safetyRiskCategoryFromConstructionIq,
  trimmedCanonicalText,
} from "../src/lib/canonical/types";
import { generateDemoDataset } from "../src/lib/demo/generator";
import { buildSafetyObservationBalance, safetyObservationSourceAvailabilityForProjects } from "../src/lib/risk/safety-observation";

test("safety observation balance keeps positive and negative evidence together", () => {
  const data = generateDemoDataset();
  const balance = buildSafetyObservationBalance(data.records, data.asOf);
  assert.ok(balance.positive > 0);
  assert.ok(balance.negative > 0);
  assert.equal(balance.classified, balance.positive + balance.negative);
  assert.equal(balance.evidence.length, balance.classified);
  assert.equal(balance.provenance.definitionId, "safety.observation-balance");
  assert.equal(balance.provenance.valueKind, "application-derived");
  assert.equal(balance.positiveShare, balance.classified >= 20 ? balance.positive / balance.classified : null);
  assert.ok(balance.classified >= 20);
  assert.ok(balance.periods.some((period) => period.positive > 0));
  assert.ok(balance.periods.some((period) => period.negative > 0));
});

test("safety balance suppresses percentages below the configured minimum", () => {
  const data = generateDemoDataset();
  const one = data.records.find((record) => record.iqSafetyObservationCategory === "positive");
  assert.ok(one);
  const balance = buildSafetyObservationBalance([one], data.asOf, 2);
  assert.equal(balance.positive, 1);
  assert.equal(balance.negative, 0);
  assert.equal(balance.positiveShare, null);
});

test("non-Issue lookalikes cannot enter the Issue safety sidecar population", () => {
  const data = generateDemoDataset();
  const issue = data.records.find((record) => record.iqSafetyObservationCategory === "positive")!;
  const lookalike = { ...issue, id: "form-lookalike", kind: "form" as const };
  const balance = buildSafetyObservationBalance([issue, lookalike], data.asOf, 1);
  assert.equal(balance.classified, 1);
});

test("safety sidecar parsing trims labels and fails closed on enums and timestamps", () => {
  assert.equal(trimmedCanonicalText("  excavation  "), "excavation");
  assert.equal(trimmedCanonicalText("   "), null);
  assert.equal(safetyRiskCategoryFromConstructionIq(" caught in between "), "caught_inbetween");
  assert.equal(safetyRiskCategoryFromConstructionIq("Struck by"), "struck_by");
  assert.equal(safetyRiskCategoryFromConstructionIq("new provider literal"), "unmapped");
  assert.equal(safetyObservationCategoryFromConstructionIq(" Negative "), "negative");
  assert.equal(safetyObservationCategoryFromConstructionIq("provider drift"), "unmapped");
  assert.equal(canonicalUtcTimestamp("2026-09-09T12:00:00.000Z"), "2026-09-09T12:00:00.000Z");
  assert.equal(canonicalUtcTimestamp("2026-09-09T12:00:00Z"), null);
  assert.equal(canonicalUtcTimestamp(" 2026-09-09T12:00:00.000Z "), null);
});

test("balance ignores raw-only, unmapped, and future canonical observations", () => {
  const data = generateDemoDataset();
  const issue = data.records.find((record) => record.iqSafetyObservationCategory === "positive")!;
  const rawOnly = {
    ...issue,
    id: "raw-only",
    iqSafetyObservationCategory: null,
    iqSafetyObservationPredictedAt: null,
    raw: { safety_observation_category: "positive", safety_observation_predicted_at: data.asOf },
  };
  const unmapped = { ...issue, id: "unmapped", iqSafetyObservationCategory: "unmapped" as const };
  const future = {
    ...issue,
    id: "future",
    iqSafetyObservationPredictedAt: "2026-09-10T12:00:00.000Z",
  };
  const balance = buildSafetyObservationBalance([issue, rawOnly, unmapped, future], data.asOf, 1);
  assert.equal(balance.classified, 1);
  assert.deepEqual(balance.evidence.map((entry) => entry.id), [issue.id]);
});

test("safety observation balance distinguishes partial and unavailable source coverage", () => {
  const data = generateDemoDataset();
  const base = data.records.find((record) => record.iqSafetyObservationCategory === "positive")!;
  const covered = { ...base, id: "covered-observation", projectId: "p1" };
  const uncovered = { ...base, id: "uncovered-observation", projectId: "p2", iqSafetyObservationCategory: "negative" as const };
  const partial = buildSafetyObservationBalance(
    [covered, uncovered],
    data.asOf,
    1,
    safetyObservationSourceAvailabilityForProjects(["p1", "p2"], ["p1"]),
  );
  assert.equal(partial.classified, 1);
  assert.equal(partial.positive, 1);
  assert.equal(partial.negative, 0);
  assert.deepEqual(partial.sourceCoverage, {
    available: true,
    unavailableReason: null,
    eligibleIssues: 1,
    coveredProjects: 1,
    scopeProjects: 2,
  });

  const unavailable = buildSafetyObservationBalance(
    [uncovered],
    data.asOf,
    1,
    safetyObservationSourceAvailabilityForProjects(["p2"], ["p1"]),
  );
  assert.equal(unavailable.sourceCoverage.available, false);
  assert.equal(unavailable.classified, 0);
  assert.equal(unavailable.positiveShare, null);
  assert.equal(unavailable.sourceCoverage.eligibleIssues, null);
  assert.match(unavailable.sourceCoverage.unavailableReason ?? "", /no project/i);
});
