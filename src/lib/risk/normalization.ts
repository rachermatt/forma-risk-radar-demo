import type { MomentumDirection, Severity, SourceRecordKind, TriState } from "../canonical/types";

const OPEN_STATES = new Set([
  "open",
  "draft",
  "pending",
  "in_review",
  "in_progress",
  "submitted",
  "waiting",
  "answered",
  "approved_with_comments",
]);

const CLOSED_STATES = new Set([
  "closed",
  "completed",
  "approved",
  "rejected",
  "void",
  "archived",
  "discarded",
  "not_approved",
]);

export type NormalizedLifecycle = "open" | "closed" | "excluded" | "unmapped";

export interface LifecycleInput {
  readonly status?: string | null;
  readonly deletedAt?: string | null;
  readonly closedAt?: string | null;
  readonly respondedAt?: string | null;
}

const ISSUE_STATES = new Set(["open", "work_completed", "ready_to_inspect", "not_approved", "in_dispute", "closed", "void", "answered", "draft", "pending", "in_progress", "completed", "in_review"]);

export function normalizeLifecycle(kind: SourceRecordKind, input: LifecycleInput): NormalizedLifecycle {
  if (kind === "issue") {
    const value = input.status?.trim().toLowerCase().replace(/[ -]+/g, "_");
    if (!value || !ISSUE_STATES.has(value)) return "unmapped";
    if (input.deletedAt || value === "draft" || value === "void") return "excluded";
    if (value === "closed" || value === "completed") return "closed";
    return "open";
  }
  if (kind === "rfi") return input.closedAt ? "closed" : "open";
  if (kind === "submittal") return input.respondedAt ? "closed" : "open";
  const value = input.status?.trim().toLowerCase().replace(/[ -]+/g, "_");
  if (!value) return "unmapped";
  if (OPEN_STATES.has(value)) return "open";
  if (CLOSED_STATES.has(value)) return "closed";
  return "unmapped";
}

export function normalizeTriState(raw: string | boolean | null | undefined): TriState {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return null;
  if (raw === true || String(raw).trim().toLowerCase() === "yes") return "yes";
  if (raw === false || String(raw).trim().toLowerCase() === "no") return "no";
  if (String(raw).trim().toLowerCase() === "unknown") return "unknown";
  return "unmapped";
}

export function triStateLabel(value: TriState): string {
  if (value === null) return "Not recorded / field unavailable";
  if (value === "unmapped") return "Unmapped source value";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function normalizeSeverity(raw: string | null | undefined): Severity {
  switch (raw?.trim().toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return raw === null || raw === undefined || raw.trim() === "" ? "none" : "unmapped";
  }
}

export function effectiveCiqRisk(modelRisk: Severity, userRisk?: Severity | null): Severity {
  return userRisk && userRisk !== "none" ? userRisk : modelRisk;
}

export function normalizeTrade(raw: string | null | undefined): {
  raw: string | null;
  primary: string | null;
  secondary: string | null;
} {
  const value = raw?.trim() || null;
  if (!value) return { raw: null, primary: null, secondary: null };
  const [primary, ...rest] = value.split(" | ").map((part) => part.trim()).filter(Boolean);
  return {
    raw: value,
    primary: primary ?? null,
    secondary: rest.length ? rest.join(" | ") : null,
  };
}

export function momentumDirection(change7d: number | null, acceleration: number | null): MomentumDirection {
  if (change7d === null) return "stable";
  if (change7d > 3 && acceleration !== null && acceleration > 0) return "accelerating";
  if (change7d > 3) return "increasing";
  if (change7d < -3) return "improving";
  return "stable";
}

export function locationTier(depth: number, name: string): "building" | "level" | "zone" | "room" | "unmapped" {
  const value = name.trim().toLowerCase();
  if (/\b(building|tower|wing)\b/.test(value) || /^[a-z]$/.test(value)) return "building";
  if (/\b(level|floor|deck|l\d{1,2})\b/.test(value)) return "level";
  if (/\b(zone|area|east|west|north|south)\b/.test(value)) return "zone";
  if (/\b(room|office|suite)\b/.test(value) || /^\d{2,4}[a-z]?$/.test(value)) return "room";
  if (depth === 2) return "building";
  if (depth === 3) return "level";
  if (depth >= 4) return "zone";
  return "unmapped";
}
