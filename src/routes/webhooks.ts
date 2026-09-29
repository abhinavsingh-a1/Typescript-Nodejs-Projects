// Scenario 1: Idempotency.
// The payment provider may send the SAME event more than once.
// We must create the payment only ONCE.
// (Provider-level endpoint: no tenant API key; event IDs are globally unique.)
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { webhookEvents } from '../metrics.js';

export const webhooksRouter = Router();

webhooksRouter.post('/payment', async (req, res, next) => {
  const { eventId, orderId, amount } = (req.body ?? {}) as Record<string, unknown>;

  // 1. Validate input.
  const valid =
    typeof eventId === 'string' && eventId.length > 0 &&
    typeof orderId === 'string' && orderId.length > 0 &&
    typeof amount === 'number' && amount > 0;
  if (!valid) {
    res.status(400).json({ error: 'Body must be { eventId: string, orderId: string, amount: number > 0 }' });
    return;
  }

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 2. Try to save the event ID. The PRIMARY KEY blocks duplicates.
    //    "Check" and "save" happen in ONE atomic step.
    const saved = await client.query(
      `INSERT INTO processed_events (event_id) VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId],
    );

    // 3. Nothing saved = we have seen this event before.
    if (saved.rowCount === 0) {
      await client.query('ROLLBACK');
      webhookEvents.inc({ result: 'duplicate' });
      res.status(200).json({ status: 'duplicate', eventId });
      return;
    }

    // 4. New event: create the payment.
    const payment = await client.query<{ id: number }>(
      'INSERT INTO payments (event_id, order_id, amount) VALUES ($1, $2, $3) RETURNING id',
      [eventId, orderId, amount],
    );

    await client.query('COMMIT');
    webhookEvents.inc({ result: 'processed' });
    res.status(201).json({ status: 'processed', eventId, paymentId: payment.rows[0].id });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});
