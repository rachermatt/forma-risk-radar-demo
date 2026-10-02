import assert from "node:assert/strict";
import test from "node:test";
import type { MetricProvenance } from "../src/lib/canonical/types";
import {
  effectiveCiqRisk,
  locationTier,
  normalizeLifecycle,
  normalizeSeverity,
  normalizeTrade,
  normalizeTriState,
  triStateLabel,
} from "../src/lib/risk/normalization";
import { canShowAutodeskAttribution, derivedProvenance } from "../src/lib/risk/provenance";

test("source casing normalizes without ever inventing critical", () => {
  assert.equal(normalizeSeverity("High"), "high");
  assert.equal(normalizeSeverity("critical"), "unmapped");
  assert.equal(normalizeSeverity("mystery"), "unmapped");
  assert.equal(normalizeSeverity(null), "none");
});

test("human CIQ override takes precedence", () => {
  assert.equal(effectiveCiqRisk("high", "low"), "low");
  assert.equal(effectiveCiqRisk("high", null), "high");
});

test("normalization preserves an explicit unmapped state", () => {
  assert.equal(normalizeLifecycle("issue", { status: "in progress" }), "open");
  assert.equal(normalizeLifecycle("issue", { status: "not_approved" }), "open");
  assert.equal(normalizeLifecycle("issue", { status: "draft" }), "excluded");
  assert.equal(normalizeLifecycle("issue", { status: "void" }), "excluded");
  assert.equal(normalizeLifecycle("issue", { status: "bespoke_status" }), "unmapped");
  assert.equal(normalizeLifecycle("rfi", { status: "open", closedAt: "2026-01-02T00:00:00Z" }), "closed");
  assert.equal(normalizeLifecycle("submittal", { status: "closed", respondedAt: null }), "open");
  assert.equal(normalizeTriState("Unknown"), "unknown");
  assert.equal(normalizeTriState(null), null);
  assert.equal(normalizeTriState("unexpected"), "unmapped");
  assert.equal(triStateLabel(null), "Not recorded / field unavailable");
  assert.equal(triStateLabel("unmapped"), "Unmapped source value");
  assert.deepEqual(normalizeTrade("Moisture Protection | Waterproofing"), {
    raw: "Moisture Protection | Waterproofing",
    primary: "Moisture Protection",
    secondary: "Waterproofing",
  });
  assert.equal(locationTier(3, "Level 04"), "level");
});

test("Autodesk attribution requires both the value kind and Autodesk term", () => {
  const derived = derivedProvenance({ timestamp: "2026-09-08T00:00:00Z", definitionId: "risk.index" });
  assert.equal(canShowAutodeskAttribution(derived), false);
  const missingTerm = { ...derived, valueKind: "autodesk-provided" } as MetricProvenance;
  assert.equal(canShowAutodeskAttribution(missingTerm), false);
  const valid = { ...missingTerm, autodeskTerm: "Construction IQ Quality Risk" };
  assert.equal(canShowAutodeskAttribution(valid), true);
});
