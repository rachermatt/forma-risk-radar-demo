import type { EvidenceRef, Measured, MetricProvenance, SourceSystem } from "../canonical/types";
import { RISK_DEFINITION_VERSION } from "./definitions";

export interface ProvenanceInput {
  sourceSystem?: SourceSystem;
  sourceDataset?: string;
  sourceRecordId?: string;
  projectId?: string;
  timestamp: string;
  definitionId: string;
  autodeskTerm?: string;
}

export function derivedProvenance(input: ProvenanceInput): MetricProvenance {
  return {
    sourceSystem: input.sourceSystem ?? "forma-risk-radar",
    sourceDataset: input.sourceDataset ?? "risk-engine",
    ...(input.sourceRecordId ? { sourceRecordId: input.sourceRecordId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    extractedAt: input.timestamp,
    calculatedAt: input.timestamp,
    definitionId: input.definitionId,
    definitionVersion: RISK_DEFINITION_VERSION,
    valueKind: input.sourceSystem === "demo-generator" ? "application-derived" : "application-derived",
  };
}

export function autodeskProvenance(input: ProvenanceInput & { autodeskTerm: string }): MetricProvenance {
  return {
    sourceSystem: input.sourceSystem ?? "acc-data-connector",
    sourceDataset: input.sourceDataset ?? "unknown",
    ...(input.sourceRecordId ? { sourceRecordId: input.sourceRecordId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    extractedAt: input.timestamp,
    calculatedAt: input.timestamp,
    definitionId: input.definitionId,
    definitionVersion: RISK_DEFINITION_VERSION,
    valueKind: "autodesk-provided",
    autodeskTerm: input.autodeskTerm,
  };
}

export function measured<T>(
  value: T,
  provenance: MetricProvenance,
  evidence: readonly EvidenceRef[] = [],
): Measured<T> {
  return { value, provenance, evidence };
}

export function canShowAutodeskAttribution(provenance: MetricProvenance): boolean {
  return provenance.valueKind === "autodesk-provided" && Boolean(provenance.autodeskTerm?.trim());
}

export function provenanceLabel(provenance: MetricProvenance): "Autodesk" | "Derived" | "AI" | "Synthetic" {
  if (provenance.sourceSystem === "demo-generator") return "Synthetic";
  if (provenance.valueKind === "autodesk-provided") return "Autodesk";
  if (provenance.valueKind === "ai-generated") return "AI";
  return "Derived";
}
