// Scenario 2: saga. A failing step undoes earlier steps in reverse order.
// Needs: API running (npm start).
import { KEYS, api, check, fail, finish, stepsOf, stockOf } from './helpers.js';

const key = KEYS.amina;
const place = async (body: object) => (await api('/orders', { key, body })).body;

try {
  console.log('--- Test 1: happy path ---');
  let before = await stockOf(key, 'xray-scan');
  let r = await place({ sku: 'xray-scan', qty: 1, amount: 5 });
  check('Order completed', r.order.status === 'completed', r.order.status);
  check('All 3 steps done', stepsOf(r) === 'reserveStock:done -> chargePayment:done -> createShipment:done', stepsOf(r));
  check('Slots reduced by 1', (await stockOf(key, 'xray-scan')) === before - 1);
  check('Money charged', r.charge?.status === 'charged', r.charge);
  check('Report delivered (shipment)', r.shipment !== null);

  console.log('\n--- Test 2: payment fails ---');
  before = await stockOf(key, 'xray-scan');
  r = await place({ sku: 'xray-scan', qty: 1, amount: 5, simulateFail: 'payment' });
  check('Order failed', r.order.status === 'failed', r.order.status);
  check('Slot reservation undone', stepsOf(r) === 'reserveStock:done -> chargePayment:failed -> reserveStock:compensated', stepsOf(r));
  check('Slots unchanged', (await stockOf(key, 'xray-scan')) === before);
  check('No money charged', r.charge === null, r.charge);

  console.log('\n--- Test 3: delivery fails ---');
  before = await stockOf(key, 'xray-scan');
  r = await place({ sku: 'xray-scan', qty: 1, amount: 5, simulateFail: 'shipping' });
  check('Order failed', r.order.status === 'failed', r.order.status);
  check(
    'Undo in reverse order',
    stepsOf(r) === 'reserveStock:done -> chargePayment:done -> createShipment:failed -> chargePayment:compensated -> reserveStock:compensated',
    stepsOf(r),
  );
  check('Slots unchanged', (await stockOf(key, 'xray-scan')) === before);
  check('Money refunded', r.charge?.status === 'refunded', r.charge);
  check('No delivery', r.shipment === null);

  console.log('\n--- Test 4: no capacity ---');
  before = await stockOf(key, 'ct-scan');
  r = await place({ sku: 'ct-scan', qty: 9999, amount: 5 });
  check('Order failed at first step', r.order.status === 'failed' && r.order.failed_step === 'reserveStock', r.order);
  check('Nothing to undo', stepsOf(r) === 'reserveStock:failed', stepsOf(r));
  check('Slots unchanged', (await stockOf(key, 'ct-scan')) === before);
} catch (err) {
  fail(`${(err as Error).message}\nIs the API running? (npm start)`);
}
finish();
