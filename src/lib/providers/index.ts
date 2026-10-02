import { normalizedDataMode } from "../config/environment";
import { createAutodeskProviders, type AutodeskProviderDependencies } from "./autodesk";
import { readAutodeskProviderConfig } from "./autodesk/config";
import type { ProviderMode, ProviderSet } from "./contracts";
import { createDemoProviders } from "./demo";
import { ProviderConfigurationError } from "./errors";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ProviderCompositionOptions {
  readonly mode?: ProviderMode;
  readonly environment?: Environment;
  readonly autodesk?: AutodeskProviderDependencies;
}

export function resolveDataMode(environment: Environment = process.env): ProviderMode {
  const mode = normalizedDataMode(environment.DATA_MODE);
  if (mode) return mode;
  throw new ProviderConfigurationError("DATA_MODE must be demo or autodesk.");
}

/** Selects provider implementations once. Demo is evaluated before APS configuration. */
export function createProviderSet(options: ProviderCompositionOptions = {}): ProviderSet {
  const environment = options.environment ?? process.env;
  const mode = options.mode ?? resolveDataMode(environment);
  if (mode === "demo") return createDemoProviders();

  if (!options.autodesk) {
    throw new ProviderConfigurationError(
      "Autodesk provider dependencies are required for DATA_MODE=autodesk.",
    );
  }
  return createAutodeskProviders(readAutodeskProviderConfig(environment), options.autodesk);
}

export * from "./budget";
export * from "./contracts";
export * from "./data-connector-budget-gate";
export * from "./errors";
