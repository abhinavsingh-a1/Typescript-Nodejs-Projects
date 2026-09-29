// Prometheus metrics, served at GET /metrics.
import type { NextFunction, Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { pool, withTenant } from './db.js';
import { createLogger } from './logger.js';
import { getRuntime } from './runtime/index.js';

const log = createLogger({ service: 'metrics' });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'flowlite_' }); // CPU, memory, event loop

// ---- HTTP (RED metrics: Rate, Errors, Duration) ----
const httpRequests = new Counter({
  name: 'flowlite_http_requests_total',
  help: 'HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});
const httpDuration = new Histogram({
  name: 'flowlite_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 1, 3],
  registers: [registry],
});

/** Express middleware: measure every request. */
export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const stop = httpDuration.startTimer();
  res.on('finish', () => {
    // Use the route pattern (/orders/:id), not the real URL (/orders/42),
    // so the number of labels stays small.
    const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequests.inc(labels);
    stop(labels);
  });
  next();
}

// ---- Business metrics ----
export const webhookEvents = new Counter({
  name: 'flowlite_webhook_events_total',
  help: 'Payment webhooks by result (processed / duplicate)',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const rateLimited = new Counter({
  name: 'flowlite_rate_limited_total',
  help: 'Requests rejected by the per-tenant rate limit',
  labelNames: ['tenant'] as const,
  registers: [registry],
});

export const pluginRuns = new Counter({
  name: 'flowlite_plugin_runs_total',
  help: 'Workflow node executions by plugin type and result',
  labelNames: ['type', 'result'] as const,
  registers: [registry],
});

// Read from the DB when Prometheus asks, so it includes work done by ALL workers.
new Gauge({
  name: 'flowlite_orders',
  help: 'Orders by tenant and status',
  labelNames: ['tenant', 'status'] as const,
  registers: [registry],
  async collect() {
    try {
      const tenants = await pool.query<{ id: string }>('SELECT id FROM tenants');
      this.reset();
      for (const { id } of tenants.rows) {
        const rows = await withTenant(id, async (db) => {
          const result = await db.query<{ status: string; n: number }>(
            'SELECT status, count(*)::int AS n FROM orders GROUP BY status',
          );
          return result.rows;
        });
        for (const r of rows) this.set({ tenant: id, status: r.status }, r.n);
      }
    } catch (err) {
      log.warn({ err: errorText(err) }, 'could not read order metrics');
    }
  },
});

new Gauge({
  name: 'flowlite_queue_jobs',
  help: 'Jobs in the orders queue by state',
  labelNames: ['state'] as const,
  registers: [registry],
  async collect() {
    try {
      const counts = await getRuntime().queue.counts();
      for (const [state, n] of Object.entries(counts)) this.set({ state }, n);
    } catch (err) {
      log.warn({ err: errorText(err) }, 'could not read queue metrics');
    }
  },
});
