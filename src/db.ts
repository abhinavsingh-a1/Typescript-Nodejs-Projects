// Postgres connection (our "notebook").
// The app user is restricted by Row-Level Security (RLS):
// it can only see rows of the tenant set with withTenant().
import pg from 'pg';
import { config } from './config.js';
import { createLogger } from './logger.js';
import type { Db } from './types.js';

const log = createLogger({ service: 'db' });

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// Without this, a dropped idle connection would crash the process.
pool.on('error', (err) => log.error({ err: err.message }, 'idle database connection error'));

export async function checkDb(): Promise<void> {
  await pool.query('SELECT 1');
}

/**
 * Runs `work` in ONE transaction that can only see ONE tenant's rows.
 * set_config(..., true) = only for this transaction, so pooled
 * connections never leak a tenant to the next request.
 */
export async function withTenant<T>(tenantId: string, work: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
