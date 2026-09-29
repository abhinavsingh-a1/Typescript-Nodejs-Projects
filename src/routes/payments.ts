// Read payments, to verify results.
import { Router } from 'express';
import { pool } from '../db.js';

export const paymentsRouter = Router();

// GET /payments            -> last 50 payments
// GET /payments?eventId=X  -> payments for one event (should be max 1)
paymentsRouter.get('/', async (req, res, next) => {
  try {
    const eventId = req.query.eventId;
    const result = eventId
      ? await pool.query('SELECT * FROM payments WHERE event_id = $1 ORDER BY id', [String(eventId)])
      : await pool.query('SELECT * FROM payments ORDER BY id DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});
