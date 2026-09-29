// The 3 steps of an order, each with an "undo".
// Notice: no "WHERE tenant_id = ..." in UPDATE/DELETE.
// Row-Level Security adds it automatically, so one clinic can never
// touch another clinic's data, even if we forget.
import type { OrderContext, SagaStep } from '../types.js';

export const orderSteps: SagaStep<OrderContext>[] = [
  {
    name: 'reserveStock',
    async run(ctx, db) {
      // Only succeeds if enough stock exists (atomic check + update).
      const result = await db.query(
        'UPDATE inventory SET stock = stock - $2 WHERE sku = $1 AND stock >= $2',
        [ctx.sku, ctx.qty],
      );
      if (!result.rowCount) throw new Error('Out of stock or unknown product');
    },
    async compensate(ctx, db) {
      await db.query('UPDATE inventory SET stock = stock + $2 WHERE sku = $1', [ctx.sku, ctx.qty]);
    },
  },
  {
    name: 'chargePayment',
    async run(ctx, db) {
      if (ctx.simulateFail === 'payment') throw new Error('Payment declined (simulated)');
      await db.query(
        "INSERT INTO charges (order_id, tenant_id, amount, status) VALUES ($1, $2, $3, 'charged')",
        [ctx.orderId, ctx.tenantId, ctx.amount],
      );
    },
    async compensate(ctx, db) {
      await db.query("UPDATE charges SET status = 'refunded' WHERE order_id = $1 AND status = 'charged'", [
        ctx.orderId,
      ]);
    },
  },
  {
    name: 'createShipment',
    async run(ctx, db) {
      if (ctx.simulateFail === 'shipping') throw new Error('Shipping service down (simulated)');
      await db.query('INSERT INTO shipments (order_id, tenant_id) VALUES ($1, $2)', [ctx.orderId, ctx.tenantId]);
    },
    async compensate(ctx, db) {
      await db.query('DELETE FROM shipments WHERE order_id = $1', [ctx.orderId]);
    },
  },
];
