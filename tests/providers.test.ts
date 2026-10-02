import assert from "node:assert/strict";
import test from "node:test";
import { getDemoDataset } from "../src/lib/demo/generator";
import {
  DATA_CONNECTOR_RETRY_RESERVE,
  DataConnectorBudgetError,
  ProviderOperationError,
  createProviderSet,
  resolveDataMode,
} from "../src/lib/providers";
import { isAutodeskMode, loadApsAuthConfig } from "../src/lib/auth";
import { AutodeskApsAuthProvider } from "../src/lib/providers/autodesk/auth";
import { readAutodeskProviderConfig } from "../src/lib/providers/autodesk/config";
import {
  AutodeskDataConnectorProvider,
  FAIL_SAFE_JOB_STATE_POLICY,
  classifyDataConnectorJobState,
} from "../src/lib/providers/autodesk/data-connector";
import { AutodeskScheduleProvider } from "../src/lib/providers/autodesk/records";
import {
  ApsReadTransport,
  ApsTransportError,
  SerializedSlidingWindowLimiter,
  rateLimitPerMinute,
  regionHeaderFor,
  type FetchLike,
} from "../src/lib/providers/autodesk/transport";
import type { CoverageResult, DataConnectorBudgetGate, FullSnapshotRequest } from "../src/lib/providers/contracts";
import type { RiskRecord } from "../src/lib/canonical/types";

const CONFIG_ENV = {
  DATA_MODE: "autodesk",
  APS_CLIENT_ID: "client-id",
  APS_CLIENT_SECRET: "client-secret",
  APS_CALLBACK_URL: "http://localhost:8080/api/aps/callback",
  ACC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000000",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  APS_SCOPES: "verified:one verified:two",
  APS_DATA_CONNECTOR_DOWNLOAD_HOSTS: "storage.example storage-two.example",
  ACC_REGION: "US",
} as const;

function jsonResponse(value: object | readonly object[], status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function stalledBodyResponse(signal: AbortSignal | null | undefined): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => controller.error(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
  }), { status: 200 });
}

function permissiveBudgetGate(events: string[] = []): DataConnectorBudgetGate {
  let sequence = 0;
  return {
    async reserve(purpose, observedConsumed) {
      sequence += 1;
      events.push(`reserve:${purpose}:${observedConsumed}`);
      return { id: `reservation-${sequence}` };
    },
    async markAccepted(reservationId, requestId) {
      events.push(`accepted:${reservationId}:${requestId}`);
    },
    async markAmbiguous(reservationId) {
      events.push(`ambiguous:${reservationId}`);
    },
    async markTerminal(requestId) {
      events.push(`terminal:${requestId}`);
    },
  };
}

test("demo composition never reads or requires APS configuration", async () => {
  const providers = createProviderSet({ environment: { DATA_MODE: "demo" } });
  assert.equal(providers.mode, "demo");
  const projectId = getDemoDataset().projects[0]?.project.id;
  assert.ok(projectId);
  const result = await providers.issues.listIssues(projectId);
  assert.equal(result.state, "available");
  if (result.state === "available") {
    assert.ok(result.data.length > 0);
    assert.ok(
      result.data.every((record) =>
        String(record.raw?.source_shape ?? "").toLowerCase().includes("synthetic"),
      ),
    );
  }
});

test("provider and authentication boundaries share DATA_MODE and APS scope grammar", () => {
  for (const value of ["autodesk", " AUTODESK ", "AuToDeSk"]) {
    assert.equal(resolveDataMode({ DATA_MODE: value }), "autodesk");
    assert.equal(isAutodeskMode({ DATA_MODE: value }), true);
  }
  for (const value of ["demo", " DEMO ", "DeMo"]) {
    assert.equal(resolveDataMode({ DATA_MODE: value }), "demo");
    assert.equal(isAutodeskMode({ DATA_MODE: value }), false);
  }
  assert.throws(() => resolveDataMode({ DATA_MODE: "live" }), /DATA_MODE/u);
  assert.equal(isAutodeskMode({ DATA_MODE: "live" }), false);

  for (const scopes of ["verified:one verified:two", "verified:one,verified:two", " verified:one, verified:two "]) {
    const environment = { ...CONFIG_ENV, APS_SCOPES: scopes };
    assert.deepEqual(readAutodeskProviderConfig(environment).scopes, ["verified:one", "verified:two"]);
    assert.deepEqual(loadApsAuthConfig(environment).scopes, ["verified:one", "verified:two"]);
  }
  for (const scopes of ["verified:one verified:one", "verified:one,verified:one"]) {
    assert.throws(() => readAutodeskProviderConfig({ ...CONFIG_ENV, APS_SCOPES: scopes }));
    assert.throws(() => loadApsAuthConfig({ ...CONFIG_ENV, APS_SCOPES: scopes }));
  }
});

test("Autodesk config requires an explicit verified scope list", () => {
  assert.throws(
    () => readAutodeskProviderConfig({ ...CONFIG_ENV, APS_SCOPES: undefined }),
    /APS_SCOPES is required/u,
  );
  const config = readAutodeskProviderConfig(CONFIG_ENV);
  assert.deepEqual(config.scopes, ["verified:one", "verified:two"]);
  assert.deepEqual(config.dataConnectorDownloadHosts, ["storage.example", "storage-two.example"]);
  for (const rejected of ["*.amazonaws.com", "127.0.0.1", "storage.example/path"]) {
    assert.throws(
      () => readAutodeskProviderConfig({
        ...CONFIG_ENV,
        APS_DATA_CONNECTOR_DOWNLOAD_HOSTS: rejected,
      }),
      /exact DNS hostnames/u,
    );
  }
  for (const callbackUrl of [
    "https://user:password@risk.example.test/api/aps/callback",
    "https://risk.example.test/api/aps/callback#fragment",
  ]) {
    assert.throws(
      () => readAutodeskProviderConfig({ ...CONFIG_ENV, APS_CALLBACK_URL: callbackUrl }),
      /APS_CALLBACK_URL/u,
    );
  }
});

test("OAuth authorization uses PKCE S256 and only configured scopes", async () => {
  const provider = new AutodeskApsAuthProvider(readAutodeskProviderConfig(CONFIG_ENV), {
    now: () => Date.parse("2026-09-08T12:00:00.000Z"),
  });
  const attempt = await provider.beginAuthorization("//untrusted.example/return");
  const url = new URL(attempt.authorizationUrl);
  assert.equal(url.searchParams.get("scope"), "verified:one verified:two");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(attempt.returnTo, "/");
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.equal((await provider.beginAuthorization("/\\evil.example")).returnTo, "/");
  assert.equal((await provider.beginAuthorization("/safe/path?range=28")).returnTo, "/safe/path?range=28");
});

test("OAuth token exchange is bounded by an AbortSignal", async () => {
  const signals: AbortSignal[] = [];
  const provider = new AutodeskApsAuthProvider(readAutodeskProviderConfig(CONFIG_ENV), {
    fetch: async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return jsonResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3_600,
        scope: "verified:two verified:one",
      });
    },
    requestTimeoutMs: 25,
  });
  await provider.exchangeAuthorizationCode({
    code: "authorization-code",
    state: "expected-state",
    expectedState: "expected-state",
    codeVerifier: "pkce-verifier",
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, false);
});

test("OAuth timeout remains active while a successful response body is read", async () => {
  const provider = new AutodeskApsAuthProvider(readAutodeskProviderConfig(CONFIG_ENV), {
    fetch: async (_input, init) => stalledBodyResponse(init?.signal),
    requestTimeoutMs: 20,
  });
  await assert.rejects(
    provider.exchangeAuthorizationCode({
      code: "authorization-code",
      state: "expected-state",
      expectedState: "expected-state",
      codeVerifier: "pkce-verifier",
    }),
    (error: unknown) => error instanceof ProviderOperationError &&
      error.code === "oauth-token-unreachable" && error.retryable,
  );
});

test("provider OAuth rejects oversized successful JSON before parsing", async () => {
  let calls = 0;
  const provider = new AutodeskApsAuthProvider(readAutodeskProviderConfig(CONFIG_ENV), {
    fetch: async () => {
      calls += 1;
      return new Response("{}", {
        status: 200,
        headers: { "content-length": "9", "content-type": "application/json" },
      });
    },
    maxResponseBytes: 8,
  });
  await assert.rejects(provider.exchangeAuthorizationCode({
    code: "authorization-code",
    state: "expected-state",
    expectedState: "expected-state",
    codeVerifier: "pkce-verifier",
  }), (error: unknown) => error instanceof ProviderOperationError &&
    error.code === "oauth-token-malformed" && !error.retryable);
  assert.equal(calls, 1);
});

test("region headers are service-specific and absent where undocumented", () => {
  assert.deepEqual(regionHeaderFor("hub-admin", "US"), { Region: "US" });
  assert.deepEqual(regionHeaderFor("issues", "EMEA"), { "x-ads-region": "EMEA" });
  assert.deepEqual(regionHeaderFor("relationships", "US"), { "x-ads-region": "US" });
  assert.deepEqual(regionHeaderFor("cost", "EMEA"), { region: "EMEA" });
  assert.deepEqual(regionHeaderFor("forms", "US"), {});
  assert.deepEqual(regionHeaderFor("rfis", "US"), {});
  assert.deepEqual(regionHeaderFor("submittals", "US"), {});
});

test("transport budgets Data Connector across its 60 rpm client bucket", () => {
  assert.equal(rateLimitPerMinute("data-connector"), 60);
  assert.equal(rateLimitPerMinute("rfis"), 100);
  assert.equal(rateLimitPerMinute("forms"), 100);
});

test("sliding-window limiter serializes queued callers before reserving capacity", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const acquisitions: number[] = [];
  const limiter = new SerializedSlidingWindowLimiter(100, () => clock);
  await Promise.all(Array.from({ length: 5 }, async () => {
    await limiter.acquire("forms", 2, async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    });
    acquisitions.push(clock);
  }));
  assert.deepEqual(acquisitions, [0, 0, 100, 100, 200]);
  assert.deepEqual(sleeps, [100, 100]);
});

test("read transport exposes named POST-shaped reads, bounds Retry-After, and has no generic mutation", async () => {
  const waits: number[] = [];
  const headersSeen: Headers[] = [];
  let calls = 0;
  const fetchStub: FetchLike = async (_input, init) => {
    calls += 1;
    headersSeen.push(new Headers(init?.headers));
    return calls === 1
      ? jsonResponse({ developerMessage: "secret-body-must-not-escape" }, 429, { "Retry-After": "90" })
      : jsonResponse({ results: [] });
  };
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "super-secret-bearer", userId: "user-1" }),
    region: "US",
    fetch: fetchStub,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
    maxDelayMs: 1_000,
  });
  await transport.get({ service: "issues", path: "/construction/issues/v1/projects/p/issues" });
  assert.deepEqual(waits, [1_000]);
  assert.equal(calls, 2);
  assert.equal(headersSeen[0]?.get("x-ads-region"), "US");
  assert.equal("post" in transport, false);
  assert.equal("patch" in transport, false);
  assert.equal("put" in transport, false);
  assert.equal("delete" in transport, false);
  assert.equal(typeof transport.searchRfis, "function");
  assert.equal(typeof transport.submitDataConnectorRequest, "function");
});

test("read timeout remains active while a successful response body is read", async () => {
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async (_input, init) => stalledBodyResponse(init?.signal),
    requestTimeoutMs: 20,
    maxAttempts: 1,
  });
  await assert.rejects(
    transport.get({ service: "issues", path: "/construction/issues/v1/projects/p/issues" }),
    (error: unknown) => error instanceof ProviderOperationError &&
      error.code === "aps-unreachable" && error.retryable,
  );
});

test("read transport stream-caps oversized successful JSON without retrying", async () => {
  let calls = 0;
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => {
      calls += 1;
      return new Response('{"value":1}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    maxResponseBytes: 8,
    maxAttempts: 5,
  });
  await assert.rejects(
    transport.get({ service: "issues", path: "/construction/issues/v1/projects/p/issues" }),
    (error: unknown) => error instanceof ProviderOperationError &&
      error.code === "aps-response-too-large" && !error.retryable,
  );
  assert.equal(calls, 1);
});

test("named POST-shaped reads bind identifiers to exact documented endpoint templates", async () => {
  const urls: string[] = [];
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async (input) => {
      urls.push(String(input));
      return jsonResponse({ results: [] });
    },
  });
  await transport.searchRfis("project/id", {});
  await transport.intersectRelationships("container/id", {});
  await transport.syncRelationships("container/id", {});
  await transport.relationshipSyncStatus("container/id", {});
  assert.deepEqual(
    urls.map((url) => new URL(url).pathname),
    [
      "/construction/rfis/v3/projects/project%2Fid/search:rfis",
      "/bim360/relationship/v2/containers/container%2Fid/relationships:intersect",
      "/bim360/relationship/v2/containers/container%2Fid/relationships:sync",
      "/bim360/relationship/v2/containers/container%2Fid/relationships:syncStatus",
    ],
  );
});

test("Data Connector submission is never replayed after an ambiguous failure", async () => {
  let networkAttempts = 0;
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => {
      networkAttempts += 1;
      throw new Error("response lost");
    },
    sleep: async () => assert.fail("non-idempotent submission must not enter backoff"),
    maxAttempts: 5,
  });
  await assert.rejects(
    transport.submitDataConnectorRequest(CONFIG_ENV.ACC_ACCOUNT_ID, {
      scheduleInterval: "ONE_TIME",
      effectiveFrom: "2026-09-08T12:00:00.000Z",
      serviceGroups: ["admin"],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /did not confirm/u);
      assert.equal("retryable" in error && error.retryable, false);
      return true;
    },
  );
  assert.equal(networkAttempts, 1);

  let serverAttempts = 0;
  const serverFailureTransport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => {
      serverAttempts += 1;
      return jsonResponse({}, 503);
    },
    sleep: async () => assert.fail("non-idempotent submission must not enter backoff"),
    maxAttempts: 5,
  });
  await assert.rejects(
    serverFailureTransport.submitDataConnectorRequest(CONFIG_ENV.ACC_ACCOUNT_ID, {
      scheduleInterval: "ONE_TIME",
      effectiveFrom: "2026-09-08T12:00:00.000Z",
      serviceGroups: ["admin"],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /did not confirm/u);
      assert.equal("retryable" in error && error.retryable, false);
      return true;
    },
  );
  assert.equal(serverAttempts, 1);
});

test("APS errors are sanitized and never echo response bodies or request URLs", async () => {
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () =>
      new Response("signedUrl=https://storage.example/file?signature=do-not-leak", { status: 400 }),
    maxAttempts: 1,
  });
  await assert.rejects(
    transport.get({ service: "data-connector", path: "/data-connector/v1/private" }),
    (error: unknown) => {
      assert.ok(error instanceof ApsTransportError);
      assert.equal(error.message.includes("signature"), false);
      assert.equal(error.message.includes("data-connector"), false);
      return true;
    },
  );
});

test("read transport refreshes once after a 401 and retries with the rotated token", async () => {
  let token = "expired-token";
  const authorizations: string[] = [];
  let refreshes = 0;
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: token, userId: null }),
    refreshAccessContext: async () => {
      refreshes += 1;
      token = "rotated-token";
    },
    fetch: async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return authorizations.length === 1
        ? jsonResponse({}, 401)
        : jsonResponse({ results: [] });
    },
    maxAttempts: 1,
  });

  await transport.get({ service: "issues", path: "/construction/issues/v1/projects/p/issues" });
  assert.equal(refreshes, 1);
  assert.deepEqual(authorizations, ["Bearer expired-token", "Bearer rotated-token"]);
});

test("Data Connector budget preserves eight scheduled slots and fails closed when unknown", async () => {
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => jsonResponse({ id: "request-1", createdAt: "2026-09-08T12:00:00.000Z" }),
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
  );

  await assert.rejects(
    provider.submitFullSnapshot({
      description: "daily",
      serviceGroups: ["admin"],
      authorizeHubWide: true,
      budget: { state: "known", consumed: 24 - DATA_CONNECTOR_RETRY_RESERVE },
    }),
    DataConnectorBudgetError,
  );
  await assert.rejects(
    provider.submitFullSnapshot({
      description: "daily",
      serviceGroups: ["admin"],
      authorizeHubWide: true,
      budget: { state: "unknown", reason: "ledger unavailable" },
    }),
    DataConnectorBudgetError,
  );
});

test("Autodesk submission requires a durable reservation before any network dispatch", async () => {
  let submissions = 0;
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => {
      submissions += 1;
      return jsonResponse({ id: "must-not-submit" });
    },
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
  );
  const attempts = await Promise.allSettled(
    Array.from({ length: 25 }, () => provider.submitFullSnapshot({
      description: "parallel",
      serviceGroups: ["admin"],
      authorizeHubWide: true,
      budget: { state: "known", consumed: 0 },
    })),
  );
  assert.ok(attempts.every((result) => result.status === "rejected"));
  assert.equal(submissions, 0);
});

test("Autodesk submission records accepted and ambiguous reservation outcomes", async () => {
  const acceptedEvents: string[] = [];
  const acceptedTransport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => jsonResponse({ id: "request-accepted" }),
  });
  const acceptedProvider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    acceptedTransport,
    { budgetGate: permissiveBudgetGate(acceptedEvents) },
  );
  await acceptedProvider.submitFullSnapshot({
    description: "accepted",
    serviceGroups: ["admin"],
    authorizeHubWide: true,
    budget: { state: "known", consumed: 3 },
  });
  assert.deepEqual(acceptedEvents, [
    "reserve:scheduled:3",
    "accepted:reservation-1:request-accepted",
  ]);

  const ambiguousEvents: string[] = [];
  const ambiguousTransport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => {
      throw new Error("response lost");
    },
  });
  const ambiguousProvider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    ambiguousTransport,
    { budgetGate: permissiveBudgetGate(ambiguousEvents) },
  );
  await assert.rejects(ambiguousProvider.submitFullSnapshot({
    description: "ambiguous",
    serviceGroups: ["admin"],
    authorizeHubWide: true,
    budget: { state: "known", consumed: 0 },
  }));
  assert.deepEqual(ambiguousEvents, [
    "reserve:scheduled:0",
    "ambiguous:reservation-1",
  ]);
});

test("CDC submission uses its allowlist and omits projectStatus", async () => {
  let submittedBody = "";
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async (_input, init) => {
      submittedBody = String(init?.body ?? "");
      return jsonResponse({ id: "request-cdc" });
    },
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
    {
      now: () => Date.parse("2026-09-08T12:34:56.000Z"),
      budgetGate: permissiveBudgetGate(),
    },
  );
  await provider.submitCdc({
    description: "overlap",
    serviceGroups: ["cdcissues", "cdcrfis"],
    authorizeHubWide: true,
    startDate: "2026-09-07T00:00:00.000Z",
    endDate: "2026-09-08T00:00:00.000Z",
    budget: { state: "known", consumed: 2 },
  });
  const body = JSON.parse(submittedBody) as Record<string, object>;
  assert.equal("projectStatus" in body, false);
  assert.equal("effectiveTo" in body, false);
  assert.equal(body.effectiveFrom, "2026-09-08T12:34:56.000Z");
  assert.deepEqual(body.serviceGroups, ["cdcissues", "cdcrfis"]);
});

test("every ONE_TIME request includes deterministic effectiveFrom and omits effectiveTo", async () => {
  const submitted: Array<Record<string, object>> = [];
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async (_input, init) => {
      submitted.push(JSON.parse(String(init?.body)) as Record<string, object>);
      return jsonResponse({ id: `request-${submitted.length}` });
    },
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
    {
      now: () => Date.parse("2026-09-08T09:10:11.000Z"),
      budgetGate: permissiveBudgetGate(),
    },
  );
  const budget = { state: "known", consumed: 0 } as const;
  await provider.submitFullSnapshot({
    description: "full",
    serviceGroups: ["admin", "iq"],
    authorizeHubWide: true,
    budget,
  });
  await provider.submitActivities({
    description: "activity",
    authorizeHubWide: true,
    startDate: "2026-09-05T00:00:00.000Z",
    endDate: "2026-09-08T00:00:00.000Z",
    budget,
  });
  await provider.submitCdc({
    description: "cdc",
    serviceGroups: ["cdcissues"],
    authorizeHubWide: true,
    startDate: "2026-09-07T00:00:00.000Z",
    endDate: "2026-09-08T00:00:00.000Z",
    budget,
  });
  assert.equal(submitted.length, 3);
  for (const body of submitted) {
    assert.equal(body.scheduleInterval, "ONE_TIME");
    assert.equal(body.effectiveFrom, "2026-09-08T09:10:11.000Z");
    assert.equal("effectiveTo" in body, false);
    assert.equal("projectIdList" in body, false, "explicit hub-wide requests must omit projectIdList");
  }
});

test("targeted Data Connector submissions require canonical IDs, authorized membership, and UTC windows", async () => {
  let submissions = 0;
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => {
      submissions += 1;
      return jsonResponse({ id: "request-authorized" });
    },
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
    { budgetGate: permissiveBudgetGate() },
  );
  const projectId = "11111111-2222-3333-4444-555555555555";
  const budget = { state: "known", consumed: 0 } as const;

  await assert.rejects(
    provider.submitFullSnapshot({ description: "bad", serviceGroups: ["admin"], projectIds: ["project-1"], accessibleProjectIds: ["project-1"], budget }),
    (error: unknown) => error instanceof ProviderOperationError && error.code === "dc-project-id-invalid",
  );
  await assert.rejects(
    provider.submitFullSnapshot({ description: "missing auth", serviceGroups: ["admin"], projectIds: [projectId], budget } as unknown as FullSnapshotRequest),
    (error: unknown) => error instanceof ProviderOperationError && error.code === "dc-project-authorization-missing",
  );
  await assert.rejects(
    provider.submitActivities({ description: "bad date", startDate: "09/01/2026", endDate: "2026-09-08T00:00:00.000Z", projectIds: [projectId], accessibleProjectIds: [projectId], budget }),
    (error: unknown) => error instanceof ProviderOperationError && error.code === "dc-date-window-invalid",
  );
  assert.equal(submissions, 0);

  await provider.submitFullSnapshot({
    description: "authorized",
    serviceGroups: ["admin"],
    projectIds: [projectId],
    accessibleProjectIds: [projectId],
    budget,
  });
  assert.equal(submissions, 1);
});

test("Data Connector scope is explicit and empty authorization never broadens to the hub", async () => {
  let submissions = 0;
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => {
      submissions += 1;
      return jsonResponse({ id: "must-not-submit" });
    },
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
    { budgetGate: permissiveBudgetGate() },
  );
  const projectId = "11111111-2222-3333-4444-555555555555";
  const budget = { state: "known", consumed: 0 } as const;
  const rejectsWith = async (request: object, code: string) => {
    await assert.rejects(
      provider.submitFullSnapshot(request as FullSnapshotRequest),
      (error: unknown) => error instanceof ProviderOperationError && error.code === code,
    );
  };

  await rejectsWith({ description: "missing scope", serviceGroups: ["admin"], budget }, "dc-project-scope-required");
  await rejectsWith({ description: "empty target", serviceGroups: ["admin"], projectIds: [], accessibleProjectIds: [], budget }, "dc-project-target-empty");
  await rejectsWith({ description: "empty authorization", serviceGroups: ["admin"], projectIds: [projectId], accessibleProjectIds: [], budget }, "dc-project-authorization-missing");
  await rejectsWith({ description: "scope conflict", serviceGroups: ["admin"], authorizeHubWide: true, projectIds: [projectId], accessibleProjectIds: [projectId], budget }, "dc-project-scope-conflict");
  assert.equal(submissions, 0);
});

test("latest-job discovery uses the request jobs endpoint and treats propagation lag as empty", async () => {
  const urls: string[] = [];
  let responseRows: readonly object[] = [];
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async (input) => {
      urls.push(String(input));
      return jsonResponse({
        pagination: { limit: 1, offset: 0, totalResults: responseRows.length },
        results: responseRows,
      });
    },
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
    {
      now: () => Date.parse("2026-09-08T12:00:00.000Z"),
      statePolicy: {
        queuedStatuses: ["queued"],
        runningStatuses: ["running"],
        terminalStatuses: ["complete"],
        successfulCompletionStatuses: ["success"],
        failedCompletionStatuses: ["failed"],
      },
    },
  );

  const pending = await provider.findLatestJobForRequest("request 1");
  assert.equal(pending.state, "empty");
  assert.match(urls[0] ?? "", /\/requests\/request%201\/jobs\?sort=desc&limit=1$/u);

  responseRows = [
    {
      id: "job-9",
      requestId: "request 1",
      status: "complete",
      completionStatus: "success",
      createdAt: "2026-09-08T11:59:00.000Z",
    },
  ];
  const found = await provider.findLatestJobForRequest("request 1");
  assert.equal(found.state, "available");
  if (found.state === "available") {
    assert.equal(found.data.id, "job-9");
    assert.equal(found.data.requestId, "request 1");
    assert.equal(found.data.state, "succeeded");
  }
});

test("malformed Data Connector object listings fail closed instead of becoming empty coverage", async () => {
  let response: object | readonly object[] = { data: [] };
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => jsonResponse(response),
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
  );

  const malformedJobs = await provider.findLatestJobForRequest("request-1");
  assert.equal(malformedJobs.state, "unreachable");
  if (malformedJobs.state === "unreachable") assert.match(malformedJobs.reason, /job listing/iu);

  response = { results: [{ id: "job-valid" }, { status: "queued" }] };
  const malformedJobEntry = await provider.findLatestJobForRequest("request-1");
  assert.equal(malformedJobEntry.state, "unreachable");
  if (malformedJobEntry.state === "unreachable") assert.match(malformedJobEntry.reason, /without an ID/iu);

  response = { results: [{ id: "   ", status: "queued" }] };
  const blankJobId = await provider.findLatestJobForRequest("request-1");
  assert.equal(blankJobId.state, "unreachable");
  if (blankJobId.state === "unreachable") assert.match(blankJobId.reason, /without an ID/iu);

  response = { results: [{ id: "job-invalid-time", createdAt: "yesterday" }] };
  const invalidJobTimestamp = await provider.findLatestJobForRequest("request-1");
  assert.equal(invalidJobTimestamp.state, "unreachable");
  if (invalidJobTimestamp.state === "unreachable") assert.match(invalidJobTimestamp.reason, /creation timestamp/iu);

  response = [{ name: "valid.csv" }, { size: 42 }];
  const malformedFiles = await provider.listFiles("job-1");
  assert.equal(malformedFiles.state, "unreachable");
  if (malformedFiles.state === "unreachable") assert.match(malformedFiles.reason, /without a name/iu);

  response = [{ name: "invalid-size.csv", size: "many" }];
  const invalidSize = await provider.listFiles("job-1");
  assert.equal(invalidSize.state, "unreachable");
  if (invalidSize.state === "unreachable") assert.match(invalidSize.reason, /invalid size/iu);

  response = [{ name: "negative-size.csv", size: -1 }];
  const negativeSize = await provider.listFiles("job-1");
  assert.equal(negativeSize.state, "unreachable");
  if (negativeSize.state === "unreachable") assert.match(negativeSize.reason, /invalid size/iu);

  response = [{ name: "invalid-time.csv", createdAt: "2026-02-30T00:00:00.000Z" }];
  const invalidFileTimestamp = await provider.listFiles("job-1");
  assert.equal(invalidFileTimestamp.state, "unreachable");
  if (invalidFileTimestamp.state === "unreachable") assert.match(invalidFileTimestamp.reason, /creation timestamp/iu);
});

test("malformed Data Connector submission identifiers and timestamps are rejected", async () => {
  let response: object = { id: "   " };
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => jsonResponse(response),
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
    { budgetGate: permissiveBudgetGate() },
  );
  const request = {
    description: "malformed receipt",
    serviceGroups: ["admin"],
    authorizeHubWide: true,
    budget: { state: "known", consumed: 0 },
  } as const;

  await assert.rejects(
    provider.submitFullSnapshot(request),
    (error: unknown) => error instanceof ProviderOperationError && error.code === "dc-submission-malformed",
  );
  response = { id: "request-invalid-time", createdAt: "2026-02-30T00:00:00.000Z" };
  await assert.rejects(
    provider.submitFullSnapshot(request),
    (error: unknown) => error instanceof ProviderOperationError && error.code === "dc-submission-malformed",
  );
});

test("Data Connector coverage and listing failures preserve transient retryability", async () => {
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => {
      throw new Error("temporary outage");
    },
    maxAttempts: 1,
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
  );
  const status = await provider.getJob("job-1");
  assert.equal(status.state, "unreachable");
  if (status.state === "unreachable") assert.equal(status.retryable, true);
  await assert.rejects(
    provider.downloadFile("job-1", "master.zip"),
    (error: unknown) => error instanceof ProviderOperationError &&
      error.code === "dc-listing-unreachable" && error.retryable,
  );
});

test("demo provider discovers a job only after returning its request ID", async () => {
  const provider = createProviderSet({ environment: { DATA_MODE: "demo" } }).dataConnector;
  const before = await provider.findLatestJobForRequest("demo-request-404");
  assert.equal(before.state, "empty");
  const receipt = await provider.submitFullSnapshot({
    description: "demo",
    serviceGroups: ["admin"],
    authorizeHubWide: true,
    budget: { state: "known", consumed: 0 },
  });
  const after = await provider.findLatestJobForRequest(receipt.requestId);
  assert.equal(after.state, "available");
  if (after.state === "available") assert.equal(after.data.requestId, receipt.requestId);
});

test("unknown Data Connector state tokens never become successful", () => {
  assert.equal(
    classifyDataConnectorJobState("complete", "success", FAIL_SAFE_JOB_STATE_POLICY),
    "unknown",
  );
  const observedPolicy = {
    queuedStatuses: ["queued"],
    runningStatuses: ["running"],
    terminalStatuses: ["complete"],
    successfulCompletionStatuses: ["success"],
    failedCompletionStatuses: ["failed"],
  } as const;
  assert.equal(classifyDataConnectorJobState("complete", "success", observedPolicy), "succeeded");
  assert.equal(classifyDataConnectorJobState("complete", "new-token", observedPolicy), "unknown");
});

test("file listing exposes names and metadata but strips signed URLs", async () => {
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () =>
      jsonResponse([
        {
          name: "issues.csv",
          size: "42",
          createdAt: "2026-09-08T12:00:00.000Z",
          signedUrl: "https://storage.example/private?signature=secret",
        },
      ]),
  });
  const provider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
  );
  const result = await provider.listFiles("job-1");
  assert.equal(result.state, "available");
  if (result.state === "available") {
    assert.deepEqual(result.data, [
      { name: "issues.csv", sizeBytes: 42, createdAt: "2026-09-08T12:00:00.000Z" },
    ]);
    assert.equal("signedUrl" in result.data[0]!, false);
  }
});

test("Data Connector downloads enforce listing and streamed byte limits", async () => {
  let downloadCalls = 0;
  const oversizedListingTransport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => jsonResponse([{ name: "master.zip", size: 9 }]),
  });
  const oversizedListingProvider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    oversizedListingTransport,
    {
      maxDownloadBytes: 8,
      allowedDownloadHosts: ["storage.example"],
      downloadFetch: async () => {
        downloadCalls += 1;
        return new Response(new Uint8Array([1]));
      },
    },
  );
  await assert.rejects(
    oversizedListingProvider.downloadFile("job-1", "master.zip"),
    (error: unknown) => error instanceof ProviderOperationError && error.code === "dc-file-too-large",
  );
  assert.equal(downloadCalls, 0);

  let apsCalls = 0;
  const streamedTransport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => {
      apsCalls += 1;
      return apsCalls === 1
        ? jsonResponse([{ name: "master.zip", size: 8 }])
        : jsonResponse({ name: "master.zip", size: 8, signedUrl: "https://storage.example/master.zip?signature=secret" });
    },
  });
  const streamedProvider = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    streamedTransport,
    {
      maxDownloadBytes: 8,
      allowedDownloadHosts: ["storage.example"],
      downloadFetch: async (_input, init) => {
        assert.ok(init?.signal);
        return new Response(new Uint8Array(9));
      },
    },
  );
  await assert.rejects(
    streamedProvider.downloadFile("job-1", "master.zip"),
    (error: unknown) => error instanceof ProviderOperationError && error.code === "dc-file-too-large",
  );
});

test("Data Connector downloads require listing, receipt, header, and body sizes to agree", async () => {
  async function rejectsFor(
    receipt: object,
    response: Response,
    code: string,
  ): Promise<void> {
    let apsCalls = 0;
    let downloadCalls = 0;
    const transport = new ApsReadTransport({
      accessContext: async () => ({ accessToken: "token", userId: null }),
      fetch: async () => {
        apsCalls += 1;
        return apsCalls === 1
          ? jsonResponse([{ name: "master.zip", size: 2 }])
          : jsonResponse(receipt);
      },
    });
    const provider = new AutodeskDataConnectorProvider(
      { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
      transport,
      {
        maxDownloadBytes: 8,
        allowedDownloadHosts: ["storage.example"],
        downloadFetch: async () => {
          downloadCalls += 1;
          return response;
        },
      },
    );
    await assert.rejects(
      provider.downloadFile("job-1", "master.zip"),
      (error: unknown) => error instanceof ProviderOperationError && error.code === code,
    );
    if (code === "dc-download-metadata-mismatch") assert.equal(downloadCalls, 0);
  }

  const signedUrl = "https://storage.example/master.zip?signature=secret";
  await rejectsFor(
    { name: "master.zip", size: 3, signedUrl },
    new Response(new Uint8Array([1, 2, 3])),
    "dc-download-metadata-mismatch",
  );
  await rejectsFor(
    { name: "master.zip", size: 2, signedUrl },
    new Response(new Uint8Array([1, 2]), { headers: { "content-length": "3" } }),
    "dc-download-size-mismatch",
  );
  await rejectsFor(
    { name: "master.zip", size: 2, signedUrl },
    new Response(new Uint8Array([1, 2, 3])),
    "dc-download-size-mismatch",
  );
});

test("signed downloads require an exact host allowlist and revalidate every redirect", async () => {
  let apsCalls = 0;
  const transport = new ApsReadTransport({
    accessContext: async () => ({ accessToken: "token", userId: null }),
    fetch: async () => {
      apsCalls += 1;
      return apsCalls % 2 === 1
        ? jsonResponse([{ name: "master.zip", size: 2 }])
        : jsonResponse({ name: "master.zip", size: 2, signedUrl: "https://storage.example/master.zip?signature=secret" });
    },
  });

  let rejectedFetches = 0;
  const rejected = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
    {
      allowedDownloadHosts: ["storage.example"],
      downloadFetch: async (_input, init) => {
        rejectedFetches += 1;
        assert.equal(init?.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.example/collect" },
        });
      },
    },
  );
  await assert.rejects(
    rejected.downloadFile("job-1", "master.zip"),
    (error: unknown) => error instanceof ProviderOperationError &&
      error.code === "dc-download-host-rejected" &&
      !error.message.includes("untrusted.example"),
  );
  assert.equal(rejectedFetches, 1);

  const followed: string[] = [];
  const accepted = new AutodeskDataConnectorProvider(
    { accountId: CONFIG_ENV.ACC_ACCOUNT_ID },
    transport,
    {
      allowedDownloadHosts: ["storage.example", "storage-two.example"],
      downloadFetch: async (input, init) => {
        followed.push(String(input));
        assert.equal(init?.redirect, "manual");
        return followed.length === 1
          ? new Response(null, {
              status: 307,
              headers: { location: "https://storage-two.example/final?signature=new" },
            })
          : new Response(new Uint8Array([1, 2]));
      },
    },
  );
  assert.deepEqual(
    await accepted.downloadFile("job-2", "master.zip"),
    new Uint8Array([1, 2]),
  );
  assert.deepEqual(followed.map((value) => new URL(value).hostname), [
    "storage.example",
    "storage-two.example",
  ]);
});

test("schedule provider is extract-only and offers no refresh operation", async () => {
  let sourceMode: string | null = null;
  const noRecords: CoverageResult<readonly RiskRecord[]> = {
    state: "empty",
    observedAt: "2026-09-08T12:00:00.000Z",
    reason: "none",
    warnings: [],
  };
  const provider = new AutodeskScheduleProvider({
    read: async (_projectId, _kinds, source) => {
      sourceMode = source;
      return noRecords;
    },
  });
  await provider.listActivitiesFromLatestExtract("project-1");
  assert.equal(sourceMode, "extract-only");
  assert.equal("refresh" in provider, false);
});
