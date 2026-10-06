import assert from "node:assert/strict";
import test from "node:test";
import { SourceChip } from "../src/components/risk-ui";
import type { MetricProvenance } from "../src/lib/canonical/types";

const provenance: MetricProvenance = Object.freeze({
  sourceSystem: "demo-generator",
  sourceDataset: "risk-engine",
  extractedAt: "2026-09-08T00:00:00Z",
  calculatedAt: "2026-09-08T00:00:00Z",
  definitionId: "risk.quality.high-open",
  definitionVersion: "1.0.0",
  valueKind: "application-derived",
});

test("synthetic source chips render no badge for either metric kind", () => {
  assert.equal(SourceChip({ provenance }), null);
  assert.equal(SourceChip({ provenance: { ...provenance, valueKind: "autodesk-provided", autodeskTerm: "Quality Risk" } }), null);
  assert.equal(SourceChip({ label: "Synthetic", syntheticKind: "Derived" }), null);
  assert.equal(SourceChip({ label: "Synthetic", syntheticKind: "Autodesk-shaped field" }), null);
  // Presentation changes must not strip the evidence inspected elsewhere.
  assert.equal(provenance.sourceSystem, "demo-generator");
  assert.equal(provenance.definitionId, "risk.quality.high-open");
});

test("live source and derived chips retain labels and definition details", () => {
  for (const [valueKind, expectedLabel] of [
    ["autodesk-provided", "Autodesk"],
    ["application-derived", "Derived"],
    ["ai-generated", "AI"],
  ] as const) {
    const chip = SourceChip({ provenance: { ...provenance, sourceSystem: "acc-data-connector", valueKind } });
    assert.ok(chip);
    assert.equal(chip.props.className, `data-chip data-chip--${expectedLabel.toLowerCase()}`);
    assert.equal(chip.props.children[1], expectedLabel);
    assert.equal(chip.props.title, "risk.quality.high-open · v1.0.0");
  }
});

test("explicit real-source labels and the unqualified derived default remain visible", () => {
  const realSource = SourceChip({ label: "Autodesk" });
  const derived = SourceChip({});
  assert.ok(realSource);
  assert.ok(derived);
  assert.equal(realSource.props.children[1], "Autodesk");
  assert.equal(derived.props.children[1], "Derived");
});
