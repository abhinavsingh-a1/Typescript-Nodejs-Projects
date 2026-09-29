// MODE=single: after a restart, find unfinished orders and run them again.
// Safe because runSaga resumes from saga_log (finished steps are skipped).
import type { Logger } from 'pino';
import { pool, withTenant } from './db.js';
import { getRuntime } from './runtime/index.js';

export async function recoverUnfinishedOrders(log: Logger): Promise<number> {
  const tenants = await pool.query<{ id: string }>('SELECT id FROM tenants');
  let count = 0;
  for (const { id: tenantId } of tenants.rows) {
    const orders = await withTenant(tenantId, async (db) => {
      const result = await db.query<{ id: number }>(
        "SELECT id FROM orders WHERE status IN ('pending', 'processing') ORDER BY id",
      );
      return result.rows;
    });
    for (const { id } of orders) {
      await getRuntime().queue.enqueue({ tenantId, orderId: id });
      count++;
    }
  }
  log.info({ count }, 'recovered unfinished orders');
  return count;
}
