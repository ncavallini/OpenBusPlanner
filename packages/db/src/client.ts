import postgres from 'postgres';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Sql = postgres.Sql<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tx = postgres.TransactionSql<any>;

export const DEFAULT_DATABASE_URL = 'postgres://openbus:openbus@localhost:55432/openbus';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function createSql(url = databaseUrl(), opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    // Dates stay ISO strings (YYYY-MM-DD) — never shifted through the JS Date time zone.
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
    },
    transform: { undefined: null },
  }) as Sql;
}
