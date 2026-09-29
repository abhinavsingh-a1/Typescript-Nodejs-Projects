// Scenario 1: the same payment event must be processed only ONCE.
// Needs: API running (npm start).
import { api, check, fail, finish } from './helpers.js';

const pay = (eventId: string) => api('/webhooks/payment', { body: { eventId, orderId: 'order_1', amount: 500 } });
const countPayments = async (eventId: string) => (await api(`/payments?eventId=${encodeURIComponent(eventId)}`)).body.length;

try {
  const id1 = `evt_${Date.now()}`;
  const first = await pay(id1);
  check('First request is processed (201)', first.status === 201 && first.body.status === 'processed', first.body);

  const second = await pay(id1);
  check('Same event again is a duplicate (200)', second.status === 200 && second.body.status === 'duplicate', second.body);
  check('Only 1 payment in database', (await countPayments(id1)) === 1);

  const id2 = `evt_${Date.now()}_parallel`;
  const results = await Promise.all(Array.from({ length: 5 }, () => pay(id2)));
  const processed = results.filter((r) => r.body.status === 'processed').length;
  const duplicates = results.filter((r) => r.body.status === 'duplicate').length;
  check('5 parallel requests -> 1 processed, 4 duplicates', processed === 1 && duplicates === 4, { processed, duplicates });
  check('Only 1 payment in database', (await countPayments(id2)) === 1);
} catch (err) {
  fail(`${(err as Error).message}\nIs the API running? (npm start)`);
}
finish();
