// Runs the order saga for one order. Used by the API (sync),
// the in-process queue (single mode) and workers (distributed mode).
// Safe to call again for the same order: it resumes or does nothing.
import type { Logger } from 'pino';
import { withTenant } from '../db.js';
import { getRuntime } from '../runtime/index.js';
import type { OrderContext, OrderEvent, OrderJob, OrderStatus, SimulateCrash, SimulateFail } from '../types.js';
import { isFinalStatus } from '../types.js';
import { orderSteps } from './orderSteps.js';
import { finalStatus, runSaga } from './runSaga.js';

interface OrderRow {
  id: number;
  tenant_id: string;
  sku: string;
  qty: number;
  amount: string; // NUMERIC comes back as text
  status: OrderStatus;
  simulate_fail: SimulateFail | null;
  simulate_crash: SimulateCrash | null;
}

export interface ProcessHooks {
  afterStep?: (stepName: string, ctx: OrderContext) => Promise<void>;
}

async function publish(event: OrderEvent): Promise<void> {
  try {
    await getRuntime().bus.publish(event);
  } catch {
    /* live updates are best effort */
  }
}

export async function processOrder(job: OrderJob, hooks: ProcessHooks = {}): Promise<OrderStatus> {
  const { tenantId, orderId } = job;

  const order = await withTenant(tenantId, async (db) => {
    const result = await db.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId]);
    return result.rows[0];
  });
  if (!order) throw new Error(`Order ${orderId} not found for tenant ${tenantId}`);
  if (isFinalStatus(order.status)) return order.status; // already finished

  await withTenant(tenantId, (db) =>
    db.query("UPDATE orders SET status = 'processing' WHERE id = $1 AND status = 'pending'", [orderId]),
  );
  await publish({ type: 'order.status', tenantId, orderId, status: 'processing' });

  const ctx: OrderContext = {
    tenantId,
    orderId,
    sku: order.sku,
    qty: order.qty,
    amount: Number(order.amount),
    simulateFail: order.simulate_fail,
    simulateCrash: order.simulate_crash,
  };

  const result = await runSaga({
    tenantId,
    sagaId: orderId,
    steps: orderSteps,
    ctx,
    afterStep: hooks.afterStep,
    onLog: (step, status) => publish({ type: 'order.step', tenantId, orderId, step, status }),
  });

  const status = finalStatus(result);
  await withTenant(tenantId, (db) =>
    db.query('UPDATE orders SET status = $2, failed_step = $3 WHERE id = $1', [
      orderId,
      status,
      result.ok ? null : result.failedStep,
    ]),
  );
  await publish({ type: 'order.status', tenantId, orderId, status });
  return status;
}

/** Demo: log each step, and "crash" right after reserving stock (first time only). */
export function crashHook(log: Logger): ProcessHooks['afterStep'] {
  return async (stepName, ctx) => {
    log.info({ step: stepName }, 'step done');
    if (ctx.simulateCrash === 'afterReserve' && stepName === 'reserveStock') {
      log.warn('💥 simulated crash!');
      process.exit(1);
    }
  };
}
