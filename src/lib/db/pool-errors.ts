export interface PoolErrorEmitter {
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Contain pg-pool idle-client errors without exposing provider details or credentials. */
export function installPostgresPoolErrorHandler(
  pool: PoolErrorEmitter,
  report: (message: string) => void = (message) => console.error(message),
): void {
  pool.on("error", () => {
    report("Postgres pool idle client error; readiness and subsequent queries may fail.");
  });
}
