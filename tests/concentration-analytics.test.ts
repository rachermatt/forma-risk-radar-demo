import assert from "node:assert/strict";
import test from "node:test";
import type { LocationNode, RiskRecord } from "../src/lib/canonical/types";
import { generateDemoDataset } from "../src/lib/demo/generator";
import { concentration, hotspots, recurrenceGroups } from "../src/lib/risk/analytics";

function copyRecord(base: RiskRecord, id: string, overrides: Partial<RiskRecord>): RiskRecord {
  return { ...base, id, ...overrides };
}

test("concentration excludes unattributed records from shares and discloses them separately", () => {
  const data = generateDemoDataset();
  const base = data.records.find((record) => record.kind === "issue");
  const company = data.companies[0];
  assert.ok(base);
  assert.ok(company);
  const records = [
    copyRecord(base, "attributed-1", { companyId: company.id }),
    copyRecord(base, "attributed-2", { companyId: company.id }),
    copyRecord(base, "unattributed-1", { companyId: null }),
  ];
  const buckets = concentration(records, "company", data.companies, data.asOf, "demo-generator");
  const attributed = buckets.find((bucket) => bucket.key === company.id);
  const unattributed = buckets.find((bucket) => bucket.key === "unattributed");
  assert.equal(attributed?.count, 2);
  assert.equal(attributed?.shareOfTotal, 1);
  assert.equal(unattributed?.count, 1);
  assert.equal(unattributed?.shareOfTotal, 0);
  assert.equal(buckets.at(-1)?.key, "unattributed");
});

test("location concentration preserves project-scoped location identities", () => {
  const data = generateDemoDataset();
  const base = data.records.find((record) => record.kind === "issue");
  assert.ok(base);
  const records = [
    copyRecord(base, "location-a", { projectId: "project-a", locationId: "level-1", locationPath: "Project > Level 1" }),
    copyRecord(base, "location-b", { projectId: "project-b", locationId: "level-1", locationPath: "Project > Level 1" }),
  ];
  const buckets = concentration(records, "location", data.companies, data.asOf, "demo-generator");
  assert.equal(buckets.length, 2);
  assert.ok(buckets.every((bucket) => bucket.count === 1 && bucket.shareOfTotal === 0.5));
});

test("recorded-root concentration uses project ids locally and versioned normalization across projects", () => {
  const data = generateDemoDataset();
  const base = data.records.find((record) => record.kind === "issue")!;
  const local = [
    copyRecord(base, "root-local-a", { projectId: "project-a", rootCauseId: "cause-a", rootCause: "Water Intrusion", constructionIqRisk: "high", open: true }),
    copyRecord(base, "root-local-b", { projectId: "project-a", rootCauseId: "cause-b", rootCause: "Water Intrusion", constructionIqRisk: "high", open: true }),
  ];
  const localBuckets = concentration(local, "root-cause", data.companies, data.asOf);
  assert.equal(localBuckets.length, 2, "same title must not merge distinct project-configured ids");
  assert.ok(localBuckets.every((bucket) => bucket.key.startsWith("project-root\u001fproject-a\u001f")));

  const crossProject = [
    local[0]!,
    copyRecord(base, "root-cross-b", { projectId: "project-b", rootCauseId: "cause-b", rootCause: "Water Ingress", constructionIqRisk: "high", open: true }),
  ];
  const crossBuckets = concentration(crossProject, "root-cause", data.companies, data.asOf);
  assert.equal(crossBuckets.length, 1);
  assert.equal(crossBuckets[0]!.count, 2);
  assert.equal(crossBuckets[0]!.label, "Water Intrusion");
  assert.match(crossBuckets[0]!.key, /normalized-root\u001f1\.0\.0\u001fwater intrusion/u);
});

test("project, phase, business-unit, and issue-type dimensions use their own joined identities", () => {
  const data = generateDemoDataset();
  const firstProject = data.projects[0]!.project;
  const secondProject = data.projects[1]!.project;
  const base = data.records.find((record) => record.kind === "issue")!;
  const records = [
    copyRecord(base, "issue-a", { projectId: firstProject.id, kind: "issue", typeName: "Coordination" }),
    copyRecord(base, "issue-b", { projectId: secondProject.id, kind: "issue", typeName: "Coordination" }),
    copyRecord(base, "rfi-inapplicable", { projectId: firstProject.id, kind: "rfi", typeName: "Coordination" }),
  ];
  const context = { projects: [firstProject, secondProject], businessUnits: data.businessUnits };
  const issueTypes = concentration(records, "issue-type", data.companies, data.asOf, "demo-generator", context);
  assert.equal(issueTypes.length, 2);
  assert.ok(issueTypes.every((bucket) => bucket.count === 1 && bucket.key.includes("\u001f")));
  const projectTypes = concentration(records, "project-type", data.companies, data.asOf, "demo-generator", context);
  assert.equal(projectTypes.reduce((sum, bucket) => sum + bucket.count, 0), 3);
  const phases = concentration(records, "project-phase", data.companies, data.asOf, "demo-generator", context);
  assert.ok(phases.every((bucket) => bucket.label === firstProject.currentPhase || bucket.label === secondProject.currentPhase));
  const units = concentration(records, "business-unit", data.companies, data.asOf, "demo-generator", context);
  assert.ok(units.every((bucket) => bucket.label === "Buildings" || bucket.label === "Infrastructure"));
});

test("versioned recurrence and location-node hotspot identities remain project scoped", () => {
  const data = generateDemoDataset();
  const base = data.records.find((record) => record.kind === "issue")!;
  const occurrence = (id: string, projectId: string, buildingComponent: string): RiskRecord => copyRecord(base, id, {
    projectId,
    buildingComponent,
    constructionIqRisk: "high",
    open: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    locationId: `${projectId}-leaf-${id}`,
    locationPath: "Project > Level 01 > East",
  });
  const records = [
    occurrence("a-1", "project-a", "A/B"),
    occurrence("a-2", "project-a", "A/B"),
    occurrence("b-1", "project-a", "A%2Fb"),
    occurrence("b-2", "project-a", "A%2Fb"),
    occurrence("c-1", "project-b", "A/B"),
    occurrence("c-2", "project-b", "A/B"),
  ];
  const recurrenceIds = recurrenceGroups(records, "building-component", data.asOf).map((group) => group.id);
  assert.equal(new Set(recurrenceIds).size, recurrenceIds.length);
  const locationNodes: LocationNode[] = ["project-a", "project-b"].flatMap((projectId) => {
    const projectRecords = records.filter((record) => record.projectId === projectId);
    return [
      { id: "shared-root", projectId, treeId: `${projectId}-tree`, parentId: null, name: "Project", order: 0, depth: 0, path: "Project" },
      ...projectRecords.map((record, order) => ({
        id: record.locationId!,
        projectId,
        treeId: `${projectId}-tree`,
        parentId: "shared-root",
        name: "East",
        order,
        depth: 1,
        path: "Project > Level 01 > East",
      })),
    ];
  });
  const nodeHotspots = hotspots(
    records,
    new Map([["project-a", "A"], ["project-b", "B"]]),
    data.asOf,
    "demo-generator",
    locationNodes,
  );
  const roots = nodeHotspots.filter((hotspot) => hotspot.locationId === "shared-root");
  assert.deepEqual(roots.map((hotspot) => hotspot.projectId).sort(), ["project-a", "project-b"]);
  assert.ok(roots.every((hotspot) => hotspot.evidence.every((entry) => entry.projectId === hotspot.projectId)));
  assert.ok(nodeHotspots.every((hotspot) => locationNodes.some((node) =>
    node.projectId === hotspot.projectId && node.id === hotspot.locationId
  )));
});
