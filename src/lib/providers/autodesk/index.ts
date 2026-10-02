import type { ApsAccessContext, DataConnectorBudgetGate, ProviderSet } from "../contracts";
import { AutodeskApsAuthProvider } from "./auth";
import type { AutodeskProviderConfig } from "./config";
import { AutodeskDataConnectorProvider, type DataConnectorStatePolicy } from "./data-connector";
import {
  AutodeskFormsProvider,
  AutodeskIssuesProvider,
  AutodeskReviewsProvider,
  AutodeskRfiProvider,
  AutodeskScheduleProvider,
  AutodeskSubmittalsProvider,
  type AutodeskCanonicalRecordSource,
} from "./records";
import { ApsReadTransport, type FetchLike } from "./transport";

export interface AutodeskProviderDependencies {
  readonly accessContext: () => Promise<ApsAccessContext>;
  readonly refreshAccessContext?: () => Promise<void>;
  readonly records: AutodeskCanonicalRecordSource;
  readonly fetch?: FetchLike;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly jobStatePolicy?: DataConnectorStatePolicy;
  readonly dataConnectorBudgetGate?: DataConnectorBudgetGate;
}

export function createAutodeskProviders(
  config: AutodeskProviderConfig,
  dependencies: AutodeskProviderDependencies,
): ProviderSet {
  const transport = new ApsReadTransport({
    accessContext: dependencies.accessContext,
    refreshAccessContext: dependencies.refreshAccessContext,
    region: config.region,
    fetch: dependencies.fetch,
    sleep: dependencies.sleep,
    random: dependencies.random,
  });

  return {
    mode: "autodesk",
    auth: new AutodeskApsAuthProvider(config, {
      fetch: dependencies.fetch,
      now: dependencies.now,
    }),
    dataConnector: new AutodeskDataConnectorProvider(config, transport, {
      statePolicy: dependencies.jobStatePolicy,
      downloadFetch: dependencies.fetch,
      now: dependencies.now,
      budgetGate: dependencies.dataConnectorBudgetGate,
      allowedDownloadHosts: config.dataConnectorDownloadHosts,
    }),
    issues: new AutodeskIssuesProvider(dependencies.records),
    rfis: new AutodeskRfiProvider(dependencies.records),
    forms: new AutodeskFormsProvider(dependencies.records),
    reviews: new AutodeskReviewsProvider(dependencies.records),
    submittals: new AutodeskSubmittalsProvider(dependencies.records),
    schedule: new AutodeskScheduleProvider(dependencies.records),
  };
}

export * from "./auth";
export * from "./config";
export * from "./data-connector";
export * from "./records";
export * from "./transport";
