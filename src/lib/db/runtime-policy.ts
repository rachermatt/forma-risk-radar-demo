export type RuntimeSchemaPolicy = "apply-local" | "verify-only";

export function runtimeSchemaPolicy(databaseUrl: string | undefined): RuntimeSchemaPolicy {
  return databaseUrl?.trim() ? "verify-only" : "apply-local";
}
