// View stock levels (only YOUR clinic's rows, thanks to RLS).
import { Router } from 'express';
import { withTenant } from '../db.js';
import { requireTenant } from '../tenants.js';

export const inventoryRouter = Router();

inventoryRouter.get('/', async (req, res, next) => {
  try {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, async (db) => {
      const result = await db.query('SELECT sku, stock FROM inventory ORDER BY sku');
      return result.rows;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.get('/:sku', async (req, res, next) => {
  try {
    const tenant = requireTenant(req);
    const row = await withTenant(tenant.id, async (db) => {
      const result = await db.query('SELECT sku, stock FROM inventory WHERE sku = $1', [req.params.sku]);
      return result.rows[0];
    });
    if (!row) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});
