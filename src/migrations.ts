// Versioned migrations runner.
// - Files in /migrations named 001_xxx.sql, 002_xxx.sql ... run in order.
// - Each file runs ONCE (remembered in schema_migrations), in a transaction.
// - A Postgres advisory lock stops two deploys from migrating at the same time.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const LOCK_ID = 424242;

export interface MigrateOptions {
  /** Stop after this version, e.g. "002". */
  to?: string;
  log?: (message: string) => void;
}

export async function runMigrations(connectionString: string, options: MigrateOptions = {}): Promise<string[]> {
  const log = options.log ?? (() => {});
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      file       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const done = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(done.rows.map((r) => r.version));

    const files = (await readdir(DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const appliedNow: string[] = [];

    for (const file of files) {
      const version = file.slice(0, 3);
      if (options.to && version > options.to) break;
      if (applied.has(version)) continue;

      const sql = await readFile(join(DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, file) VALUES ($1, $2)', [version, file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      log(`applied ${file}`);
      appliedNow.push(file);
    }
    return appliedNow;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}
