import assert from "node:assert/strict";
import test from "node:test";
import type { ConcentrationDimension } from "../src/lib/canonical/types";
import { generateDemoDataset } from "../src/lib/demo/generator";
import { buildScopedLineage } from "../src/lib/demo/scoped-lineage";
import { scopeDashboardData } from "../src/lib/demo/scope";
import { METRIC_DEFINITION_REGISTRY, metricDefinitionFor } from "../src/lib/risk/definition-registry";
import { ALL_RFI_CAUSE_SOURCES_AVAILABLE, buildRfiCauseIntelligence } from "../src/lib/risk/rfi-cause-intelligence";

test("every demo and scoped lineage definition resolves to one versioned catalog entry", () => {
  const data = generateDemoDataset();
  const scoped = scopeDashboardData(data, {});
  const dimensions: readonly Extract<ConcentrationDimension, "company" | "trade" | "root-cause" | "iq-root-cause" | "discipline" | "location" | "building-component" | "issue-type" | "project-type" | "project-phase" | "business-unit">[] = [
    "company", "trade", "root-cause", "iq-root-cause", "discipline", "location",
    "building-component", "issue-type", "project-type", "project-phase", "business-unit",
  ];
  const lineage = [
    ...data.lineage,
    ...dimensions.flatMap((concentrationDimension) => buildScopedLineage(data, scoped, {
      filters: {},
      rangeDays: 30,
      concentrationDimension,
    })),
  ];
  for (const entry of lineage) {
    const registered = metricDefinitionFor(entry.provenance.definitionId);
    assert.ok(registered, entry.provenance.definitionId);
    assert.equal(entry.provenance.definitionVersion, registered.version, entry.provenance.definitionId);
    assert.equal(entry.provenance.valueKind, registered.valueKind, entry.provenance.definitionId);
  }
});

test("RFI label and metric provenance definitions are registered with distinct value kinds", () => {
  const data = generateDemoDataset();
  const intelligence = buildRfiCauseIntelligence({
    records: data.records,
    asOf: data.asOf,
    sourceSystem: "demo-generator",
    sourceAvailability: ALL_RFI_CAUSE_SOURCES_AVAILABLE,
  });
  for (const group of intelligence.groups) {
    assert.equal(metricDefinitionFor(group.labelProvenance.definitionId)?.valueKind, "autodesk-provided");
    assert.equal(metricDefinitionFor(group.metricProvenance.definitionId)?.valueKind, "application-derived");
  }
  assert.equal(Object.keys(METRIC_DEFINITION_REGISTRY).length, new Set(Object.keys(METRIC_DEFINITION_REGISTRY)).size);
});
