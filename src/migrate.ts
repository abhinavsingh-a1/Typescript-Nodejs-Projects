// CLI: npm run migrate            -> apply all new migrations
//      npm run migrate -- --to=002 -> stop after version 002
import { config } from './config.js';
import { runMigrations } from './migrations.js';

const to = process.argv.find((a) => a.startsWith('--to='))?.slice('--to='.length);

try {
  const applied = await runMigrations(config.adminDatabaseUrl, { to, log: (m) => console.log(m) });
  console.log(applied.length ? `Migration done: ${applied.length} applied.` : 'Migration done: already up to date.');
} catch (err) {
  console.error('Migration failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
