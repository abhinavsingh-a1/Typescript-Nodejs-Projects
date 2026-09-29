// Scenario 4: daily report per clinic, with a cron LOCK.
// Many schedulers may run (like 3 servers); each slot must run only ONCE.
import type { Logger } from 'pino';
import { pool, withTenant } from './db.js';
import type { Lock } from './types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19); // HH:MM:SS (UTC)

export interface SchedulerOptions {
  name: string;
  intervalMs: number;
  lock: Lock | null; // null = no lock (only to SHOW the problem)
  log: Logger;
}

/** Starts the timer. Returns a function that stops it. */
export function startScheduler({ name, intervalMs, lock, log }: SchedulerOptions): () => void {
  let lastSlot = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  // The actual job: one report per clinic.
  async function sendReports(slot: number): Promise<void> {
    const tenants = await pool.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM tenants ORDER BY id',
    );
    for (const tenant of tenants.rows) {
      const stats = await withTenant(tenant.id, async (db) => {
        const { rows } = await db.query<{ orders: number; completed: number; revenue: string }>(`
          SELECT count(*)::int                                               AS orders,
                 count(*) FILTER (WHERE status = 'completed')::int            AS completed,
                 COALESCE(sum(amount) FILTER (WHERE status = 'completed'), 0) AS revenue
          FROM orders`);
        await db.query(
          `INSERT INTO reports (slot, tenant_id, orders, completed, revenue)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slot, tenant_id) DO NOTHING`,
          [new Date(slot), tenant.id, rows[0].orders, rows[0].completed, rows[0].revenue],
        );
        return rows[0];
      });

      // In real life: send an email here.
      log.info(
        { event: 'email_sent', slot, tenant: tenant.id, slotTime: clock(slot), orders: stats.orders, revenue: stats.revenue },
        `slot ${clock(slot)} -> EMAIL SENT to ${tenant.display_name}`,
      );
    }
  }

  async function tryRun(slot: number): Promise<void> {
    await sleep(Math.random() * 300); // real servers never fire at the same millisecond

    if (lock) {
      let gotLock: boolean;
      try {
        // One key PER SLOT, so a late server still sees "taken".
        gotLock = await lock.acquire(`lock:report:${slot}`, intervalMs * 2, name);
      } catch (err) {
        // Safer to skip than to risk sending twice.
        log.error({ event: 'lock_error', slot, err: (err as Error).message }, `slot ${clock(slot)} -> lock error, skipping`);
        return;
      }
      if (!gotLock) {
        log.info({ event: 'skipped', slot }, `slot ${clock(slot)} -> skipped (another instance has the lock)`);
        return;
      }
    }
    await sendReports(slot);
  }

  // Timer: wake up exactly at every slot boundary.
  function scheduleNext(): void {
    if (stopped) return;
    const now = Date.now();
    const next = Math.max(Math.floor(now / intervalMs) * intervalMs + intervalMs, lastSlot + intervalMs);
    timer = setTimeout(async () => {
      lastSlot = next;
      try {
        await tryRun(next);
      } catch (err) {
        log.error({ event: 'job_error', slot: next, err: (err as Error).message }, `slot ${clock(next)} -> job error`);
      }
      scheduleNext();
    }, next - now);
  }

  log.info({ intervalSeconds: intervalMs / 1000, lock: Boolean(lock) }, 'ready');
  scheduleNext();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
