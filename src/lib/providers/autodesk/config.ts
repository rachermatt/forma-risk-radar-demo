import { normalizedApsScopes } from "../../config/environment";
import type { HubRegion } from "../contracts";
import { ProviderConfigurationError } from "../errors";
import { isIP } from "node:net";

export interface AutodeskProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  readonly accountId: string;
  readonly sessionSecret: string;
  /** Explicit because the verified scope strings remain an open live-account item. */
  readonly scopes: readonly string[];
  /** Exact hosts observed and operator-approved for signed extract downloads. */
  readonly dataConnectorDownloadHosts?: readonly string[];
  readonly region?: HubRegion;
}

type Environment = Readonly<Record<string, string | undefined>>;

const PLACEHOLDER_PATTERN = /^(change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|todo)/i;

function required(environment: Environment, key: string): string {
  const value = environment[key]?.trim();
  if (!value || PLACEHOLDER_PATTERN.test(value)) {
    throw new ProviderConfigurationError(`${key} is required for DATA_MODE=autodesk.`);
  }
  return value;
}

function parseScopes(value: string): readonly string[] {
  const scopes = normalizedApsScopes(value);
  if (!scopes) {
    throw new ProviderConfigurationError(
      "APS_SCOPES must contain a unique, non-empty list from the verified APS authentication reference; no scope list is assumed.",
    );
  }
  return scopes;
}

function parseDownloadHosts(value: string | undefined): readonly string[] {
  if (!value?.trim()) return Object.freeze([]);
  const hosts = value.split(/[\s,]+/u)
    .map((host) => host.trim().toLowerCase().replace(/\.$/u, ""))
    .filter(Boolean);
  if (hosts.length === 0 || new Set(hosts).size !== hosts.length) {
    throw new ProviderConfigurationError(
      "APS_DATA_CONNECTOR_DOWNLOAD_HOSTS must contain unique exact DNS hostnames.",
    );
  }
  for (const host of hosts) {
    if (
      host.length > 253 ||
      isIP(host) !== 0 ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host)
    ) {
      throw new ProviderConfigurationError(
        "APS_DATA_CONNECTOR_DOWNLOAD_HOSTS must contain unique exact DNS hostnames.",
      );
    }
  }
  return Object.freeze(hosts);
}

export function readAutodeskProviderConfig(
  environment: Environment = process.env,
): AutodeskProviderConfig {
  const clientId = required(environment, "APS_CLIENT_ID");
  const clientSecret = required(environment, "APS_CLIENT_SECRET");
  const callbackUrl = required(environment, "APS_CALLBACK_URL");
  const accountId = required(environment, "ACC_ACCOUNT_ID");
  const sessionSecret = required(environment, "SESSION_SECRET");
  const scopes = parseScopes(required(environment, "APS_SCOPES"));
  const dataConnectorDownloadHosts = parseDownloadHosts(
    environment.APS_DATA_CONNECTOR_DOWNLOAD_HOSTS,
  );

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(accountId)) {
    throw new ProviderConfigurationError("ACC_ACCOUNT_ID must be a bare GUID, without a b. prefix.");
  }
  if (sessionSecret.length < 32) {
    throw new ProviderConfigurationError("SESSION_SECRET must contain at least 32 characters.");
  }

  let parsedCallback: URL;
  try {
    parsedCallback = new URL(callbackUrl);
  } catch {
    throw new ProviderConfigurationError("APS_CALLBACK_URL must be an absolute URL.");
  }
  const loopback = parsedCallback.hostname === "localhost" ||
    parsedCallback.hostname === "127.0.0.1" || parsedCallback.hostname === "[::1]";
  const localHttp = parsedCallback.protocol === "http:" && loopback;
  if (
    (parsedCallback.protocol !== "https:" && !localHttp) ||
    parsedCallback.username !== "" ||
    parsedCallback.password !== "" ||
    parsedCallback.hash !== ""
  ) {
    throw new ProviderConfigurationError("APS_CALLBACK_URL must use HTTPS, except on localhost.");
  }

  const configuredRegion = environment.ACC_REGION?.trim().toUpperCase();
  if (configuredRegion && configuredRegion !== "US" && configuredRegion !== "EMEA") {
    throw new ProviderConfigurationError("ACC_REGION must be US, EMEA, or empty for probing.");
  }

  return {
    clientId,
    clientSecret,
    callbackUrl: parsedCallback.toString(),
    accountId,
    sessionSecret,
    scopes,
    dataConnectorDownloadHosts,
    ...(configuredRegion ? { region: configuredRegion as HubRegion } : {}),
  };
}
