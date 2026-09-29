// Entry point: the API.
// MODE=single      -> this process ALSO runs the worker + scheduler (no Redis).
// MODE=distributed -> only the API; workers/schedulers are separate processes.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { checkDb, pool } from './db.js';
import { attachLive } from './live.js';
import { createLogger } from './logger.js';
import { httpMetrics, registry } from './metrics.js';
import { recoverUnfinishedOrders } from './recovery.js';
import { checkRedis } from './redis.js';
import { startScheduler } from './reports.js';
import { inventoryRouter } from './routes/inventory.js';
import { ordersRouter } from './routes/orders.js';
import { paymentsRouter } from './routes/payments.js';
import { tenantInfoRouter } from './routes/tenantInfo.js';
import { webhooksRouter } from './routes/webhooks.js';
import { pluginsRouter, workflowsRouter } from './routes/workflows.js';
import { getRuntime } from './runtime/index.js';
import { crashHook, processOrder } from './saga/processOrder.js';
import { rateLimit, tenantAuth } from './tenants.js';

const log = createLogger({ service: 'api', mode: config.mode });
const runtime = getRuntime();
const app = express();

// Request logging + request ID (kept if the caller sends "X-Request-Id").
app.use(
  pinoHttp({
    logger: log,
    genReqId(req, res) {
      const header = req.headers['x-request-id'];
      const id = (Array.isArray(header) ? header[0] : header) || randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel(req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    autoLogging: { ignore: (req) => req.url === '/metrics' || req.url === '/health' },
  }),
);
app.use(httpMetrics);
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)))); // live.html

// Health: DB always; Redis only in distributed mode.
app.get('/health', async (req, res) => {
  const [db, redis] = await Promise.allSettled([
    checkDb(),
    config.mode === 'distributed' ? checkRedis() : Promise.resolve(),
  ]);
  const result = {
    mode: config.mode,
    db: db.status === 'fulfilled' ? 'up' : 'down',
    redis: config.mode === 'single' ? 'not used' : redis.status === 'fulfilled' ? 'up' : 'down',
  };
  const healthy = result.db === 'up' && result.redis !== 'down';
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'error', ...result });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

// Provider-level routes (no tenant key).
app.use('/webhooks', webhooksRouter);
app.use('/payments', paymentsRouter);

// Tenant routes: API key + per-tenant rate limit.
app.use('/tenants', tenantAuth, rateLimit, tenantInfoRouter);
app.use('/inventory', tenantAuth, rateLimit, inventoryRouter);
app.use('/orders', tenantAuth, rateLimit, ordersRouter);
app.use('/plugins', tenantAuth, rateLimit, pluginsRouter);
app.use('/workflows', tenantAuth, rateLimit, workflowsRouter);

// Error handler (must be last, needs 4 arguments). Bad JSON -> 400, else 500.
app.use((err: { status?: number }, req: Request, res: Response, _next: NextFunction) => {
  const status = err.status === 400 ? 400 : 500;
  if (status === 500) req.log.error({ err }, 'unhandled error');
  res.status(status).json({ error: status === 400 ? 'Invalid JSON body' : 'Internal server error' });
});

const server = app.listen(config.port, () => {
  log.info({ port: config.port }, `FlowLite (${config.mode}) running on http://localhost:${config.port}`);
});
const live = await attachLive(server, log);

// ---- Single mode: run worker + scheduler inside this process ----
let stopScheduler: (() => void) | undefined;
if (config.mode === 'single') {
  const workerLog = createLogger({ service: 'worker', mode: 'single' });
  runtime.queue.startWorker((job, jobLog) => processOrder(job, { afterStep: crashHook(jobLog) }), workerLog);
  stopScheduler = startScheduler({
    name: 'single',
    intervalMs: config.reportIntervalMs,
    lock: runtime.lock,
    log: createLogger({ service: 'scheduler', mode: 'single' }),
  });
  await recoverUnfinishedOrders(log).catch((err: Error) => log.error({ err: err.message }, 'recovery failed'));
}

// Clean shutdown on Ctrl+C.
async function shutdown(): Promise<void> {
  log.info('shutting down...');
  stopScheduler?.();
  live.close();
  server.close();
  await runtime.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
