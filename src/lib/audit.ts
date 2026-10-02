import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "@/lib/db/sql";

export type AuditOutcome = "succeeded" | "denied" | "failed";
export type AuditScope = "hub" | "project" | "record" | "session" | "system";

export interface AuditEvent {
  readonly actorId: string;
  readonly sessionId?: string | null;
  readonly action: string;
  readonly scopeType: AuditScope;
  readonly scopeId?: string | null;
  readonly outcome: AuditOutcome;
  readonly correlationId: string;
  readonly occurredAt?: string;
}

export type AuditSink = (event: AuditEvent) => Promise<string | void>;

let installedAuditSink: AuditSink | null = null;

/** Composition/test seam; production defaults to the append-only database log. */
export function installAuditSink(sink: AuditSink): () => void {
  if (installedAuditSink !== null && installedAuditSink !== sink) {
    throw new Error("An audit sink is already installed.");
  }
  installedAuditSink = sink;
  return () => {
    if (installedAuditSink === sink) installedAuditSink = null;
  };
}

function bounded(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${field} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

export function requestCorrelationId(candidate: string | null): string {
  return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate)
    ? candidate.toLowerCase()
    : randomUUID();
}

/**
 * Writes the immutable audit projection only. Arbitrary metadata and customer
 * content are intentionally not accepted by this API.
 */
export async function appendAuditEvent(
  sql: SqlExecutor,
  event: AuditEvent,
): Promise<string> {
  const id = randomUUID();
  const occurredAt = event.occurredAt ?? new Date().toISOString();
  if (!Number.isFinite(new Date(occurredAt).getTime())) {
    throw new TypeError("occurredAt must be an ISO-compatible timestamp.");
  }
  await sql.query(
    `INSERT INTO audit_log (
      id, occurred_at, actor_id, session_id, action,
      scope_type, scope_id, outcome, correlation_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      occurredAt,
      bounded(event.actorId, "actorId", 256),
      event.sessionId ? bounded(event.sessionId, "sessionId", 512) : null,
      bounded(event.action, "action", 128),
      event.scopeType,
      event.scopeId ? bounded(event.scopeId, "scopeId", 512) : null,
      event.outcome,
      bounded(event.correlationId, "correlationId", 128),
    ],
  );
  return id;
}

/**
 * Default authentication sink. Database composition writes the append-only
 * application log; a custom session store must install its own durable sink.
 */
export async function appendDatabaseAuditEvent(event: AuditEvent): Promise<string> {
  if (installedAuditSink) {
    const id = await installedAuditSink(event);
    return typeof id === "string" ? id : "installed-audit-sink";
  }
  if (process.env.APS_SESSION_STORE !== "database") {
    throw new Error("A durable authentication audit sink is not installed.");
  }
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL?.trim()) {
    throw new Error("Shared authentication audit persistence is not configured.");
  }
  const { getSql } = await import("@/lib/db");
  return appendAuditEvent(await getSql(), event);
}
