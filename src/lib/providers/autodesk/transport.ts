import type { ApsAccessContext, HubRegion } from "../contracts";
import { ProviderOperationError } from "../errors";
import {
  BoundedResponseError,
  readBoundedResponseText,
} from "@/lib/http/bounded-response";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ApsService =
  | "data-management"
  | "data-connector"
  | "hub-admin"
  | "issues"
  | "rfis"
  | "forms"
  | "reviews"
  | "submittals"
  | "cost"
  | "model-coordination"
  | "relationships";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type QueryValue = string | number | boolean | undefined;

export interface ApsTransportOptions {
  readonly accessContext: () => Promise<ApsAccessContext>;
  /** Called once after a 401 so the next attempt can read a rotated token. */
  readonly refreshAccessContext?: () => Promise<void>;
  readonly region?: HubRegion;
  readonly fetch?: FetchLike;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly maxAttempts?: number;
  readonly maxDelayMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly baseUrl?: string;
}

export interface ReadRequest {
  readonly service: ApsService;
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
}

type ReplayPolicy = "safe" | "never";

export const APS_JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

export class ApsTransportError extends ProviderOperationError {
  readonly status: number;
  readonly requestId: string | null;

  constructor(status: number, requestId: string | null) {
    super(
      "aps-read-failed",
      `Autodesk service request failed with HTTP ${status}.`,
      status === 429 || status >= 500,
    );
    this.name = "ApsTransportError";
    this.status = status;
    this.requestId = requestId;
  }
}

export function regionHeaderFor(
  service: ApsService,
  region: HubRegion | undefined,
): Readonly<Record<string, string>> {
  if (!region) return {};
  switch (service) {
    case "hub-admin":
      return { Region: region };
    case "issues":
    case "model-coordination":
    case "relationships":
      return { "x-ads-region": region };
    case "cost":
      return { region };
    default:
      return {};
  }
}

const GLOBAL_RATE_WINDOW_MS = 60_000;
const GLOBAL_RATE_LIMITS = new Map<ApsService, number>([
  ["rfis", 100],
  ["forms", 100],
  ["data-connector", 60],
]);

export class SerializedSlidingWindowLimiter {
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, number[]>();
  readonly #locks = new Map<string, Promise<void>>();

  constructor(windowMs = GLOBAL_RATE_WINDOW_MS, now: () => number = Date.now) {
    this.#windowMs = windowMs;
    this.#now = now;
  }

  async acquire(
    key: string,
    limit: number,
    sleep: (milliseconds: number) => Promise<void>,
  ): Promise<void> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.#locks.set(key, queued);

    await previous.catch(() => undefined);
    try {
      const window = this.#windows.get(key) ?? [];
      while (true) {
        const now = this.#now();
        while (window.length && window[0]! <= now - this.#windowMs) window.shift();
        if (window.length < limit) {
          window.push(now);
          this.#windows.set(key, window);
          return;
        }
        const waitMs = Math.max(1, window[0]! + this.#windowMs - now);
        await sleep(waitMs);
      }
    } finally {
      release?.();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}

const globalRateLimiter = new SerializedSlidingWindowLimiter();

export function rateLimitPerMinute(service: ApsService): number | null {
  return GLOBAL_RATE_LIMITS.get(service) ?? null;
}

function validateRelativePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new ProviderOperationError("aps-path-rejected", "APS requests require an allowlisted relative path.");
  }
}

function retryDelay(
  response: Response,
  attempt: number,
  now: number,
  random: () => number,
  maxDelayMs: number,
): number {
  const retryAfter = response.headers.get("Retry-After")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, maxDelayMs);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), maxDelayMs);
  }
  const exponential = Math.min(500 * 2 ** attempt, maxDelayMs);
  return Math.min(Math.round(exponential * (0.75 + random() * 0.5)), maxDelayMs);
}

/**
 * Read-only APS transport. POST is available only through specifically named,
 * documented read-shaped methods and Data Connector scheduled submission.
 */
export class ApsReadTransport {
  readonly #accessContext: () => Promise<ApsAccessContext>;
  readonly #refreshAccessContext?: () => Promise<void>;
  readonly #region?: HubRegion;
  readonly #fetch: FetchLike;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #maxAttempts: number;
  readonly #maxDelayMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #baseUrl: URL;

  constructor(options: ApsTransportOptions) {
    this.#accessContext = options.accessContext;
    this.#refreshAccessContext = options.refreshAccessContext;
    this.#region = options.region;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = options.random ?? Math.random;
    this.#maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 5));
    this.#maxDelayMs = Math.max(0, Math.min(options.maxDelayMs ?? 15_000, 30_000));
    this.#requestTimeoutMs = Math.max(1, Math.min(options.requestTimeoutMs ?? 30_000, 120_000));
    this.#maxResponseBytes = Math.max(
      1,
      Math.min(options.maxResponseBytes ?? APS_JSON_RESPONSE_MAX_BYTES, APS_JSON_RESPONSE_MAX_BYTES),
    );
    this.#baseUrl = new URL(options.baseUrl ?? "https://developer.api.autodesk.com");
  }

  get(request: ReadRequest): Promise<JsonValue> {
    return this.#request("GET", request);
  }

  searchRfis(projectId: string, body: JsonObject): Promise<JsonValue> {
    return this.#request(
      "POST",
      {
        service: "rfis",
        path: `/construction/rfis/v3/projects/${encodeIdentifier(projectId)}/search:rfis`,
      },
      body,
    );
  }

  intersectRelationships(containerId: string, body: JsonObject): Promise<JsonValue> {
    return this.#relationshipRead(containerId, "intersect", body);
  }

  syncRelationships(containerId: string, body: JsonObject): Promise<JsonValue> {
    return this.#relationshipRead(containerId, "sync", body);
  }

  relationshipSyncStatus(containerId: string, body: JsonObject): Promise<JsonValue> {
    return this.#relationshipRead(containerId, "syncStatus", body);
  }

  submitDataConnectorRequest(
    accountId: string,
    body: JsonObject,
  ): Promise<JsonValue> {
    return this.#request(
      "POST",
      {
        service: "data-connector",
        path: `/data-connector/v1/accounts/${encodeIdentifier(accountId)}/requests`,
      },
      body,
      "never",
    );
  }

  #relationshipRead(
    containerId: string,
    operation: "intersect" | "sync" | "syncStatus",
    body: JsonObject,
  ): Promise<JsonValue> {
    return this.#request(
      "POST",
      {
        service: "relationships",
        path: `/bim360/relationship/v2/containers/${encodeIdentifier(containerId)}/relationships:${operation}`,
      },
      body,
    );
  }

  async #request(
    method: "GET" | "POST",
    request: ReadRequest,
    body?: JsonObject,
    replayPolicy: ReplayPolicy = "safe",
  ): Promise<JsonValue> {
    validateRelativePath(request.path);
    const url = new URL(request.path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      throw new ProviderOperationError("aps-origin-rejected", "APS request origin was rejected.");
    }
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: ApsTransportError | null = null;
    let retryAttempt = 0;
    let refreshedAfterUnauthorized = false;
    while (retryAttempt < this.#maxAttempts) {
      await this.#waitForGlobalBucket(request.service);
      const context = await this.#accessContext();
      let response: Response;
      let responseText: string | null = null;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${context.accessToken}`,
            ...regionHeaderFor(request.service, this.#region),
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
          // AbortSignal.timeout remains active while the response body is read,
          // not merely until headers arrive.
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
        });
        if (response.ok && response.status !== 204) {
          responseText = await readBoundedResponseText(response, this.#maxResponseBytes);
        }
      } catch (error) {
        if (replayPolicy === "never") {
          throw new ProviderOperationError(
            "aps-submission-outcome-unknown",
            "Autodesk did not confirm whether the Data Connector request was accepted.",
            false,
          );
        }
        if (
          error instanceof BoundedResponseError &&
          error.failure !== "body-unreadable"
        ) {
          throw new ProviderOperationError(
            "aps-response-too-large",
            "Autodesk returned a response outside the configured JSON body bounds.",
            false,
          );
        }
        retryAttempt += 1;
        if (retryAttempt >= this.#maxAttempts) {
          throw new ProviderOperationError(
            "aps-unreachable",
            "Autodesk service could not be reached.",
            true,
          );
        }
        await this.#sleep(Math.min(500 * 2 ** (retryAttempt - 1), this.#maxDelayMs));
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return null;
        if (!responseText) return null;
        try {
          return JSON.parse(responseText) as JsonValue;
        } catch {
          throw new ProviderOperationError(
            "aps-invalid-json",
            "Autodesk returned an unreadable response.",
            false,
          );
        }
      }

      lastError = new ApsTransportError(
        response.status,
        response.headers.get("x-ads-request-id") ?? response.headers.get("x-request-id"),
      );
      if (replayPolicy === "never") {
        throw new ProviderOperationError(
          "aps-submission-outcome-unknown",
          `Autodesk did not confirm whether the Data Connector request was accepted (HTTP ${response.status}).`,
          false,
        );
      }
      if (
        response.status === 401 &&
        this.#refreshAccessContext &&
        !refreshedAfterUnauthorized
      ) {
        refreshedAfterUnauthorized = true;
        await this.#refreshAccessContext();
        continue;
      }
      if (!lastError.retryable || retryAttempt === this.#maxAttempts - 1) break;
      await this.#sleep(retryDelay(response, retryAttempt, Date.now(), this.#random, this.#maxDelayMs));
      retryAttempt += 1;
    }
    throw lastError ?? new ProviderOperationError("aps-read-failed", "Autodesk service request failed.");
  }

  async #waitForGlobalBucket(service: ApsService): Promise<void> {
    const limit = GLOBAL_RATE_LIMITS.get(service);
    if (!limit) return;
    await globalRateLimiter.acquire(service, limit, this.#sleep);
  }
}

function encodeIdentifier(identifier: string): string {
  const value = identifier.trim();
  if (!value || value.length > 200) {
    throw new ProviderOperationError("aps-identifier-rejected", "APS request identifier was rejected.");
  }
  return encodeURIComponent(value);
}
