import { recordIdentityKey, type RecordIdentity, type RiskDomain, type RiskRecord, type RiskRelationship } from "../canonical/types";

export const RELATIONSHIP_CONVERSION_CAPTION = "Records linked in ACC. Ordering shown by creation date. Direction and causality are not asserted by Autodesk.";
export const DEFAULT_RELATIONSHIP_MINIMUM = 8;

export type RelationshipStageId = "design-issue-rfi" | "rfi-field-issue" | "issue-change" | "rfi-change" | "rework" | "schedule-impact";
export type RelationshipCoverageState = "no-links-recorded" | "insufficient-data" | "minimum-met" | "unsupported";

export interface RelationshipConversionStage {
  id: RelationshipStageId;
  label: string;
  rawEdgeCount: number | null;
  coverageState: RelationshipCoverageState;
  conversionRate: null;
}

export interface RelationshipConversionContributor {
  edge: RiskRelationship;
  endpointA: RecordIdentity & { label: string };
  endpointB: RecordIdentity & { label: string };
  ownershipLabel: string;
  recordedAt: string | null;
}

export interface RelationshipConversionEvidence {
  minimumEdgeCount: number;
  stages: readonly RelationshipConversionStage[];
  contributors: readonly RelationshipConversionContributor[];
  unclassifiedEdgeCount: number;
  noRelationshipCandidateCount: number;
  caption: typeof RELATIONSHIP_CONVERSION_CAPTION;
}

export interface AuthorizedRelationshipSelection {
  relationships: readonly RiskRelationship[];
  excludedDanglingCount: number;
}

function stageFor(edge: RiskRelationship, domains: ReadonlyMap<string, RiskDomain>): Exclude<RelationshipStageId, "rework"> | null {
  const kinds = new Set([edge.from.kind, edge.to.kind]);
  if (kinds.has("issue") && kinds.has("rfi")) {
    const issue = edge.from.kind === "issue" ? edge.from : edge.to;
    const domain = domains.get(recordIdentityKey(issue));
    return domain === "design" ? "design-issue-rfi" : domain ? "rfi-field-issue" : null;
  }
  if (kinds.has("issue") && kinds.has("change-order")) return "issue-change";
  if (kinds.has("rfi") && kinds.has("change-order")) return "rfi-change";
  if (kinds.has("schedule-activity")) return "schedule-impact";
  return null;
}

export function relationshipIdentity(edge: RiskRelationship): string {
  const endpoints = [recordIdentityKey(edge.from), recordIdentityKey(edge.to)].sort();
  return `${edge.projectId}\u001f${endpoints.join("\u001e")}`;
}

function validCreatedAt(value: string | null): value is string {
  return value !== null && Number.isFinite(new Date(value).getTime());
}

function stateFor(count: number, minimum: number): RelationshipCoverageState {
  return count === 0 ? "no-links-recorded" : count < minimum ? "insufficient-data" : "minimum-met";
}

const methodPriority: Record<RiskRelationship["method"], number> = {
  "acc-relationship-service": 5,
  "clash-group-issue-id": 4,
  "shared-document-lineage": 3,
  "shared-location-and-root-cause": 2,
  "shared-location-window": 1,
};

function preferredEdge(left: RiskRelationship, right: RiskRelationship): RiskRelationship {
  const confidence = { confirmed: 2, inferred: 1, none: 0 } as const;
  if (confidence[left.confidence] !== confidence[right.confidence]) return confidence[left.confidence] > confidence[right.confidence] ? left : right;
  if (methodPriority[left.method] !== methodPriority[right.method]) return methodPriority[left.method] > methodPriority[right.method] ? left : right;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

export function selectRelationshipVersions(
  relationships: readonly RiskRelationship[],
  options: { asOf?: string; includeNone?: boolean; algorithmVersion?: string } = {},
): readonly RiskRelationship[] {
  const asOfDate = options.asOf?.slice(0, 10) ?? null;
  if (options.asOf && !Number.isFinite(new Date(options.asOf).getTime())) throw new RangeError("Relationship selection requires a valid as-of timestamp.");
  const latestBySourceId = new Map<string, RiskRelationship>();
  for (const edge of relationships) {
    if (asOfDate && edge.snapshotDate > asOfDate) continue;
    if (options.algorithmVersion && edge.algorithmVersion !== options.algorithmVersion) continue;
    const key = `${edge.projectId}\u001f${edge.id}`;
    const current = latestBySourceId.get(key);
    if (!current || edge.snapshotDate > current.snapshotDate || (
      edge.snapshotDate === current.snapshotDate && (
        edge.provenance.calculatedAt > current.provenance.calculatedAt ||
        (edge.provenance.calculatedAt === current.provenance.calculatedAt && edge.algorithmVersion > current.algorithmVersion)
      )
    )) latestBySourceId.set(key, edge);
  }
  return [...latestBySourceId.values()]
    .filter((edge) => edge.deletedAt === null && (options.includeNone !== false || edge.confidence !== "none"))
    .sort((left, right) => `${left.projectId}\u001f${left.id}`.localeCompare(`${right.projectId}\u001f${right.id}`));
}

export function selectCanonicalRelationships(
  relationships: readonly RiskRelationship[],
  options: { asOf?: string; includeNone?: boolean; algorithmVersion?: string } = {},
): readonly RiskRelationship[] {
  const byPair = new Map<string, RiskRelationship>();
  for (const edge of selectRelationshipVersions(relationships, options)) {
    const key = relationshipIdentity(edge);
    const current = byPair.get(key);
    byPair.set(key, current ? preferredEdge(current, edge) : edge);
  }
  return [...byPair.values()].sort((left, right) => relationshipIdentity(left).localeCompare(relationshipIdentity(right)));
}

/**
 * Relationship reads can reveal that an inaccessible counterparty exists. Keep
 * an edge only when both endpoint records are present in the caller's already
 * authorized canonical population; the count is safe coverage metadata and
 * never exposes the hidden endpoint itself.
 */
export function selectAuthorizedRelationships(
  relationships: readonly RiskRelationship[],
  records: readonly Pick<RiskRecord, "projectId" | "kind" | "id">[],
  options: { asOf?: string; includeNone?: boolean; algorithmVersion?: string } = {},
): AuthorizedRelationshipSelection {
  const authorizedKeys = new Set(records.map(recordIdentityKey));
  const canonical = selectCanonicalRelationships(relationships, options);
  const authorized = canonical.filter((edge) =>
    authorizedKeys.has(recordIdentityKey(edge.from)) && authorizedKeys.has(recordIdentityKey(edge.to))
  );
  return {
    relationships: authorized,
    excludedDanglingCount: canonical.length - authorized.length,
  };
}

export function relationshipOwnershipLabel(edge: RiskRelationship): string {
  if (edge.confidence === "inferred") return "Application-inferred association; creator not recorded";
  return edge.serviceOwned ? "System-created ACC link" : "User-created ACC link";
}

export function buildRelationshipConversionEvidence(
  relationships: readonly RiskRelationship[],
  options: { minimumEdgeCount?: number; records?: readonly Pick<RiskRecord, "projectId" | "kind" | "id" | "domain">[] } = {},
): RelationshipConversionEvidence {
  const minimum = options.minimumEdgeCount ?? DEFAULT_RELATIONSHIP_MINIMUM;
  if (!Number.isInteger(minimum) || minimum <= 0) throw new RangeError("Relationship minimum edge count must be a positive integer.");
  const selectedWithCandidates = selectCanonicalRelationships(relationships);
  const deduplicated = selectedWithCandidates.filter((edge) => edge.confidence !== "none");
  const domains = new Map((options.records ?? []).map((record) => [recordIdentityKey(record), record.domain] as const));
  const definitions: readonly [Exclude<RelationshipStageId, "rework">, string][] = [
    ["design-issue-rfi", "Design Issue ↔ RFI"],
    ["rfi-field-issue", "RFI ↔ field Issue"],
    ["issue-change", "Issue ↔ change"],
    ["rfi-change", "RFI ↔ change"],
    ["schedule-impact", "Record ↔ schedule activity"],
  ];
  const stages: RelationshipConversionStage[] = definitions.map(([id, label]) => {
    const count = deduplicated.filter((edge) => stageFor(edge, domains) === id).length;
    return { id, label, rawEdgeCount: count, coverageState: stateFor(count, minimum), conversionRate: null };
  });
  stages.splice(4, 0, { id: "rework", label: "Rework", rawEdgeCount: null, coverageState: "unsupported", conversionRate: null });
  const contributors = deduplicated
    .filter((edge) => stageFor(edge, domains) !== null)
    .map((edge): RelationshipConversionContributor => ({
      edge,
      endpointA: { projectId: edge.from.projectId, kind: edge.from.kind, id: edge.from.id, label: edge.from.label },
      endpointB: { projectId: edge.to.projectId, kind: edge.to.kind, id: edge.to.id, label: edge.to.label },
      ownershipLabel: relationshipOwnershipLabel(edge),
      recordedAt: validCreatedAt(edge.createdAt) ? edge.createdAt : null,
    }))
    .sort((left, right) => left.recordedAt === null ? right.recordedAt === null ? 0 : 1 : right.recordedAt === null ? -1 : left.recordedAt.localeCompare(right.recordedAt));
  return {
    minimumEdgeCount: minimum,
    stages,
    contributors,
    unclassifiedEdgeCount: deduplicated.filter((edge) => stageFor(edge, domains) === null).length,
    noRelationshipCandidateCount: selectedWithCandidates.filter((edge) => edge.confidence === "none").length,
    caption: RELATIONSHIP_CONVERSION_CAPTION,
  };
}
