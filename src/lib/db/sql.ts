export type SqlValue = string | number | boolean | Date | null | readonly string[] | Readonly<Record<string, unknown>>;

export interface SqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: readonly Row[];
  rowCount: number;
}

export interface SqlExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly SqlValue[],
  ): Promise<SqlResult<Row>>;
  exec(text: string): Promise<void>;
}

export interface Sql extends SqlExecutor {
  transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
