import assert from "node:assert/strict";
import test from "node:test";
import { previousHistoryAsOf, previousHistoryRange, resolveHistoryRange, seriesWithinHistoryRange } from "../src/lib/risk/history-range";

const INPUT = { asOf: "2026-09-08T18:30:00.000Z", coverageStart: "2026-03-12" };

test("history presets include the as-of UTC day and expose partial coverage", () => {
  const year = resolveHistoryRange({ ...INPUT, range: "365d" });
  assert.equal(year.startDate, "2025-09-09");
  assert.equal(year.endDate, "2026-09-08");
  assert.equal(year.periodDays, 365);
  assert.equal(year.throughExclusive, Date.parse("2026-09-09T00:00:00.000Z"));
  assert.equal(year.coveragePartial, true);

  const sixMonths = resolveHistoryRange({ ...INPUT, range: "180d" });
  assert.equal(sixMonths.coveragePartial, false);
  const previousSixMonths = previousHistoryRange(sixMonths, INPUT.coverageStart);
  assert.equal(previousSixMonths.startDate, "2025-09-14");
  assert.equal(previousSixMonths.endDate, "2026-03-12");
  assert.equal(previousSixMonths.coveragePartial, true);

  const previousYear = previousHistoryRange(year, INPUT.coverageStart);
  assert.equal(previousYear.coveragePartial, true);
});

test("custom history uses strict inclusive dates represented by half-open bounds", () => {
  const custom = resolveHistoryRange({ ...INPUT, range: "custom", from: "2026-04-01", to: "2026-04-03" });
  assert.equal(custom.key, "custom");
  assert.equal(custom.periodDays, 3);
  assert.equal(custom.from, Date.parse("2026-04-01T00:00:00.000Z"));
  assert.equal(custom.throughExclusive, Date.parse("2026-04-04T00:00:00.000Z"));
  assert.equal(previousHistoryAsOf(custom), "2026-03-31T12:00:00.000Z");
  assert.deepEqual(
    { start: previousHistoryRange(custom).startDate, end: previousHistoryRange(custom).endDate },
    { start: "2026-03-29", end: "2026-03-31" },
  );
  assert.deepEqual(seriesWithinHistoryRange([
    { date: "2026-03-31", value: 0 },
    { date: "2026-04-01", value: 1 },
    { date: "2026-04-03", value: 3 },
    { date: "2026-04-04", value: 4 },
  ], custom).map((point) => point.value), [1, 3]);
});

test("invalid, reversed, and future custom ranges fail safely to 30 days", () => {
  for (const [from, to] of [
    ["04/01/2026", "2026-04-03"],
    ["2026-04-04", "2026-04-03"],
    ["2026-09-01", "2026-09-09"],
    ["0001-01-01", "2026-09-08"],
    ["2026-03-11", "2026-04-01"],
  ]) {
    const range = resolveHistoryRange({ ...INPUT, range: "custom", from, to });
    assert.equal(range.key, "30d");
    assert.equal(range.invalidCustom, true);
    assert.equal(range.periodDays, 30);
  }
  assert.equal(resolveHistoryRange({ asOf: INPUT.asOf, range: "custom", from: "2025-01-01", to: "2026-01-02" }).key, "30d");
});

test("unknown presets fail safely and invalid as-of timestamps are rejected", () => {
  for (const inheritedName of ["forever", "toString", "constructor", "__proto__"]) {
    const range = resolveHistoryRange({ ...INPUT, range: inheritedName });
    assert.equal(range.key, "30d", inheritedName);
    assert.equal(range.periodDays, 30, inheritedName);
  }
  assert.throws(() => resolveHistoryRange({ asOf: "not-a-date" }), RangeError);
});
