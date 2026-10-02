import { getDemoDataset } from "../../demo/generator";
import type { DemoDataset } from "../../demo/types";
import type { RiskDomain, RiskRecord, SourceRecordKind } from "../../canonical/types";
import { assertDataConnectorBudget } from "../budget";
import {
  available,
  empty,
  type ActivitiesExtractRequest,
  type ApsAccessContext,
  type ApsAuthProvider,
  type ApsSessionTokens,
  type AuthorizationAttempt,
  type AuthorizationCallback,
  type CdcExtractRequest,
  type CoverageResult,
  type DataConnectorJob,
  type DataConnectorProvider,
  type DataConnectorRequestReceipt,
  type ExtractFileDescriptor,
  type FormsProvider,
  type FullSnapshotRequest,
  type HubRegion,
  type IssuesProvider,
  type ProviderSet,
  type ReviewsProvider,
  type RfiProvider,
  type ScheduleProvider,
  type SubmittalsProvider,
} from "../contracts";
import { ProviderOperationError } from "../errors";

const DEMO_AUTH_MESSAGE = "Autodesk authorization is unavailable while DATA_MODE=demo.";

export class DemoApsAuthProvider implements ApsAuthProvider {
  readonly mode = "demo" as const;

  async beginAuthorization(_returnTo: string): Promise<AuthorizationAttempt> {
    throw new ProviderOperationError("demo-auth-disabled", DEMO_AUTH_MESSAGE);
  }

  async exchangeAuthorizationCode(_callback: AuthorizationCallback): Promise<ApsSessionTokens> {
    throw new ProviderOperationError("demo-auth-disabled", DEMO_AUTH_MESSAGE);
  }

  async refresh(_sessionId: string, _refreshToken: string): Promise<ApsSessionTokens> {
    throw new ProviderOperationError("demo-auth-disabled", DEMO_AUTH_MESSAGE);
  }

  async resolveHubRegion(
    _context: ApsAccessContext,
    _hubId: string,
  ): Promise<CoverageResult<HubRegion>> {
    return available("US", getDemoDataset().asOf);
  }
}

export class DemoDataConnectorProvider implements DataConnectorProvider {
  readonly mode = "demo" as const;
  readonly #dataset: DemoDataset;
  #sequence = 0;
  readonly #submittedRequestIds = new Set<string>();

  constructor(dataset = getDemoDataset()) {
    this.#dataset = dataset;
  }

  async submitFullSnapshot(request: FullSnapshotRequest): Promise<DataConnectorRequestReceipt> {
    return this.#submit(request.budget, request.purpose);
  }

  async submitActivities(request: ActivitiesExtractRequest): Promise<DataConnectorRequestReceipt> {
    return this.#submit(request.budget, request.purpose);
  }

  async submitCdc(request: CdcExtractRequest): Promise<DataConnectorRequestReceipt> {
    return this.#submit(request.budget, request.purpose);
  }

  async getJob(jobId: string): Promise<CoverageResult<DataConnectorJob>> {
    return available(
      {
        id: jobId,
        requestId: jobId.replace("job", "request"),
        state: "succeeded",
        createdAt: this.#dataset.ingestion.startedAt,
        startedAt: this.#dataset.ingestion.startedAt,
        completedAt: this.#dataset.ingestion.completedAt,
        sourceStatus: "synthetic-complete",
        sourceCompletionStatus: "synthetic-success",
      },
      this.#dataset.asOf,
    );
  }

  async findLatestJobForRequest(
    requestId: string,
  ): Promise<CoverageResult<DataConnectorJob>> {
    if (!this.#submittedRequestIds.has(requestId)) {
      return empty(
        "The accepted request has not produced a Data Connector job yet.",
        this.#dataset.asOf,
      );
    }
    const sequence = requestId.replace("demo-request-", "");
    return this.getJob(`demo-job-${sequence}`);
  }

  async listFiles(_jobId: string): Promise<CoverageResult<readonly ExtractFileDescriptor[]>> {
    return available(
      [{ name: "demo-canonical.json", sizeBytes: null, createdAt: this.#dataset.asOf }],
      this.#dataset.asOf,
    );
  }

  async downloadFile(_jobId: string, fileName: string): Promise<Uint8Array> {
    if (fileName !== "demo-canonical.json") {
      throw new ProviderOperationError("demo-file-missing", "The requested demo extract file does not exist.");
    }
    return new TextEncoder().encode(JSON.stringify({ mode: "demo", asOf: this.#dataset.asOf }));
  }

  #submit(
    budget: FullSnapshotRequest["budget"],
    purpose: FullSnapshotRequest["purpose"],
  ): DataConnectorRequestReceipt {
    assertDataConnectorBudget(budget, purpose);
    this.#sequence += 1;
    const requestId = `demo-request-${this.#sequence}`;
    this.#submittedRequestIds.add(requestId);
    return {
      requestId,
      submittedAt: this.#dataset.asOf,
    };
  }
}

class DemoRecordProvider {
  readonly mode = "demo" as const;
  readonly #dataset: DemoDataset;

  constructor(dataset: DemoDataset) {
    this.#dataset = dataset;
  }

  records(
    projectId: string,
    kinds: readonly SourceRecordKind[],
    domain?: RiskDomain,
  ): CoverageResult<readonly RiskRecord[]> {
    const project = this.#dataset.projects.find((candidate) => candidate.project.id === projectId)?.project;
    if (!project?.accessible) {
      return {
        state: "restricted",
        observedAt: this.#dataset.asOf,
        reason: "The project is not in the current provider coverage set.",
        warnings: [],
      };
    }
    if (domain && !project.availableDomains.includes(domain)) {
      return {
        state: "not-applicable",
        observedAt: this.#dataset.asOf,
        reason: `The ${domain} domain is not available for this project.`,
        warnings: [],
      };
    }

    const records = this.#dataset.records.filter(
      (record) => record.projectId === projectId && kinds.includes(record.kind),
    );
    return records.length > 0
      ? available(records, this.#dataset.asOf)
      : empty("The provider reached this scope and found no records.", this.#dataset.asOf);
  }
}

export function createDemoProviders(dataset = getDemoDataset()): ProviderSet {
  const records = new DemoRecordProvider(dataset);
  const issues: IssuesProvider = {
    mode: "demo",
    listIssues: async (projectId) => records.records(projectId, ["issue"]),
  };
  const rfis: RfiProvider = {
    mode: "demo",
    listRfis: async (projectId) => records.records(projectId, ["rfi"], "rfi"),
  };
  const forms: FormsProvider = {
    mode: "demo",
    listForms: async (projectId) => records.records(projectId, ["form"]),
  };
  const reviews: ReviewsProvider = {
    mode: "demo",
    listReviews: async (projectId) => records.records(projectId, ["review"]),
  };
  const submittals: SubmittalsProvider = {
    mode: "demo",
    listSubmittals: async (projectId) => records.records(projectId, ["submittal"], "submittal"),
  };
  const schedule: ScheduleProvider = {
    mode: "demo",
    listActivitiesFromLatestExtract: async (projectId) =>
      records.records(projectId, ["schedule-activity"], "schedule"),
  };

  return {
    mode: "demo",
    auth: new DemoApsAuthProvider(),
    dataConnector: new DemoDataConnectorProvider(dataset),
    issues,
    rfis,
    forms,
    reviews,
    submittals,
    schedule,
  };
}
