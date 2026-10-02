import { isIP } from "node:net";
import { assertDataConnectorBudget } from "../budget";
import {
  CDC_SERVICE_GROUPS,
  FULL_SNAPSHOT_SERVICE_GROUPS,
  available,
  empty,
  type ActivitiesExtractRequest,
  type CdcExtractRequest,
  type CoverageResult,
  type DataConnectorBudgetGate,
  type DataConnectorJob,
  type DataConnectorJobState,
  type DataConnectorProvider,
  type DataConnectorRequestReceipt,
  type ExtractFileDescriptor,
  type FullSnapshotRequest,
} from "../contracts";
import { DataConnectorBudgetError, ProviderOperationError } from "../errors";
import type { AutodeskProviderConfig } from "./config";
import {
  ApsReadTransport,
  ApsTransportError,
  type FetchLike,
  type JsonObject,
  type JsonValue,
} from "./transport";

export interface DataConnectorStatePolicy {
  readonly queuedStatuses: readonly string[];
  readonly runningStatuses: readonly string[];
  readonly terminalStatuses: readonly string[];
  readonly successfulCompletionStatuses: readonly string[];
  readonly failedCompletionStatuses: readonly string[];
}

/** Until live observation confirms literal tokens, an unfamiliar state remains unknown. */
export const FAIL_SAFE_JOB_STATE_POLICY: DataConnectorStatePolicy = {
  queuedStatuses: [],
  runningStatuses: [],
  terminalStatuses: [],
  successfulCompletionStatuses: [],
  failedCompletionStatuses: [],
};

export interface DataConnectorOptions {
  readonly statePolicy?: DataConnectorStatePolicy;
  readonly downloadFetch?: FetchLike;
  readonly now?: () => number;
  /** Required for every live submission; omission fails closed before dispatch. */
  readonly budgetGate?: DataConnectorBudgetGate;
  readonly maxDownloadBytes?: number;
  readonly downloadTimeoutMs?: number;
  /** Exact operator-approved DNS hosts; empty keeps downloads activation-gated. */
  readonly allowedDownloadHosts?: readonly string[];
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_REDIRECTS = 3;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STRICT_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function validatedDownloadHosts(hosts: readonly string[]): ReadonlySet<string> {
  const normalized = hosts
    .map((host) => host.trim().toLowerCase().replace(/\.$/u, ""))
    .filter(Boolean);
  if (new Set(normalized).size !== normalized.length) {
    throw new ProviderOperationError(
      "dc-download-host-config-invalid",
      "Data Connector download hosts must be unique exact DNS hostnames.",
    );
  }
  for (const host of normalized) {
    if (
      host.length > 253 ||
      isIP(host) !== 0 ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host)
    ) {
      throw new ProviderOperationError(
        "dc-download-host-config-invalid",
        "Data Connector download hosts must be unique exact DNS hostnames.",
      );
    }
  }
  return new Set(normalized);
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNonBlankStringField(
  object: JsonObject,
  key: string,
  code: string,
  message: string,
): string | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.length > 0 && value.trim() === value) return value;
  throw new ProviderOperationError(code, message);
}

function requiredNonBlankStringField(
  object: JsonObject,
  key: string,
  code: string,
  message: string,
): string {
  const value = optionalNonBlankStringField(object, key, code, message);
  if (value === null) throw new ProviderOperationError(code, message);
  return value;
}

function optionalTimestampField(
  object: JsonObject,
  key: string,
  code: string,
  message: string,
): string | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !STRICT_UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new ProviderOperationError(code, message);
  }
  return value;
}

function numberField(object: JsonObject, key: string): number | null {
  const value = object[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0 && value.trim() === value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function requiredSafeByteSizeField(
  object: JsonObject,
  key: string,
  code: string,
  message: string,
): number {
  const value = numberField(object, key);
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw new ProviderOperationError(code, message);
  }
  return value;
}

function objectRows(value: JsonValue | undefined, code: string, message: string): readonly JsonObject[] {
  if (!Array.isArray(value) || value.some((entry) => !isObject(entry))) {
    throw new ProviderOperationError(code, message);
  }
  return value;
}

function jobRows(value: JsonValue): readonly JsonObject[] {
  if (!isObject(value)) {
    throw new ProviderOperationError(
      "dc-job-listing-malformed",
      "Autodesk returned an unreadable Data Connector job listing.",
    );
  }
  const rows = objectRows(
    value.results,
    "dc-job-listing-malformed",
    "Autodesk returned a Data Connector job listing with malformed entries.",
  );
  for (const entry of rows) {
    requiredNonBlankStringField(
      entry,
      "id",
      "dc-job-listing-malformed",
      "Autodesk returned a Data Connector job entry without an ID.",
    );
  }
  return rows;
}

function fileRows(value: JsonValue): readonly JsonObject[] {
  return objectRows(
    value,
    "dc-file-listing-malformed",
    "Autodesk returned a Data Connector file listing with malformed entries.",
  );
}

function validatedProjectIds(
  projectIds: readonly string[] | undefined,
  accessibleProjectIds: readonly string[] | undefined,
  authorizeHubWide: boolean | undefined,
): readonly string[] | undefined {
  if (authorizeHubWide === true) {
    if (projectIds !== undefined || accessibleProjectIds !== undefined) {
      throw new ProviderOperationError(
        "dc-project-scope-conflict",
        "A hub-wide Data Connector request cannot include a project target set.",
      );
    }
    return undefined;
  }
  if (projectIds === undefined) {
    throw new ProviderOperationError(
      "dc-project-scope-required",
      "A Data Connector request must explicitly authorize hub-wide scope or provide project targets.",
    );
  }
  if (projectIds.length === 0) {
    throw new ProviderOperationError(
      "dc-project-target-empty",
      "A targeted Data Connector request requires at least one project ID.",
    );
  }
  if (projectIds.length > 50) {
    throw new ProviderOperationError(
      "dc-project-limit",
      "Data Connector accepts at most 50 project IDs per request.",
    );
  }
  if (projectIds.some((projectId) => !GUID_PATTERN.test(projectId))) {
    throw new ProviderOperationError("dc-project-id-invalid", "A Data Connector project ID is invalid.");
  }
  if (!accessibleProjectIds?.length) {
    throw new ProviderOperationError(
      "dc-project-authorization-missing",
      "Targeted Data Connector requests require an authorized project set.",
    );
  }
  const accessible = new Set(accessibleProjectIds);
  if (projectIds.some((projectId) => !accessible.has(projectId))) {
    throw new ProviderOperationError(
      "dc-project-forbidden",
      "A Data Connector project is outside the authorized project set.",
    );
  }
  return [...new Set(projectIds)];
}

function validateDateWindow(startDate: string, endDate: string, maximumDays?: number): void {
  if (
    !STRICT_UTC_TIMESTAMP_PATTERN.test(startDate) ||
    !STRICT_UTC_TIMESTAMP_PATTERN.test(endDate)
  ) {
    throw new ProviderOperationError(
      "dc-date-window-invalid",
      "Data Connector timestamps must use canonical UTC ISO 8601 format.",
    );
  }
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (
    !Number.isFinite(start) || !Number.isFinite(end) || start > end ||
    new Date(start).toISOString() !== startDate || new Date(end).toISOString() !== endDate
  ) {
    throw new ProviderOperationError("dc-date-window-invalid", "The Data Connector date window is invalid.");
  }
  if (maximumDays !== undefined && end - start > maximumDays * 24 * 60 * 60 * 1_000) {
    throw new ProviderOperationError(
      "dc-date-window-too-large",
      `The Data Connector date window cannot exceed ${maximumDays} days.`,
    );
  }
}

function assertAllowlisted<T extends string>(
  values: readonly T[],
  allowlist: readonly string[],
  label: string,
): void {
  if (values.length === 0 || values.some((value) => !allowlist.includes(value))) {
    throw new ProviderOperationError("dc-service-group-rejected", `${label} contains an unsupported service group.`);
  }
}

function baseBody(
  description: string,
  serviceGroups: readonly string[],
  projectIds: readonly string[] | undefined,
  effectiveFrom: string,
): JsonObject {
  return {
    description,
    isActive: true,
    scheduleInterval: "ONE_TIME",
    effectiveFrom,
    sendEmail: false,
    serviceGroups,
    ...(projectIds ? { projectIdList: projectIds } : {}),
  };
}

export function classifyDataConnectorJobState(
  status: string | null,
  completionStatus: string | null,
  policy: DataConnectorStatePolicy,
): DataConnectorJobState {
  if (status && policy.queuedStatuses.includes(status)) return "queued";
  if (status && policy.runningStatuses.includes(status)) return "running";
  if (!status || !policy.terminalStatuses.includes(status) || !completionStatus) return "unknown";
  if (policy.successfulCompletionStatuses.includes(completionStatus)) return "succeeded";
  if (policy.failedCompletionStatuses.includes(completionStatus)) return "failed";
  return "unknown";
}

export class AutodeskDataConnectorProvider implements DataConnectorProvider {
  readonly mode = "autodesk" as const;
  readonly #transport: ApsReadTransport;
  readonly #downloadFetch: FetchLike;
  readonly #accountId: string;
  readonly #basePath: string;
  readonly #statePolicy: DataConnectorStatePolicy;
  readonly #now: () => number;
  readonly #budgetGate?: DataConnectorBudgetGate;
  readonly #maxDownloadBytes: number;
  readonly #downloadTimeoutMs: number;
  readonly #allowedDownloadHosts: ReadonlySet<string>;

  constructor(
    config: Pick<AutodeskProviderConfig, "accountId" | "dataConnectorDownloadHosts">,
    transport: ApsReadTransport,
    options: DataConnectorOptions = {},
  ) {
    this.#transport = transport;
    this.#downloadFetch = options.downloadFetch ?? fetch;
    this.#accountId = config.accountId;
    this.#basePath = `/data-connector/v1/accounts/${encodeURIComponent(config.accountId)}`;
    this.#statePolicy = options.statePolicy ?? FAIL_SAFE_JOB_STATE_POLICY;
    this.#now = options.now ?? Date.now;
    this.#budgetGate = options.budgetGate;
    this.#maxDownloadBytes = Math.max(
      1,
      Math.min(options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES, DEFAULT_MAX_DOWNLOAD_BYTES),
    );
    this.#downloadTimeoutMs = Math.max(
      1_000,
      Math.min(options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_DOWNLOAD_TIMEOUT_MS),
    );
    this.#allowedDownloadHosts = validatedDownloadHosts(
      options.allowedDownloadHosts ?? config.dataConnectorDownloadHosts ?? [],
    );
  }

  async submitFullSnapshot(request: FullSnapshotRequest): Promise<DataConnectorRequestReceipt> {
    assertAllowlisted(request.serviceGroups, FULL_SNAPSHOT_SERVICE_GROUPS, "Full snapshot request");
    const projectIds = validatedProjectIds(request.projectIds, request.accessibleProjectIds, request.authorizeHubWide);
    assertDataConnectorBudget(request.budget, request.purpose);
    return this.#submitWithReservation(
      baseBody(
        request.description,
        request.serviceGroups,
        projectIds,
        new Date(this.#now()).toISOString(),
      ),
      request.purpose,
      request.budget.consumed,
    );
  }

  async submitActivities(request: ActivitiesExtractRequest): Promise<DataConnectorRequestReceipt> {
    validateDateWindow(request.startDate, request.endDate, 31);
    const projectIds = validatedProjectIds(request.projectIds, request.accessibleProjectIds, request.authorizeHubWide);
    assertDataConnectorBudget(request.budget, request.purpose);
    return this.#submitWithReservation({
      ...baseBody(
        request.description,
        ["activities"],
        projectIds,
        new Date(this.#now()).toISOString(),
      ),
      dateRange: "CUSTOM",
      startDate: request.startDate,
      endDate: request.endDate,
    }, request.purpose, request.budget.consumed);
  }

  async submitCdc(request: CdcExtractRequest): Promise<DataConnectorRequestReceipt> {
    assertAllowlisted(request.serviceGroups, CDC_SERVICE_GROUPS, "CDC request");
    validateDateWindow(request.startDate, request.endDate);
    const projectIds = validatedProjectIds(request.projectIds, request.accessibleProjectIds, request.authorizeHubWide);
    assertDataConnectorBudget(request.budget, request.purpose);
    // projectStatus is intentionally absent: Autodesk does not accept it for CDC calls.
    return this.#submitWithReservation({
      ...baseBody(
        request.description,
        request.serviceGroups,
        projectIds,
        new Date(this.#now()).toISOString(),
      ),
      dateRange: "CUSTOM",
      startDate: request.startDate,
      endDate: request.endDate,
    }, request.purpose, request.budget.consumed);
  }

  async findLatestJobForRequest(
    requestId: string,
  ): Promise<CoverageResult<DataConnectorJob>> {
    try {
      const payload = await this.#transport.get({
        service: "data-connector",
        path: `${this.#basePath}/requests/${encodeURIComponent(requestId)}/jobs`,
        query: { sort: "desc", limit: 1 },
      });
      const jobPayload = jobRows(payload)[0];
      if (!jobPayload) {
        return empty(
          "The accepted request has not produced a Data Connector job yet.",
          new Date(this.#now()).toISOString(),
        );
      }
      const job = this.#jobFromPayload(jobPayload);
      if (job) await this.#settleTerminalReservation(job);
      return job
        ? available(job, new Date(this.#now()).toISOString())
        : this.#unreachable("Autodesk returned a Data Connector job without an ID.", false);
    } catch (error) {
      return this.#coverageError(error, "The latest Data Connector job could not be discovered.");
    }
  }

  async getJob(jobId: string): Promise<CoverageResult<DataConnectorJob>> {
    try {
      const payload = await this.#transport.get({
        service: "data-connector",
        path: `${this.#basePath}/jobs/${encodeURIComponent(jobId)}`,
      });
      if (!isObject(payload)) {
        return this.#unreachable("Autodesk returned an unreadable Data Connector job.", false);
      }
      const job = this.#jobFromPayload(payload);
      if (job) await this.#settleTerminalReservation(job);
      return job
        ? available(job, new Date(this.#now()).toISOString())
        : this.#unreachable("Autodesk returned a Data Connector job without an ID.", false);
    } catch (error) {
      return this.#coverageError(error, "Data Connector job status could not be read.");
    }
  }

  async listFiles(jobId: string): Promise<CoverageResult<readonly ExtractFileDescriptor[]>> {
    try {
      const payload = await this.#transport.get({
        service: "data-connector",
        path: `${this.#basePath}/jobs/${encodeURIComponent(jobId)}/data-listing`,
      });
      const files = fileRows(payload)
        .map((entry): ExtractFileDescriptor => {
          const nameKey = entry.name !== undefined ? "name" : "fileName";
          const name = requiredNonBlankStringField(
            entry,
            nameKey,
            "dc-file-listing-malformed",
            "Autodesk returned a Data Connector file entry without a name.",
          );
          const sizeBytes = numberField(entry, "size");
          if (entry.size !== undefined && sizeBytes === null) {
            throw new ProviderOperationError(
              "dc-file-listing-malformed",
              "Autodesk returned a Data Connector file entry with an invalid size.",
            );
          }
          if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
            throw new ProviderOperationError(
              "dc-file-listing-malformed",
              "Autodesk returned a Data Connector file entry with an invalid size.",
            );
          }
          const createdAt = optionalTimestampField(
            entry,
            "createdAt",
            "dc-file-listing-malformed",
            "Autodesk returned a Data Connector file entry with an invalid creation timestamp.",
          );
          return {
            name,
            sizeBytes,
            createdAt,
          };
        });
      return files.length > 0
        ? available(files, new Date(this.#now()).toISOString())
        : empty("The completed Data Connector job listed no extract files.", new Date(this.#now()).toISOString());
    } catch (error) {
      return this.#coverageError(error, "Data Connector extract files could not be listed.");
    }
  }

  async downloadFile(jobId: string, fileName: string): Promise<Uint8Array> {
    const listing = await this.listFiles(jobId);
    if (listing.state === "restricted") {
      throw new ProviderOperationError(
        "dc-listing-restricted",
        "The Data Connector file listing is not accessible to this identity.",
      );
    }
    if (listing.state === "unreachable") {
      throw new ProviderOperationError(
        "dc-listing-unreachable",
        "The Data Connector file listing could not be reached.",
        listing.retryable,
      );
    }
    const descriptor = listing.state === "available"
      ? listing.data.find((file) => file.name === fileName)
      : undefined;
    if (!descriptor) {
      throw new ProviderOperationError(
        "dc-file-not-listed",
        "The requested file is not present in the Data Connector job listing.",
      );
    }
    if (descriptor.sizeBytes === null) {
      throw new ProviderOperationError(
        "dc-file-size-missing",
        "The Data Connector file listing did not provide the expected download size.",
      );
    }
    if (!Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes < 0) {
      throw new ProviderOperationError(
        "dc-file-size-invalid",
        "The Data Connector file listing reported an invalid size.",
      );
    }
    if (descriptor.sizeBytes > this.#maxDownloadBytes) {
      throw new ProviderOperationError(
        "dc-file-too-large",
        "The Data Connector file exceeds the configured download limit.",
      );
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const payload = await this.#transport.get({
        service: "data-connector",
        path: `${this.#basePath}/jobs/${encodeURIComponent(jobId)}/data/${encodeURIComponent(fileName)}`,
      });
      if (!isObject(payload)) {
        throw new ProviderOperationError("dc-signed-url-missing", "Autodesk did not return a download credential.");
      }
      const signedUrl = requiredNonBlankStringField(
        payload,
        "signedUrl",
        "dc-signed-url-missing",
        "Autodesk did not return a download credential.",
      );
      const receiptName = requiredNonBlankStringField(
        payload,
        "name",
        "dc-download-metadata-invalid",
        "Autodesk returned invalid Data Connector download metadata.",
      );
      const receiptSize = requiredSafeByteSizeField(
        payload,
        "size",
        "dc-download-metadata-invalid",
        "Autodesk returned invalid Data Connector download metadata.",
      );
      if (receiptName !== descriptor.name || receiptSize !== descriptor.sizeBytes) {
        throw new ProviderOperationError(
          "dc-download-metadata-mismatch",
          "The Data Connector download metadata did not match the selected file listing.",
        );
      }
      const parsed = this.#validatedDownloadUrl(signedUrl);

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), this.#downloadTimeoutMs);
      let response: Response;
      try {
        response = await this.#fetchDownload(parsed, abortController.signal);
        if (response.ok) {
          return await readBoundedResponse(
            response,
            this.#maxDownloadBytes,
            descriptor.sizeBytes,
          );
        }
      } catch (error) {
        if (error instanceof ProviderOperationError) throw error;
        throw new ProviderOperationError(
          "dc-download-unreachable",
          "The Data Connector file download could not be completed within its safety bounds.",
          true,
        );
      } finally {
        clearTimeout(timeout);
      }
      if (attempt === 1 || ![401, 403, 404].includes(response.status)) {
        throw new ProviderOperationError(
          "dc-download-failed",
          `Data Connector file download failed with HTTP ${response.status}.`,
          response.status >= 500,
        );
      }
      // Do not reuse a possibly expired bearer URL. The next iteration asks APS for a fresh one.
    }
    throw new ProviderOperationError("dc-download-failed", "Data Connector file download failed.");
  }

  #validatedDownloadUrl(value: string, base?: URL): URL {
    let parsed: URL;
    try {
      parsed = base ? new URL(value, base) : new URL(value);
    } catch {
      throw new ProviderOperationError(
        "dc-signed-url-invalid",
        "Autodesk returned an invalid download credential.",
      );
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.hash !== "" ||
      !this.#allowedDownloadHosts.has(hostname)
    ) {
      throw new ProviderOperationError(
        "dc-download-host-rejected",
        "The Data Connector download host was not operator-approved.",
      );
    }
    return parsed;
  }

  async #fetchDownload(initialUrl: URL, signal: AbortSignal): Promise<Response> {
    let currentUrl = initialUrl;
    for (let redirects = 0; redirects <= MAX_DOWNLOAD_REDIRECTS; redirects += 1) {
      const response = await this.#downloadFetch(currentUrl, {
        method: "GET",
        cache: "no-store",
        redirect: "manual",
        signal,
      });
      if (response.url) this.#validatedDownloadUrl(response.url);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location || redirects === MAX_DOWNLOAD_REDIRECTS) {
        throw new ProviderOperationError(
          "dc-download-redirect-rejected",
          "The Data Connector download redirect chain was rejected.",
        );
      }
      currentUrl = this.#validatedDownloadUrl(location, currentUrl);
    }
    throw new ProviderOperationError(
      "dc-download-redirect-rejected",
      "The Data Connector download redirect chain was rejected.",
    );
  }

  async #submitWithReservation(
    body: JsonObject,
    purpose: "scheduled" | "retry" = "scheduled",
    observedConsumed = 0,
  ): Promise<DataConnectorRequestReceipt> {
    if (!this.#budgetGate) {
      throw new DataConnectorBudgetError(
        "A durable Data Connector budget ledger is required before submission.",
      );
    }
    const reservation = await this.#budgetGate.reserve(purpose, observedConsumed);
    let receipt: DataConnectorRequestReceipt;
    try {
      receipt = await this.#submit(body);
    } catch (error) {
      await this.#budgetGate.markAmbiguous(reservation.id).catch(() => undefined);
      throw error;
    }

    try {
      await this.#budgetGate.markAccepted(reservation.id, receipt.requestId);
    } catch {
      // The durable reservation already counts against the rolling window. Do
      // not hide a confirmed Autodesk receipt or encourage a dangerous retry.
      await this.#budgetGate.markAmbiguous(reservation.id).catch(() => undefined);
    }
    return receipt;
  }

  async #submit(body: JsonObject): Promise<DataConnectorRequestReceipt> {
    const payload = await this.#transport.submitDataConnectorRequest(this.#accountId, body);
    if (!isObject(payload)) {
      throw new ProviderOperationError("dc-submission-malformed", "Autodesk returned an unreadable submission receipt.");
    }
    const requestId = requiredNonBlankStringField(
      payload,
      "id",
      "dc-submission-malformed",
      "Autodesk returned a receipt without a request ID.",
    );
    return {
      requestId,
      submittedAt: optionalTimestampField(
        payload,
        "createdAt",
        "dc-submission-malformed",
        "Autodesk returned a receipt with an invalid creation timestamp.",
      ) ?? new Date(this.#now()).toISOString(),
    };
  }

  #jobFromPayload(payload: JsonObject): DataConnectorJob {
    const id = requiredNonBlankStringField(
      payload,
      "id",
      "dc-job-malformed",
      "Autodesk returned a Data Connector job without an ID.",
    );
    const status = optionalNonBlankStringField(
      payload,
      "status",
      "dc-job-malformed",
      "Autodesk returned a Data Connector job with an invalid status.",
    );
    const completionStatus = optionalNonBlankStringField(
      payload,
      "completionStatus",
      "dc-job-malformed",
      "Autodesk returned a Data Connector job with an invalid completion status.",
    );
    return {
      id,
      requestId: optionalNonBlankStringField(
        payload,
        "requestId",
        "dc-job-malformed",
        "Autodesk returned a Data Connector job with an invalid request ID.",
      ),
      state: classifyDataConnectorJobState(status, completionStatus, this.#statePolicy),
      createdAt: optionalTimestampField(payload, "createdAt", "dc-job-malformed", "Autodesk returned a Data Connector job with an invalid creation timestamp."),
      startedAt: optionalTimestampField(payload, "startedAt", "dc-job-malformed", "Autodesk returned a Data Connector job with an invalid start timestamp."),
      completedAt: optionalTimestampField(payload, "completedAt", "dc-job-malformed", "Autodesk returned a Data Connector job with an invalid completion timestamp."),
      sourceStatus: status,
      sourceCompletionStatus: completionStatus,
    };
  }

  async #settleTerminalReservation(job: DataConnectorJob): Promise<void> {
    if (
      !this.#budgetGate ||
      !job.requestId ||
      (job.state !== "succeeded" && job.state !== "failed")
    ) return;
    // A ledger outage should keep the account conservatively blocked, but it
    // must not hide a valid job-status response from the caller.
    await this.#budgetGate.markTerminal(job.requestId).catch(() => undefined);
  }

  #coverageError<T>(error: unknown, reason: string): CoverageResult<T> {
    const observedAt = new Date(this.#now()).toISOString();
    if (error instanceof ApsTransportError && (error.status === 401 || error.status === 403)) {
      return { state: "restricted", observedAt, reason, warnings: [] };
    }
    if (error instanceof ApsTransportError && error.status === 404) {
      return empty(reason, observedAt);
    }
    if (error instanceof ProviderOperationError) {
      return this.#unreachable(error.message, error.retryable);
    }
    return this.#unreachable(
      reason,
      false,
    );
  }

  #unreachable<T>(reason: string, retryable: boolean): CoverageResult<T> {
    return {
      state: "unreachable",
      observedAt: new Date(this.#now()).toISOString(),
      reason,
      retryable,
      warnings: [],
    };
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  expectedBytes: number,
): Promise<Uint8Array> {
  const contentLengthValue = response.headers.get("content-length");
  let contentLength: number | null = null;
  if (contentLengthValue !== null) {
    contentLength = Number(contentLengthValue);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new ProviderOperationError(
        "dc-content-length-invalid",
        "The Data Connector download reported an invalid content length.",
      );
    }
    if (contentLength > maximumBytes) {
      throw new ProviderOperationError(
        "dc-file-too-large",
        "The Data Connector download exceeds the configured download limit.",
      );
    }
    if (contentLength !== expectedBytes) {
      throw new ProviderOperationError(
        "dc-download-size-mismatch",
        "The Data Connector download length did not match its signed metadata.",
      );
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ProviderOperationError(
            "dc-file-too-large",
            "The Data Connector download exceeded the configured download limit.",
          );
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  if (total !== expectedBytes || (contentLength !== null && total !== contentLength)) {
    throw new ProviderOperationError(
      "dc-download-size-mismatch",
      "The Data Connector download length did not match its signed metadata.",
    );
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
