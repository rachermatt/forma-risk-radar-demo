import assert from "node:assert/strict";
import test from "node:test";
import type { Measured, MomentumDimension } from "../src/lib/canonical/types";
import { generateDemoDataset } from "../src/lib/demo/generator";
import { buildRiskVelocityEvidence } from "../src/lib/risk/risk-velocity";

test("risk velocity preserves stored momentum values, nulls, rates, and coverage", () => {
  const data = generateDemoDataset();
  const measures = data.projects.slice(0, 2).map((project) => project.momentum);
  const series = [
    { date: "2026-09-07", value: 50, observed: true, forwardFilled: false, forwardFilledFrom: null, stale: false },
    { date: "2026-09-08", value: 50, observed: false, forwardFilled: true, forwardFilledFrom: "2026-09-07", stale: false },
    { date: "2026-09-09", value: null, observed: false, forwardFilled: false, forwardFilledFrom: null, stale: false },
  ];
  const model = buildRiskVelocityEvidence(measures, { asOf: data.asOf, sourceSystem: "demo-generator", series });
  assert.equal(model.state, "available");
  assert.equal(model.coverageState, "partial");
  assert.deepEqual(model.coverage, { observed: 1, carried: 1, mixed: 0, missing: 1, stale: 0, usableRatio: 2 / 3 });
  const oneDayValues = measures.map((item) => item.value.change1d).filter((value): value is number => value !== null);
  const expectedOneDay = Math.round((oneDayValues.reduce((sum, value) => sum + value, 0) / oneDayValues.length) * 10) / 10;
  assert.equal(model.metrics.find((metric) => metric.id === "change1d")!.value, expectedOneDay);
  const expectedNewRate = Math.round(measures.reduce((sum, item) => sum + item.value.newHighRiskRate, 0) * 10) / 10;
  assert.equal(model.metrics.find((metric) => metric.id === "newHighRiskRate")!.value, expectedNewRate);
  const newlyClassified = model.metrics.find((metric) => metric.id === "newlyClassifiedRate")!;
  assert.equal(newlyClassified.value, null);
  assert.equal(newlyClassified.availability, "unavailable");
  assert.match(newlyClassified.unavailableReason!, /transition history is not stored/u);
});

test("risk velocity never substitutes values for an explicitly unavailable scope", () => {
  const data = generateDemoDataset();
  const source = data.projects[0]!.momentum;
  const unavailable = buildRiskVelocityEvidence([source], { asOf: data.asOf, available: false, unavailableReason: "record-filtered history unavailable" });
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.coverageState, "unavailable");
  assert.ok(unavailable.metrics.every((metric) => metric.value === null));
  assert.equal(unavailable.unavailableReason, "record-filtered history unavailable");

  const withNull: Measured<MomentumDimension> = { ...source, value: { ...source.value, change1d: null } };
  const covered = buildRiskVelocityEvidence([withNull], { asOf: data.asOf });
  assert.equal(covered.metrics.find((metric) => metric.id === "change1d")!.value, null);
  assert.throws(() => buildRiskVelocityEvidence([], { asOf: "invalid" }), RangeError);
});

test("mixed aggregate coverage is counted once and cannot exceed 100 percent", () => {
  const data = generateDemoDataset();
  const source = data.projects[0]!.momentum;
  const model = buildRiskVelocityEvidence([source], {
    asOf: data.asOf,
    series: [{
      date: "2026-09-09",
      value: 50,
      observed: false,
      forwardFilled: true,
      forwardFilledFrom: "2026-09-08",
      stale: false,
      mixed: true,
      observedCount: 1,
      forwardFilledCount: 1,
      missingCount: 0,
      populationCount: 2,
    }],
  });
  assert.deepEqual(model.coverage, { observed: 0, carried: 0, mixed: 1, missing: 0, stale: 0, usableRatio: 1 });
  assert.equal(model.coverageState, "carried-forward");
});
