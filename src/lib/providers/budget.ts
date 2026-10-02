import type { JobBudget, KnownJobBudget, SubmissionPurpose } from "./contracts";
import { DataConnectorBudgetError } from "./errors";

export const DATA_CONNECTOR_DAILY_JOB_LIMIT = 24;
export const DATA_CONNECTOR_RETRY_RESERVE = 8;

/**
 * Refuses scheduled work before it can consume the eight-slot retry reserve.
 * An unknown ledger is denied: guessing low would risk exhausting the account.
 */
export function assertDataConnectorBudget(
  budget: JobBudget,
  purpose: SubmissionPurpose = "scheduled",
): asserts budget is KnownJobBudget {
  if (budget.state === "unknown") {
    throw new DataConnectorBudgetError(
      "Data Connector job usage is unknown; refusing to submit a new extract.",
    );
  }

  if (!Number.isInteger(budget.consumed) || budget.consumed < 0) {
    throw new DataConnectorBudgetError("Data Connector job usage is invalid.");
  }

  const ceiling =
    purpose === "retry"
      ? DATA_CONNECTOR_DAILY_JOB_LIMIT
      : DATA_CONNECTOR_DAILY_JOB_LIMIT - DATA_CONNECTOR_RETRY_RESERVE;
  if (budget.consumed >= ceiling) {
    throw new DataConnectorBudgetError(
      purpose === "retry"
        ? "The Data Connector rolling job limit is exhausted."
        : "The Data Connector retry reserve has been reached.",
    );
  }
}
