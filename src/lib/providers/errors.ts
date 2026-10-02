export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export class ProviderOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ProviderOperationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class DataConnectorBudgetError extends ProviderOperationError {
  constructor(message: string) {
    super("dc-budget-unavailable", message, false);
    this.name = "DataConnectorBudgetError";
  }
}
