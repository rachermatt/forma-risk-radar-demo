import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "@/lib/db/sql";
import {
  SESSION_PURGE_BATCH_SIZE,
  sessionExpiryCutoffs,
  type ExpiredSession,
} from "@/lib/auth/session";

export const SESSION_SWEEP_MAX_BATCHES = 100;

export interface SessionSweepResult {
  readonly removedCount: number;
  readonly batches: number;
  /** False means the hard run cap was reached and another run is required. */
  readonly complete: boolean;
}

interface SessionSweepCursor {
  readonly lastSeenAt: number;
  readonly createdAt: number;
  readonly id: string;
}

interface SessionSweepRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string;
  readonly last_seen_at: string | number;
  readonly created_at: string | number;
  readonly was_deleted: boolean;
}

interface SessionSweepBatch {
  readonly expired: readonly ExpiredSession[];
  readonly selectedCount: number;
  readonly skippedCount: number;
  readonly cursor: SessionSweepCursor | null;
}

function assertPurgeLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError("Session purge limit must be an integer between 1 and 1000.");
  }
}

function safeTimestamp(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError("Stored session timestamps must be non-negative safe integers.");
  }
  return parsed;
}

async function scanExpiredSessionRows(
  sql: SqlExecutor,
  absoluteCutoff: number,
  idleCutoff: number,
  limit: number,
  cursor: SessionSweepCursor | null,
): Promise<SessionSweepBatch> {
  assertPurgeLimit(limit);
  const scanned = await sql.query<SessionSweepRow>(
    `WITH candidates AS MATERIALIZED (
       SELECT id, account_id, last_seen_at, created_at
       FROM aps_sessions
       WHERE (created_at <= $1 OR last_seen_at <= $2)
         AND (
           $4::bigint IS NULL OR
           (last_seen_at, created_at, id) > ($4::bigint, $5::bigint, $6::text)
         )
       ORDER BY last_seen_at, created_at, id
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     ), unlocked AS MATERIALIZED (
       SELECT id
       FROM candidates
       WHERE pg_try_advisory_xact_lock(hashtext(id))
     ), deleted AS (
       DELETE FROM aps_sessions AS session
       USING unlocked
       WHERE session.id = unlocked.id
         AND (session.created_at <= $1 OR session.last_seen_at <= $2)
       RETURNING session.id
     )
     SELECT candidates.id, candidates.account_id,
            candidates.last_seen_at, candidates.created_at,
            (deleted.id IS NOT NULL) AS was_deleted
     FROM candidates
     LEFT JOIN deleted ON deleted.id = candidates.id
     ORDER BY candidates.last_seen_at, candidates.created_at, candidates.id`,
    [
      absoluteCutoff,
      idleCutoff,
      limit,
      cursor?.lastSeenAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
    ],
  );
  const expired = scanned.rows
    .filter((row) => row.was_deleted)
    .map((row) => Object.freeze({ id: row.id, accountId: row.account_id }));
  const last = scanned.rows.at(-1);
  return Object.freeze({
    expired: Object.freeze(expired),
    selectedCount: scanned.rows.length,
    skippedCount: scanned.rows.length - expired.length,
    cursor: last
      ? Object.freeze({
          lastSeenAt: safeTimestamp(last.last_seen_at),
          createdAt: safeTimestamp(last.created_at),
          id: last.id,
        })
      : null,
  });
}

/**
 * Deletes one deterministic, bounded batch. Callers that need a durable audit
 * record must run this inside the same transaction as their audit insert.
 */
export async function purgeExpiredSessionRows(
  sql: SqlExecutor,
  absoluteCutoff: number,
  idleCutoff: number,
  limit: number,
): Promise<readonly ExpiredSession[]> {
  return (await scanExpiredSessionRows(
    sql,
    absoluteCutoff,
    idleCutoff,
    limit,
    null,
  )).expired;
}

async function appendExpiredSessionAudits(
  sql: SqlExecutor,
  expired: readonly ExpiredSession[],
  now: number,
  correlationId: string,
): Promise<void> {
  if (expired.length === 0) return;

  const occurredAt = new Date(now).toISOString();
  const ids = expired.map(() => randomUUID());
  const sessionIds = expired.map((session) => session.id);
  const accountIds = expired.map((session) => session.accountId);
  await sql.query(
    `INSERT INTO audit_log (
       id, occurred_at, actor_id, session_id, action,
       scope_type, scope_id, outcome, correlation_id
     )
     SELECT id, $1, 'system', session_id,
            'authentication.session-expired', 'hub', account_id,
            'succeeded', $2
     FROM unnest($3::text[], $4::text[], $5::text[])
       AS expired(id, session_id, account_id)`,
    [occurredAt, correlationId, ids, sessionIds, accountIds],
  );
}

/**
 * Runs within a caller-owned transaction so expired-session deletion and its
 * append-only audit records either commit together or both roll back.
 */
export async function sweepExpiredSessionsWithAudit(
  sql: SqlExecutor,
  now: number,
  correlationId: string,
  limit = SESSION_PURGE_BATCH_SIZE,
): Promise<readonly ExpiredSession[]> {
  const cutoffs = sessionExpiryCutoffs(now);
  const expired = await purgeExpiredSessionRows(
    sql,
    cutoffs.absoluteCutoff,
    cutoffs.idleCutoff,
    limit,
  );
  await appendExpiredSessionAudits(sql, expired, now, correlationId);
  return expired;
}

/**
 * Drains more than one batch while retaining a hard per-run ceiling. The
 * caller owns the surrounding transaction and can commit a partial, explicitly
 * reported run if the ceiling is reached.
 */
export async function sweepExpiredSessionsToBound(
  sql: SqlExecutor,
  now: number,
  correlationId: string,
  batchSize = SESSION_PURGE_BATCH_SIZE,
  maxBatches = SESSION_SWEEP_MAX_BATCHES,
): Promise<SessionSweepResult> {
  assertPurgeLimit(batchSize);
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1_000) {
    throw new TypeError("Session sweep maxBatches must be an integer between 1 and 1000.");
  }

  const cutoffs = sessionExpiryCutoffs(now);
  let removedCount = 0;
  let skippedCount = 0;
  let cursor: SessionSweepCursor | null = null;
  for (let batch = 1; batch <= maxBatches; batch += 1) {
    const scanned = await scanExpiredSessionRows(
      sql,
      cutoffs.absoluteCutoff,
      cutoffs.idleCutoff,
      batchSize,
      cursor,
    );
    await appendExpiredSessionAudits(
      sql,
      scanned.expired,
      now,
      correlationId,
    );
    removedCount += scanned.expired.length;
    skippedCount += scanned.skippedCount;
    cursor = scanned.cursor;
    if (scanned.selectedCount < batchSize) {
      return Object.freeze({
        removedCount,
        batches: batch,
        complete: skippedCount === 0,
      });
    }
  }

  const remaining = await sql.query<{ remaining: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM aps_sessions
       WHERE created_at <= $1 OR last_seen_at <= $2
     ) AS remaining`,
    [cutoffs.absoluteCutoff, cutoffs.idleCutoff],
  );
  return Object.freeze({
    removedCount,
    batches: maxBatches,
    complete: skippedCount === 0 && remaining.rows[0]?.remaining !== true,
  });
}
