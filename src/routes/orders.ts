// Orders: reserve slot -> charge -> deliver (saga).
//   POST /orders        -> runs now, waits for result
//   POST /orders/async  -> queued, a worker runs it
import { Router } from 'express';
import { withTenant } from '../db.js';
import { getRuntime } from '../runtime/index.js';
import { processOrder } from '../saga/processOrder.js';
import { requireTenant } from '../tenants.js';
import type { SimulateCrash, SimulateFail } from '../types.js';

export const ordersRouter = Router();

const FAIL_OPTIONS: SimulateFail[] = ['payment', 'shipping'];
const CRASH_OPTIONS: SimulateCrash[] = ['afterReserve'];

interface NewOrder {
  sku: string;
  qty: number;
  amount: number;
  simulateFail: SimulateFail | null;
  simulateCrash: SimulateCrash | null;
}

/** Returns a clean NewOrder, or null if the body is invalid. */
function parseOrder(body: unknown, allowCrash: boolean): NewOrder | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const valid =
    typeof b.sku === 'string' && b.sku.length > 0 &&
    Number.isInteger(b.qty) && (b.qty as number) > 0 &&
    typeof b.amount === 'number' && b.amount > 0 &&
    (b.simulateFail === undefined || FAIL_OPTIONS.includes(b.simulateFail as SimulateFail)) &&
    (b.simulateCrash === undefined || (allowCrash && CRASH_OPTIONS.includes(b.simulateCrash as SimulateCrash)));
  if (!valid) return null;
  return {
    sku: b.sku as string,
    qty: b.qty as number,
    amount: b.amount as number,
    simulateFail: (b.simulateFail as SimulateFail | undefined) ?? null,
    simulateCrash: (b.simulateCrash as SimulateCrash | undefined) ?? null,
  };
}

async function createOrder(tenantId: string, o: NewOrder): Promise<number> {
  return withTenant(tenantId, async (db) => {
    const result = await db.query<{ id: number }>(
      `INSERT INTO orders (tenant_id, sku, qty, amount, simulate_fail, simulate_crash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, o.sku, o.qty, o.amount, o.simulateFail, o.simulateCrash],
    );
    return result.rows[0].id;
  });
}

/** Full picture of one order. Returns null if not found (or other tenant's). */
async function getOrderDetails(tenantId: string, orderId: number) {
  return withTenant(tenantId, async (db) => {
    const order = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (order.rowCount === 0) return null;
    const log = await db.query('SELECT step, status, error FROM saga_log WHERE order_id = $1 ORDER BY id', [orderId]);
    const charge = await db.query('SELECT * FROM charges WHERE order_id = $1', [orderId]);
    const shipment = await db.query('SELECT * FROM shipments WHERE order_id = $1', [orderId]);
    return {
      order: order.rows[0],
      log: log.rows,
      charge: charge.rows[0] ?? null,
      shipment: shipment.rows[0] ?? null,
    };
  });
}

const BODY_HELP = '{ sku: string, qty: integer > 0, amount: number > 0, simulateFail?: "payment" | "shipping" }';

// POST /orders (sync)
ordersRouter.post('/', async (req, res, next) => {
  const order = parseOrder(req.body, false);
  if (!order) {
    res.status(400).json({ error: `Body must be ${BODY_HELP}` });
    return;
  }
  try {
    const tenant = requireTenant(req);
    const orderId = await createOrder(tenant.id, order);
    const status = await processOrder({ tenantId: tenant.id, orderId });
    res.status(status === 'completed' ? 201 : 422).json(await getOrderDetails(tenant.id, orderId));
  } catch (err) {
    next(err);
  }
});

// POST /orders/async (queued). Also allows simulateCrash: "afterReserve".
ordersRouter.post('/async', async (req, res, next) => {
  const order = parseOrder(req.body, true);
  if (!order) {
    res.status(400).json({ error: `Body must be ${BODY_HELP} (+ simulateCrash?: "afterReserve")` });
    return;
  }
  try {
    const tenant = requireTenant(req);
    const orderId = await createOrder(tenant.id, order);
    await getRuntime().queue.enqueue({ tenantId: tenant.id, orderId });
    res.status(202).json({ orderId, status: 'pending', check: `/orders/${orderId}` });
  } catch (err) {
    next(err);
  }
});

// GET /orders/:id
ordersRouter.get('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid order id' });
    return;
  }
  try {
    const details = await getOrderDetails(requireTenant(req).id, id);
    if (!details) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json(details);
  } catch (err) {
    next(err);
  }
});
