import assert from "node:assert/strict";
import test from "node:test";
import type { RiskRecord, SourceRecordKind } from "../src/lib/canonical/types";
import { generateDemoDataset } from "../src/lib/demo/generator";
import { burnGrowthRecommendation, burnHistoryFromRecords, burnRateFromRecords } from "../src/lib/risk/analytics";

const AS_OF = "2026-09-08T12:00:00.000Z";

function fixtureRecord(id: string, kind: SourceRecordKind, overrides: Partial<RiskRecord> = {}): RiskRecord {
  const base = generateDemoDataset().records[0]!;
  return {
    ...base,
    id,
    kind,
    status: "closed",
    open: false,
    createdAt: "2026-09-07T12:00:00.000Z",
    closedAt: "2026-09-08T12:00:00.000Z",
    respondedAt: null,
    ...overrides,
  };
}

test("burn population includes only the five supported record kinds", () => {
  const allowed: SourceRecordKind[] = ["issue", "rfi", "submittal", "clash-group", "form"];
  const excluded: SourceRecordKind[] = ["review", "schedule-activity", "change-order"];
  const records = [...allowed, ...excluded].map((kind, index) => fixtureRecord(String(index), kind, {
    respondedAt: kind === "submittal" || kind === "form" ? "2026-09-08T12:00:00.000Z" : null,
  }));
  const burn = burnRateFromRecords(records, AS_OF, 2);
  assert.equal(burn.created, allowed.length);
  assert.equal(burn.resolved, allowed.length);
});

test("submittal responses resolve while draft and void records never do", () => {
  const records = [
    fixtureRecord("responded", "submittal", { closedAt: null, respondedAt: "2026-09-08T12:00:00.000Z" }),
    fixtureRecord("draft", "issue", { status: "draft" }),
    fixtureRecord("void", "form", { status: "void", respondedAt: "2026-09-08T12:00:00.000Z" }),
  ];
  const burn = burnRateFromRecords(records, AS_OF, 2);
  assert.equal(burn.created, 3);
  assert.equal(burn.resolved, 1);
});

test("burn summary and weekly buckets share exact half-open boundaries", () => {
  const records = [
    fixtureRecord("at-start", "issue", { createdAt: "2026-09-02T00:00:00.000Z", closedAt: "2026-09-02T00:00:00.000Z" }),
    fixtureRecord("before-start", "issue", { createdAt: "2026-09-01T23:59:59.999Z", closedAt: "2026-09-01T23:59:59.999Z" }),
    fixtureRecord("at-end", "issue", { createdAt: "2026-09-09T00:00:00.000Z", closedAt: "2026-09-09T00:00:00.000Z" }),
    fixtureRecord("before-end", "issue", { createdAt: "2026-09-08T23:59:59.999Z", closedAt: "2026-09-08T23:59:59.999Z" }),
  ];
  const summary = burnRateFromRecords(records, AS_OF, 7);
  const history = burnHistoryFromRecords(records, AS_OF, 7);
  assert.equal(summary.created, 2);
  assert.equal(summary.resolved, 2);
  assert.equal(history.reduce((sum, bucket) => sum + bucket.created, 0), summary.created);
  assert.equal(history.reduce((sum, bucket) => sum + bucket.resolved, 0), summary.resolved);
});

test("burn backlog is reconstructed at the selected historical as-of day", () => {
  const records = [
    fixtureRecord("closed-after", "issue", { createdAt: "2026-08-01T00:00:00.000Z", closedAt: "2026-09-08T00:00:00.000Z", open: false }),
    fixtureRecord("closed-before", "issue", { createdAt: "2026-08-01T00:00:00.000Z", closedAt: "2026-09-01T00:00:00.000Z", open: false }),
    fixtureRecord("created-after", "issue", { createdAt: "2026-09-07T00:00:00.000Z", closedAt: null, open: true }),
    fixtureRecord("still-open", "issue", { createdAt: "2026-08-01T00:00:00.000Z", closedAt: null, open: true }),
  ];
  const historical = burnRateFromRecords(records, "2026-09-05T12:00:00.000Z", 7);
  assert.equal(historical.backlog, 2);
});

test("a growing burn population yields an evidence-cited deterministic action", () => {
  const records = [
    fixtureRecord("created-a", "issue", { open: true, closedAt: null }),
    fixtureRecord("created-b", "rfi", { open: true, closedAt: null }),
    fixtureRecord("resolved", "issue", { createdAt: "2026-08-01T00:00:00.000Z" }),
  ];
  const recommendation = burnGrowthRecommendation(records, AS_OF, 2, "test-scope");
  assert.equal(recommendation?.ruleId, "mitigation.burn-growth.v1");
  assert.match(recommendation?.detail ?? "", /2 eligible records were created and 1 resolved/u);
  assert.deepEqual(recommendation?.citedEvidence.map((item) => item.id).sort(), ["created-a", "created-b", "resolved"]);
  assert.equal(burnGrowthRecommendation([records[2]!], AS_OF, 2), null);
});
