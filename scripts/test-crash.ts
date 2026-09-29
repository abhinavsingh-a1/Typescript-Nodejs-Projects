// Scenario 3: a worker crashes mid-order; another worker finishes it.
// Needs: API running (npm start, MODE=distributed). Starts 2 workers itself.
import type { ChildProcess } from 'node:child_process';
import { KEYS, api, check, fail, finish, sleep, spawnService, stepsOf, stockOf, stopAll, waitForFinish } from './helpers.js';

const key = KEYS.amina;
const workers: ChildProcess[] = [];
let crashed = 0;
let ready = 0;

function startWorker(label: string): void {
  const child = spawnService('worker.ts', {
    label,
    env: { INSTANCE_NAME: label },
    onLog: (entry) => {
      if (entry.msg === 'ready') ready++;
    },
  });
  child.on('exit', (code) => {
    if (code === 1) crashed++;
  });
  workers.push(child);
}

try {
  const health = await api('/health');
  if (health.body.mode !== 'distributed') throw new Error('API must run with MODE=distributed');

  console.log('Starting 2 workers...');
  startWorker('A');
  startWorker('B');
  for (let i = 0; i < 30 && ready < 2; i++) await sleep(500);
  check('2 workers ready', ready === 2, `${ready} ready`);

  console.log('\n--- Test 1: order via queue ---');
  let before = await stockOf(key, 'xray-scan');
  let job = await api('/orders/async', { key, body: { sku: 'xray-scan', qty: 1, amount: 5 } });
  let r = await waitForFinish(job.body.orderId, key, 20);
  check('Order completed by a worker', r.order.status === 'completed', r.order.status);
  check('Slots reduced by 1', (await stockOf(key, 'xray-scan')) === before - 1);

  console.log('\n--- Test 2: worker crashes mid-order ---');
  console.log('   (recovery takes ~10-15 seconds, please wait)');
  before = await stockOf(key, 'xray-scan');
  job = await api('/orders/async', { key, body: { sku: 'xray-scan', qty: 1, amount: 5, simulateCrash: 'afterReserve' } });
  r = await waitForFinish(job.body.orderId, key, 60);
  check('One worker crashed', crashed === 1, `${crashed} crashed`);
  check('Order still completed', r.order.status === 'completed', r.order.status);
  check('Resumed: each step done exactly once', stepsOf(r) === 'reserveStock:done -> chargePayment:done -> createShipment:done', stepsOf(r));
  check('Slots reduced by 1 (not 2)', (await stockOf(key, 'xray-scan')) === before - 1);
  check('Money charged once', r.charge?.status === 'charged', r.charge);
  check('Report delivered', r.shipment !== null);
} catch (err) {
  fail(`${(err as Error).message}\nIs the API running? (npm start)`);
} finally {
  await stopAll(workers);
}
finish();
