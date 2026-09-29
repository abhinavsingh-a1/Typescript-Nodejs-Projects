// Multi-tenancy: clinics are isolated, and one noisy clinic can't block others.
// Needs: API running (npm start).
import 'dotenv/config';
import pg from 'pg';
import { KEYS, api, check, fail, finish, stockOf } from './helpers.js';

try {
  console.log('--- Authentication ---');
  check('No API key -> 401', (await api('/inventory')).status === 401);
  check('Wrong API key -> 401', (await api('/inventory', { key: 'wrong' })).status === 401);
  const me = await api('/tenants/me', { key: KEYS.amina });
  check('Key identifies the clinic', me.body.id === 'amina' && me.body.displayName === 'Dr. Amina Clinic', me.body);

  console.log('\n--- Data isolation ---');
  const aminaBefore = await stockOf(KEYS.amina, 'xray-scan');
  const berlinBefore = await stockOf(KEYS.berlin, 'xray-scan');
  const order = await api('/orders', { key: KEYS.amina, body: { sku: 'xray-scan', qty: 1, amount: 5 } });
  check('Amina places an order', order.status === 201, order.body);
  check("Amina's slots -1", (await stockOf(KEYS.amina, 'xray-scan')) === aminaBefore - 1);
  check("Berlin's slots unchanged", (await stockOf(KEYS.berlin, 'xray-scan')) === berlinBefore);

  const orderId = order.body.order.id;
  check('Berlin cannot see Amina\'s order (404)', (await api(`/orders/${orderId}`, { key: KEYS.berlin })).status === 404);
  check('Amina can see her order (200)', (await api(`/orders/${orderId}`, { key: KEYS.amina })).status === 200);

  console.log('\n--- Database-level proof (Row-Level Security) ---');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const noTenant = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM orders');
    check('App DB user without tenant sees 0 orders', noTenant.rows[0].n === 0, noTenant.rows[0]);

    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', 'amina', true)");
    const other = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE tenant_id <> 'amina'");
    const own = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM orders');
    await db.query('COMMIT');
    check('As Amina: sees only Amina rows', other.rows[0].n === 0 && own.rows[0].n > 0, { own: own.rows[0], other: other.rows[0] });
  } finally {
    await db.end();
  }

  console.log('\n--- Noisy neighbour (rate limit) ---');
  const burst = await Promise.all(Array.from({ length: 8 }, () => api('/inventory', { key: KEYS.tiny })));
  const ok = burst.filter((r) => r.status === 200).length;
  const limited = burst.filter((r) => r.status === 429).length;
  // Limit is 5 per minute, so at least 3 of 8 must be rejected (all 8 if you re-run within the same minute).
  check('Tiny clinic (limit 5/min) gets 429s', limited >= 3 && ok <= 5 && ok + limited === 8, { ok, limited });
  const limitedResponse = burst.find((r) => r.status === 429);
  check('429 has Retry-After header', Boolean(limitedResponse?.headers.get('retry-after')));
  check('Amina is NOT affected', (await api('/inventory', { key: KEYS.amina })).status === 200);
} catch (err) {
  fail(`${(err as Error).message}\nIs the API running? (npm start)`);
}
finish();
