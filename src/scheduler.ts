// Standalone scheduler for MODE=distributed. Run several copies:
// the Redis lock makes sure each report slot runs only once.
//   REPORT_INTERVAL_SECONDS  how often (default 60; daily = 86400)
//   USE_LOCK=false           turn lock off (to SEE the problem)
//   INSTANCE_NAME            name shown in logs
import { config } from './config.js';
import { pool } from './db.js';
import { createLogger } from './logger.js';
import { startScheduler } from './reports.js';
import { getRuntime } from './runtime/index.js';

const name = process.env.INSTANCE_NAME || `scheduler-${process.pid}`;
const log = createLogger({ service: 'scheduler', instance: name });

if (config.mode !== 'distributed') {
  log.error('npm run scheduler is only for MODE=distributed. In MODE=single the API runs it.');
  process.exit(2);
}

const runtime = getRuntime();
const stop = startScheduler({
  name,
  intervalMs: config.reportIntervalMs,
  lock: process.env.USE_LOCK === 'false' ? null : runtime.lock,
  log,
});

async function shutdown(): Promise<void> {
  log.info('shutting down...');
  stop();
  await runtime.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
