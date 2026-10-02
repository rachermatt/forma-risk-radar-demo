import { randomUUID } from "node:crypto";
import type { Sql } from "../db/sql";
import {
  DATA_CONNECTOR_DAILY_JOB_LIMIT,
  DATA_CONNECTOR_RETRY_RESERVE,
} from "./budget";
import type {
  DataConnectorBudgetGate,
  DataConnectorBudgetReservation,
  SubmissionPurpose,
} from "./contracts";
import { DataConnectorBudgetError, ProviderOperationError } from "./errors";

const DAY_MS = 24 * 60 * 60 * 1_000;
const BUDGET_LEDGER_LOCK_ID = 2_088_642_302;

export interface SqlDataConnectorBudgetGateOptions {
  readonly accountId: string;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/**
 * PostgreSQL-backed rolling quota gate. The advisory lock and insert share one
 * transaction, so parallel application replicas cannot oversubscribe a stale
 * caller-side budget snapshot.
 */
export class SqlDataConnectorBudgetGate implements DataConnectorBudgetGate {
  readonly #sql: Sql;
  readonly #accountId: string;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(sql: Sql, options: SqlDataConnectorBudgetGateOptions) {
    if (!options.accountId.trim()) {
      throw new DataConnectorBudgetError("A Data Connector account ID is required for the budget ledger.");
    }
    this.#sql = sql;
    this.#accountId = options.accountId;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
  }

  async reserve(
    purpose: SubmissionPurpose,
    observedConsumed: number,
  ): Promise<DataConnectorBudgetReservation> {
    if (!Number.isInteger(observedConsumed) || observedConsumed < 0) {
      throw new DataConnectorBudgetError("Data Connector job usage is invalid.");
    }
    const reservedAt = new Date(this.#now());
    const cutoff = new Date(reservedAt.getTime() - DAY_MS);
    const ceiling = purpose === "retry"
      ? DATA_CONNECTOR_DAILY_JOB_LIMIT
      : DATA_CONNECTOR_DAILY_JOB_LIMIT - DATA_CONNECTOR_RETRY_RESERVE;
    const id = this.#newId();

    await this.#sql.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock($1)", [BUDGET_LEDGER_LOCK_ID]);
      const result = await transaction.query<{ reserved: number }>(
        `SELECT count(*)::int AS reserved
         FROM data_connector_budget_reservations
         WHERE account_id = $1 AND reserved_at > $2`,
        [this.#accountId, cutoff],
      );
      const inFlight = await transaction.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM data_connector_budget_reservations
           WHERE account_id = $1
             AND reserved_at > $2
             AND state IN ('reserved', 'accepted', 'ambiguous')
         ) AS present`,
        [this.#accountId, cutoff],
      );
      if (inFlight.rows[0]?.present) {
        throw new DataConnectorBudgetError(
          "A Data Connector request for this account is already in flight or has an ambiguous outcome.",
        );
      }
      // Adding the caller's latest APS observation is deliberately
      // conservative: if APS already reflects a local reservation, it may be
      // double-counted, but the limit can never be oversubscribed.
      const effectiveConsumed = observedConsumed + (result.rows[0]?.reserved ?? 0);
      if (effectiveConsumed >= ceiling) {
        throw new DataConnectorBudgetError(
          purpose === "retry"
            ? "The Data Connector rolling job limit is exhausted."
            : "The Data Connector retry reserve has been reached.",
        );
      }
      await transaction.query(
        `INSERT INTO data_connector_budget_reservations (
          id, account_id, purpose, observed_consumed, reserved_at, state, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'reserved', $5)`,
        [id, this.#accountId, purpose, observedConsumed, reservedAt],
      );
    });
    return { id };
  }

  async markAccepted(reservationId: string, requestId: string): Promise<void> {
    if (!requestId.trim()) {
      throw new ProviderOperationError("dc-budget-receipt-invalid", "A Data Connector request ID is required.");
    }
    const result = await this.#sql.query(
      `UPDATE data_connector_budget_reservations
       SET state = 'accepted', request_id = $1, updated_at = $2
       WHERE id = $3 AND account_id = $4 AND state IN ('reserved', 'ambiguous')`,
      [requestId, new Date(this.#now()), reservationId, this.#accountId],
    );
    if (result.rowCount !== 1) {
      throw new ProviderOperationError("dc-budget-reservation-missing", "The Data Connector reservation was not found.");
    }
  }

  async markAmbiguous(reservationId: string): Promise<void> {
    const result = await this.#sql.query(
      `UPDATE data_connector_budget_reservations
       SET state = CASE WHEN state IN ('accepted', 'settled') THEN state ELSE 'ambiguous' END,
           updated_at = $1
       WHERE id = $2 AND account_id = $3`,
      [new Date(this.#now()), reservationId, this.#accountId],
    );
    if (result.rowCount !== 1) {
      throw new ProviderOperationError("dc-budget-reservation-missing", "The Data Connector reservation was not found.");
    }
  }

  async markTerminal(requestId: string): Promise<void> {
    const result = await this.#sql.query(
      `UPDATE data_connector_budget_reservations
       SET state = 'settled', updated_at = $1
       WHERE request_id = $2 AND account_id = $3 AND state = 'accepted'`,
      [new Date(this.#now()), requestId, this.#accountId],
    );
    if (result.rowCount !== 1) {
      throw new ProviderOperationError("dc-budget-reservation-missing", "The Data Connector request reservation was not found.");
    }
  }
}
