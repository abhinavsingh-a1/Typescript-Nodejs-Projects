// Multi-tenancy: who is calling, and are they sending too much?
import type { NextFunction, Request, Response } from 'express';
import { pool } from './db.js';
import { rateLimited } from './metrics.js';
import { getRuntime } from './runtime/index.js';
import type { Tenant } from './types.js';

// Adds "req.tenant" to Express requests.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

/** Finds a tenant by API key. (Demo: keys are plain text. Production: store a hash.) */
export async function findTenantByKey(apiKey: string): Promise<Tenant | null> {
  const result = await pool.query<{ id: string; display_name: string; rate_limit_per_minute: number }>(
    'SELECT id, display_name, rate_limit_per_minute FROM tenants WHERE api_key = $1',
    [apiKey],
  );
  const row = result.rows[0];
  return row ? { id: row.id, displayName: row.display_name, rateLimitPerMinute: row.rate_limit_per_minute } : null;
}

/** Middleware: requires header "X-Api-Key". Sets req.tenant. */
export async function tenantAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const apiKey = req.header('x-api-key');
    const tenant = apiKey ? await findTenantByKey(apiKey) : null;
    if (!tenant) {
      res.status(401).json({ error: 'Missing or invalid X-Api-Key header' });
      return;
    }
    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: per-tenant rate limit (noisy-neighbour protection).
 * One busy clinic cannot slow down all the others.
 */
export async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenant = requireTenant(req);
    const minute = Math.floor(Date.now() / 60000);
    const used = await getRuntime().counter.incr(`ratelimit:${tenant.id}:${minute}`, 60);
    const limit = tenant.rateLimitPerMinute;

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - used)));

    if (used > limit) {
      rateLimited.inc({ tenant: tenant.id });
      const retryAfter = 60 - Math.floor((Date.now() % 60000) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Rate limit exceeded', retryAfterSeconds: retryAfter });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Gets the tenant set by tenantAuth (typed, never undefined). */
export function requireTenant(req: Request): Tenant {
  if (!req.tenant) throw new Error('tenantAuth middleware missing on this route');
  return req.tenant;
}
