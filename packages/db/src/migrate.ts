import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './client';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_KEY = 727274;

/**
 * Applies pending SQL migrations in filename order, each in its own transaction. A
 * transaction-scoped advisory lock serialises concurrent migrators (API + worker start).
 */
export async function migrate(sql: Sql, log: (m: string) => void = () => {}): Promise<string[]> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  });
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    const did = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
      const [row] = await tx`SELECT 1 FROM schema_migrations WHERE name = ${f}`;
      if (row) return false;
      await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
      return true;
    });
    if (did) {
      log(`applied migration ${f}`);
      applied.push(f);
    }
  }
  return applied;
}
