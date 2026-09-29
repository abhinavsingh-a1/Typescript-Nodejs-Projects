// Versioned migrations + zero-downtime rename (expand -> migrate -> contract).
// Uses a SEPARATE test database, created and deleted by this script.
import 'dotenv/config';
import pg from 'pg';
import { runMigrations } from '../src/migrations.js';
import { check, fail, finish } from './helpers.js';

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) throw new Error('ADMIN_DATABASE_URL missing in .env');
const TEST_DB = 'flowlite_migration_test';
const testUrl = (() => {
  const u = new URL(adminUrl);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
})();

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const columns = (c: pg.Client) =>
  c
    .query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'tenants'")
    .then((r) => r.rows.map((x) => x.column_name));

try {
  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await c.query(`CREATE DATABASE ${TEST_DB}`);
  });

  console.log('--- 001: initial schema ---');
  let applied = await runMigrations(testUrl, { to: '001' });
  check('001 applied', applied.join() === '001_init.sql', applied);

  await withClient(testUrl, async (c) => {
    let cols = await columns(c);
    check('tenants has "name"', cols.includes('name') && !cols.includes('display_name'), cols);

    console.log('\n--- 002 EXPAND: add display_name + sync trigger ---');
    applied = await runMigrations(testUrl, { to: '002' });
    check('002 applied', applied.join() === '002_tenant_display_name_expand.sql', applied);
    cols = await columns(c);
    check('Both columns exist', cols.includes('name') && cols.includes('display_name'), cols);

    await c.query("INSERT INTO tenants (id, name, api_key) VALUES ('old', 'Old App Clinic', 'k-old')");
    const oldRow = await c.query("SELECT display_name FROM tenants WHERE id = 'old'");
    check('OLD app (writes name) still works, display_name synced', oldRow.rows[0].display_name === 'Old App Clinic', oldRow.rows[0]);

    await c.query("INSERT INTO tenants (id, display_name, api_key) VALUES ('new', 'New App Clinic', 'k-new')");
    const newRow = await c.query("SELECT name FROM tenants WHERE id = 'new'");
    check('NEW app (writes display_name) works, name synced', newRow.rows[0].name === 'New App Clinic', newRow.rows[0]);

    await c.query("UPDATE tenants SET name = 'Renamed' WHERE id = 'old'");
    const renamed = await c.query("SELECT display_name FROM tenants WHERE id = 'old'");
    check('OLD app update is synced too', renamed.rows[0].display_name === 'Renamed', renamed.rows[0]);

    console.log('\n--- 003 MIGRATE: backfill ---');
    applied = await runMigrations(testUrl, { to: '003' });
    const nulls = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM tenants WHERE display_name IS NULL');
    check('003 applied, no empty display_name', applied.length === 1 && nulls.rows[0].n === 0, nulls.rows[0]);

    console.log('\n--- 004 CONTRACT: remove old column ---');
    applied = await runMigrations(testUrl);
    cols = await columns(c);
    check('004 applied, "name" removed', applied.join() === '004_tenant_display_name_contract.sql' && !cols.includes('name'), cols);

    console.log('\n--- Re-run ---');
    applied = await runMigrations(testUrl);
    check('Nothing applied twice', applied.length === 0, applied);
    const versions = await c.query('SELECT version FROM schema_migrations ORDER BY version');
    check('4 versions recorded', versions.rows.map((r) => r.version).join() === '001,002,003,004', versions.rows);
  });
} catch (err) {
  fail((err as Error).message);
} finally {
  await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`)).catch(() => {});
}
finish();
