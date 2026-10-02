import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateFilledSeriesByDate,
  calculateBurnRate,
  calculateMomentum,
  rollingAverageSeries,
  calculateRiskIndex,
  forwardFillDailySeries,
  per100Active,
  persistenceBuckets,
  ratio,
  severityFromRiskIndex,
  weightedIndex,
  wilsonLowerBound,
} from "../src/lib/risk/metrics";

test("zero denominators and low samples never masquerade as zero risk", () => {
  assert.equal(ratio(3, 0), null);
  assert.deepEqual(per100Active(4, 0), { value: null, lowSample: false, wilsonLowerBound: null, rankingValue: null, numerator: 4, denominator: 0 });
  const small = per100Active(4, 19);
  assert.equal(small.value, 100 * 4 / 19);
  assert.equal(small.lowSample, true);
  assert.equal(small.rankingValue, null);
  const eligible = per100Active(4, 20);
  assert.equal(eligible.value, 20);
  assert.equal(eligible.lowSample, false);
  assert.equal(eligible.rankingValue, eligible.wilsonLowerBound);
  assert.ok((eligible.rankingValue ?? 0) < eligible.value);
  assert.equal(wilsonLowerBound(0, 0), null);
});

test("weighted inputs renormalize and suppress below 60% coverage", () => {
  const available = weightedIndex([
    { id: "a", value: 0.8, weight: 0.6 },
    { id: "b", value: null, weight: 0.4 },
  ]);
  assert.equal(available.value, 80);
  assert.equal(available.coverage, 0.6);
  const suppressed = weightedIndex([
    { id: "a", value: 0.8, weight: 0.59 },
    { id: "b", value: null, weight: 0.41 },
  ]);
  assert.equal(suppressed.value, null);
  assert.equal(suppressed.suppressed, true);
});

test("risk index follows the published input weights", () => {
  const result = calculateRiskIndex({
    constructionIqQuality: 3,
    highRiskPer100: 25,
    overduePer100: 40,
    safetySignalsPer100: 10,
    rfiHighShare: 1,
    persistenceOver30Share: 1,
  });
  assert.equal(result.value, 100);
  assert.equal(result.coverage, 1);
});

test("severity boundaries and CIQ floors are exact", () => {
  assert.equal(severityFromRiskIndex(29.9, 0, "none", 1), "low");
  assert.equal(severityFromRiskIndex(30, 0, "none", 1), "medium");
  assert.equal(severityFromRiskIndex(55, 0, "none", 1), "high");
  assert.equal(severityFromRiskIndex(75, 0, "none", 1), "critical");
  assert.equal(severityFromRiskIndex(10, 1, "none", 1), "critical");
  assert.equal(severityFromRiskIndex(10, 0, "high", 1), "high");
  assert.equal(severityFromRiskIndex(null, 0, "none", 0), "none");
  assert.equal(severityFromRiskIndex(null, 0, "unmapped", 0), "unmapped");
});

test("CIQ forward-fill is a step function with observed and stale flags", () => {
  const result = forwardFillDailySeries(
    [
      { date: "2026-01-02", value: 2 },
      { date: "2026-01-04", value: 3 },
    ],
    "2026-01-01",
    "2026-04-06",
  );
  assert.equal(result[0]?.value, null);
  assert.equal(result[1]?.observed, true);
  assert.equal(result[2]?.value, 2);
  assert.equal(result[2]?.forwardFilledFrom, "2026-01-02");
  assert.equal(result[3]?.value, 3);
  assert.equal(result.at(-1)?.stale, true);
});

test("portfolio series aggregation aligns staggered histories by date", () => {
  const point = (date: string, value: number) => ({ date, value, observed: true, forwardFilled: false, forwardFilledFrom: null, stale: false });
  const result = aggregateFilledSeriesByDate([
    [point("2026-09-01", 10), point("2026-09-02", 20)],
    [point("2026-09-02", 40), point("2026-09-03", 60)],
  ]);
  assert.deepEqual(result.map(({ date, value }) => ({ date, value })), [
    { date: "2026-09-01", value: 10 },
    { date: "2026-09-02", value: 30 },
    { date: "2026-09-03", value: 60 },
  ]);
  assert.equal(result[0]?.mixed, true);
  assert.equal(result[0]?.observed, true);
  assert.equal(result[0]?.forwardFilled, false);
  assert.equal(result[0]?.forwardFilledFrom, null);
  assert.deepEqual(
    {
      observed: result[0]?.observedCount,
      carried: result[0]?.forwardFilledCount,
      missing: result[0]?.missingCount,
      population: result[0]?.populationCount,
    },
    { observed: 1, carried: 0, missing: 1, population: 2 },
  );
});

test("momentum requires enough history and suppresses noisy acceleration", () => {
  const short = calculateMomentum(Array.from({ length: 7 }, (_, index) => ({ date: String(index), value: 50 + index })));
  assert.equal(short.insufficientHistory, true);
  assert.equal(short.direction, "stable");
  const long = calculateMomentum(Array.from({ length: 29 }, (_, index) => ({ date: String(index), value: 30 + index })));
  assert.equal(long.change7d, 7);
  assert.equal(long.change28d, 28);
  assert.equal(long.direction, "increasing");
});

test("rolling averages require five usable points and retain pre-range context", () => {
  const points = Array.from({ length: 8 }, (_, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    value: index + 1,
    observed: true,
    forwardFilled: false,
    forwardFilledFrom: null,
    stale: false,
  }));
  const rolling = rollingAverageSeries(points);
  assert.equal(rolling[3]?.value, null);
  assert.equal(rolling[4]?.value, 3);
  assert.equal(rolling[7]?.value, 5);
  assert.equal(rolling[7]?.observed, false);
  assert.equal(rolling.slice(-2)[0]?.value, 4);

  const sparse = rollingAverageSeries(points.slice(0, 7).map((point, index) => ({
    ...point,
    value: index % 2 === 0 ? point.value : null,
  })));
  assert.equal(sparse.at(-1)?.value, null);
});

test("persistence buckets are cumulative and use strict thresholds", () => {
  assert.deepEqual(persistenceBuckets([7, 8, 14, 15, 30, 31]), { over7: 5, over14: 3, over30: 1 });
});

test("burn ratio is null when nothing was created", () => {
  assert.equal(calculateBurnRate("x", "all", 28, 0, 5, 9).burnRatio, null);
  assert.equal(calculateBurnRate("x", "all", 28, 4, 6, 9).burnRatio, 1.5);
});
