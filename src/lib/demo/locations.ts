import type { LocationNode, RiskRecord } from "../canonical/types";

export function demoLocationIdentityKey(projectId: string, locationId: string): string {
  return JSON.stringify([projectId, locationId]);
}

/**
 * Build the synthetic location tree that mirrors the `locations_nodes` rows the
 * live mapper will persist. Ancestor identities are explicit nodes; analytics
 * must never recreate hierarchy by splitting a display path.
 */
export function buildDemoLocationNodes(records: readonly RiskRecord[]): readonly LocationNode[] {
  const locations = new Map<string, LocationNode>();
  for (const record of records) {
    if (!record.locationId || !record.locationPath) continue;
    const parts = record.locationPath.split(" > ").map((part) => part.trim()).filter(Boolean);
    let parentId: string | null = null;
    for (let depth = 0; depth < parts.length; depth += 1) {
      const nodePath = parts.slice(0, depth + 1).join(" > ");
      const isLeaf = depth === parts.length - 1;
      const id = isLeaf
        ? record.locationId
        : `location-demo-node:${encodeURIComponent(record.projectId)}:${encodeURIComponent(nodePath)}`;
      const node: LocationNode = {
        id,
        projectId: record.projectId,
        treeId: `${record.projectId}-tree`,
        parentId,
        name: parts[depth]!,
        order: depth,
        depth,
        path: nodePath,
      };
      const key = demoLocationIdentityKey(record.projectId, id);
      const existing = locations.get(key);
      if (existing && (existing.path !== node.path || existing.parentId !== node.parentId)) {
        throw new Error(`Synthetic location ${id} maps to more than one path.`);
      }
      locations.set(key, node);
      parentId = id;
    }
  }
  return [...locations.values()].sort((left, right) =>
    left.projectId.localeCompare(right.projectId) ||
    left.depth - right.depth ||
    left.id.localeCompare(right.id)
  );
}
