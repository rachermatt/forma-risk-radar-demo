export type DataMode = "demo" | "autodesk";

/**
 * Canonical DATA_MODE normalization shared by the page, readiness, providers,
 * and authentication routes. Invalid values remain distinguishable from the
 * safe demo default so each boundary can fail closed in its native error type.
 */
export function normalizedDataMode(value: string | undefined): DataMode | null {
  const normalized = value?.trim().toLowerCase() || "demo";
  return normalized === "demo" || normalized === "autodesk"
    ? normalized
    : null;
}

/** Canonical APS scope grammar: unique, non-empty tokens separated by commas or whitespace. */
export function normalizedApsScopes(value: string): readonly string[] | null {
  const scopes = value.split(/[\s,]+/u).filter(Boolean);
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) return null;
  return Object.freeze(scopes);
}
