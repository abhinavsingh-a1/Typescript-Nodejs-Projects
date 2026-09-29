// Worker = the "AI server". Takes order jobs from the Redis queue.
// Only for MODE=distributed (in single mode the API runs the worker itself).
// Run many copies: npm run worker (in several terminals).
import { config } from './config.js';
import { pool } from './db.js';
import { createLogger } from './logger.js';
import { getRuntime } from './runtime/index.js';
import { crashHook, processOrder } from './saga/processOrder.js';

const log = createLogger({ service: 'worker', instance: process.env.INSTANCE_NAME || `worker-${process.pid}` });

if (config.mode !== 'distributed') {
  log.error('npm run worker is only for MODE=distributed. In MODE=single the API runs the worker.');
  process.exit(2);
}

const runtime = getRuntime();
runtime.queue.startWorker((job, jobLog) => processOrder(job, { afterStep: crashHook(jobLog) }), log);

async function shutdown(): Promise<void> {
  log.info('shutting down...');
  await runtime.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
