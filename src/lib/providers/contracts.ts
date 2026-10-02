import type {
  Company,
  Hub,
  LocationNode,
  Project,
  RiskRecord,
  RiskRelationship,
} from "../canonical/types";

/**
 * Permission gaps and genuine empty datasets are different states in Forma.
 * Provider callers must branch on this union before they can reach `data`.
 */
export type CoverageResult<T> =
  | {
      readonly state: "available";
      readonly data: T;
      readonly observedAt: string;
      readonly warnings: readonly string[];
    }
  | {
      readonly state: "empty";
      readonly observedAt: string;
      readonly reason: string;
      readonly warnings: readonly string[];
    }
  | {
      readonly state: "not-applicable";
      readonly observedAt: string;
      readonly reason: string;
      readonly warnings: readonly string[];
    }
  | {
      readonly state: "restricted";
      readonly observedAt: string;
      readonly reason: string;
      readonly warnings: readonly string[];
    }
  | {
      readonly state: "unreachable";
      readonly observedAt: string;
      readonly reason: string;
      readonly retryable: boolean;
      readonly warnings: readonly string[];
    };

export function available<T>(data: T, observedAt = new Date().toISOString()): CoverageResult<T> {
  return { state: "available", data, observedAt, warnings: [] };
}

export function empty<T>(reason: string, observedAt = new Date().toISOString()): CoverageResult<T> {
  return { state: "empty", reason, observedAt, warnings: [] };
}

export type ProviderMode = "demo" | "autodesk";
export type HubRegion = "US" | "EMEA";

/** A provider-internal bearer token. It must never leave server-side provider code. */
export interface ApsAccessContext {
  readonly accessToken: string;
  readonly userId: string | null;
}

export interface AuthorizationAttempt {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly expiresAt: string;
  readonly returnTo: string;
}

export interface AuthorizationCallback {
  readonly code: string;
  readonly state: string;
  readonly expectedState: string;
  readonly codeVerifier: string;
}

export interface ApsSessionTokens extends ApsAccessContext {
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly grantedScopes: readonly string[];
}

export interface ApsAuthProvider {
  readonly mode: ProviderMode;
  beginAuthorization(returnTo: string): Promise<AuthorizationAttempt>;
  exchangeAuthorizationCode(callback: AuthorizationCallback): Promise<ApsSessionTokens>;
  refresh(sessionId: string, refreshToken: string): Promise<ApsSessionTokens>;
  resolveHubRegion(
    context: ApsAccessContext,
    hubId: string,
  ): Promise<CoverageResult<HubRegion>>;
}

export const FULL_SNAPSHOT_SERVICE_GROUPS = [
  "admin",
  "iq",
  "issues",
  "rfis",
  "submittalsacc",
  "forms",
  "checklists",
  "cost",
  "locations",
  "relationships",
  "schedule",
  "reviews",
] as const;

export const CDC_SERVICE_GROUPS = [
  "cdcissues",
  "cdcrfis",
  "cdcsubmittalsacc",
  "cdccost",
] as const;

export type FullSnapshotServiceGroup = (typeof FULL_SNAPSHOT_SERVICE_GROUPS)[number];
export type CdcServiceGroup = (typeof CDC_SERVICE_GROUPS)[number];

export interface KnownJobBudget {
  readonly state: "known";
  /** All account or user jobs observed in the rolling 24-hour window. */
  readonly consumed: number;
}

export interface UnknownJobBudget {
  readonly state: "unknown";
  readonly reason: string;
}

export type JobBudget = KnownJobBudget | UnknownJobBudget;
export type SubmissionPurpose = "scheduled" | "retry";

/**
 * A durable reservation made before a non-idempotent Data Connector request is
 * dispatched. Reservations are intentionally never released early: after a
 * crash or network failure Autodesk may still have accepted the request.
 */
export interface DataConnectorBudgetReservation {
  readonly id: string;
}

export interface DataConnectorBudgetGate {
  reserve(
    purpose: SubmissionPurpose,
    observedConsumed: number,
  ): Promise<DataConnectorBudgetReservation>;
  markAccepted(reservationId: string, requestId: string): Promise<void>;
  markAmbiguous(reservationId: string): Promise<void>;
  /** Marks a recognized terminal job; the slot still counts for 24 hours. */
  markTerminal(requestId: string): Promise<void>;
}

export type DataConnectorProjectScope =
  | Readonly<{
      /** Explicit server-side authorization for an account-wide extract. */
      authorizeHubWide: true;
      projectIds?: never;
      accessibleProjectIds?: never;
    }>
  | Readonly<{
      authorizeHubWide?: false;
      /** Non-empty targeted population included in the extract request. */
      projectIds: readonly string[];
      /** Current server-authorized project population; must contain every target. */
      accessibleProjectIds: readonly string[];
    }>;

export type FullSnapshotRequest = Readonly<{
  readonly description: string;
  readonly serviceGroups: readonly FullSnapshotServiceGroup[];
  readonly budget: JobBudget;
  readonly purpose?: SubmissionPurpose;
}> & DataConnectorProjectScope;

export type ActivitiesExtractRequest = Readonly<{
  readonly description: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly budget: JobBudget;
  readonly purpose?: SubmissionPurpose;
}> & DataConnectorProjectScope;

export type CdcExtractRequest = Readonly<{
  readonly description: string;
  readonly serviceGroups: readonly CdcServiceGroup[];
  readonly startDate: string;
  readonly endDate: string;
  readonly budget: JobBudget;
  readonly purpose?: SubmissionPurpose;
}> & DataConnectorProjectScope;

export interface DataConnectorRequestReceipt {
  readonly requestId: string;
  readonly submittedAt: string;
}

export type DataConnectorJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown";

export interface DataConnectorJob {
  readonly id: string;
  readonly requestId: string | null;
  readonly state: DataConnectorJobState;
  readonly createdAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Kept for diagnosis, but never interpreted as success unless policy recognises it. */
  readonly sourceStatus: string | null;
  readonly sourceCompletionStatus: string | null;
}

/** Deliberately excludes the signed download URL. */
export interface ExtractFileDescriptor {
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly createdAt: string | null;
}

export interface DataConnectorProvider {
  readonly mode: ProviderMode;
  submitFullSnapshot(request: FullSnapshotRequest): Promise<DataConnectorRequestReceipt>;
  submitActivities(request: ActivitiesExtractRequest): Promise<DataConnectorRequestReceipt>;
  submitCdc(request: CdcExtractRequest): Promise<DataConnectorRequestReceipt>;
  /** A newly accepted request may briefly have no spawned job. */
  findLatestJobForRequest(requestId: string): Promise<CoverageResult<DataConnectorJob>>;
  getJob(jobId: string): Promise<CoverageResult<DataConnectorJob>>;
  listFiles(jobId: string): Promise<CoverageResult<readonly ExtractFileDescriptor[]>>;
  /** Resolves a fresh signed URL internally and returns only bytes to the caller. */
  downloadFile(jobId: string, fileName: string): Promise<Uint8Array>;
}

export interface IssuesProvider {
  readonly mode: ProviderMode;
  listIssues(projectId: string): Promise<CoverageResult<readonly RiskRecord[]>>;
}

export interface RfiProvider {
  readonly mode: ProviderMode;
  listRfis(projectId: string): Promise<CoverageResult<readonly RiskRecord[]>>;
}

export interface FormsProvider {
  readonly mode: ProviderMode;
  listForms(projectId: string): Promise<CoverageResult<readonly RiskRecord[]>>;
}

export interface ReviewsProvider {
  readonly mode: ProviderMode;
  listReviews(projectId: string): Promise<CoverageResult<readonly RiskRecord[]>>;
}

export interface SubmittalsProvider {
  readonly mode: ProviderMode;
  listSubmittals(projectId: string): Promise<CoverageResult<readonly RiskRecord[]>>;
}

/** Schedule is extract-only. There is intentionally no refresh method. */
export interface ScheduleProvider {
  readonly mode: ProviderMode;
  listActivitiesFromLatestExtract(
    projectId: string,
  ): Promise<CoverageResult<readonly RiskRecord[]>>;
}

export interface CanonicalSnapshot {
  readonly hub: Hub;
  readonly projects: readonly Project[];
  readonly companies: readonly Company[];
  readonly locations: readonly LocationNode[];
  readonly records: readonly RiskRecord[];
  readonly relationships: readonly RiskRelationship[];
}

export interface ProviderSet {
  readonly mode: ProviderMode;
  readonly auth: ApsAuthProvider;
  readonly dataConnector: DataConnectorProvider;
  readonly issues: IssuesProvider;
  readonly rfis: RfiProvider;
  readonly forms: FormsProvider;
  readonly reviews: ReviewsProvider;
  readonly submittals: SubmittalsProvider;
  readonly schedule: ScheduleProvider;
}
