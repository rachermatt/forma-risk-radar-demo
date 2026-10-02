import type { PoolConfig } from "pg";

export type PostgresPoolPurpose = "runtime" | "migration" | "demo-seed";

type BoundedPoolSettings = Pick<
  PoolConfig,
  | "max"
  | "connectionTimeoutMillis"
  | "idleTimeoutMillis"
  | "maxLifetimeSeconds"
  | "statement_timeout"
  | "query_timeout"
  | "lock_timeout"
  | "idle_in_transaction_session_timeout"
>;

export const POSTGRES_POOL_LIMITS: Readonly<Record<PostgresPoolPurpose, Readonly<BoundedPoolSettings>>> = {
  runtime: {
    max: 8,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 300,
    statement_timeout: 30_000,
    query_timeout: 35_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
  },
  migration: {
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    maxLifetimeSeconds: 900,
    statement_timeout: 300_000,
    query_timeout: 310_000,
    lock_timeout: 15_000,
    idle_in_transaction_session_timeout: 300_000,
  },
  "demo-seed": {
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 600,
    statement_timeout: 60_000,
    query_timeout: 65_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 60_000,
  },
};

const APPLICATION_NAMES: Readonly<Record<PostgresPoolPurpose, string>> = {
  runtime: "forma-risk-radar",
  migration: "forma-risk-radar-migration",
  "demo-seed": "forma-risk-radar-demo-seed",
};

const RESERVED_CONNECTION_PARAMETERS = new Set([
  "application_name",
  "connect_timeout",
  "connectiontimeoutmillis",
  "database",
  "dbname",
  "fallback_application_name",
  "host",
  "hostaddr",
  "idle_in_transaction_session_timeout",
  "lock_timeout",
  "options",
  "password",
  "port",
  "query_timeout",
  "statement_timeout",
  "user",
  "username",
]);

function assertSafeConnectionString(connectionString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("PostgreSQL connection string must be a valid postgres:// or postgresql:// URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("PostgreSQL connection string must use the postgres:// or postgresql:// protocol.");
  }
  if (parsed.hash) {
    throw new Error("PostgreSQL connection URL must not contain a fragment.");
  }
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase().startsWith("ssl")) {
      throw new Error(
        `PostgreSQL connection URL must not set TLS parameter ${key}; verified TLS is enforced by the application for non-loopback hosts.`,
      );
    }
    if (RESERVED_CONNECTION_PARAMETERS.has(key.toLowerCase())) {
      throw new Error(`PostgreSQL connection URL must not set reserved client parameter ${key}.`);
    }
    throw new Error(`PostgreSQL connection URL must not set unapproved client parameter ${key}.`);
  }
  return parsed;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}

export function postgresPoolConfig(
  connectionString: string,
  purpose: PostgresPoolPurpose,
): PoolConfig {
  const parsed = assertSafeConnectionString(connectionString);
  const loopback = isLoopbackHost(parsed.hostname);
  return {
    connectionString,
    // URL ssl* options are rejected above because node-postgres can replace
    // this object while parsing them. Plaintext is permitted only on loopback.
    ssl: loopback ? false : { rejectUnauthorized: true },
    enableChannelBinding: !loopback,
    application_name: APPLICATION_NAMES[purpose],
    // A non-empty explicit value prevents PGOPTIONS from replacing the
    // server-side bounds through the process environment.
    options: "-c timezone=UTC",
    ...POSTGRES_POOL_LIMITS[purpose],
  };
}

export function requireMigrationDatabaseUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const migrationDatabaseUrl = environment.MIGRATION_DATABASE_URL?.trim();
  if (!migrationDatabaseUrl) {
    throw new Error(
      "MIGRATION_DATABASE_URL is required for db:migrate; DATABASE_URL is deliberately ignored.",
    );
  }
  return migrationDatabaseUrl;
}
