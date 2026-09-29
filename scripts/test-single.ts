// MODE=single: API + worker + scheduler in ONE process, no Redis.
// Also: crash recovery by restarting. Starts its own API on port 3100.
import type { ChildProcess } from 'node:child_process';
import { KEYS, api, check, fail, finish, sleep, spawnService, stepsOf, stockOf, stopAll, waitForExit, waitForFinish } from './helpers.js';

const PORT = '3100';
const base = `http://localhost:${PORT}`;
const key = KEYS.amina;
let recovered = -1;

function startSingle(label: string): ChildProcess {
  return spawnService('server.ts', {
    label,
    env: { MODE: 'single', PORT, REPORT_INTERVAL_SECONDS: '3600' },
    onLog: (entry) => {
      if (entry.msg === 'recovered unfinished orders') recovered = Number(entry.count);
    },
  });
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await api('/health', { base })).status === 200) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('single-mode API did not start');
}

const running: ChildProcess[] = [];
try {
  console.log('--- Start in single mode ---');
  let server = startSingle('S1');
  running.push(server);
  await waitHealthy();
  const health = (await api('/health', { base })).body;
  check('Mode is single, Redis not used', health.mode === 'single' && health.redis === 'not used', health);

  console.log('\n--- Queued order, no Redis, no separate worker ---');
  let before = await stockOf(key, 'xray-scan', base);
  let job = await api('/orders/async', { key, base, body: { sku: 'xray-scan', qty: 1, amount: 5 } });
  let r = await waitForFinish(job.body.orderId, key, 20, base);
  check('Order completed in-process', r.order.status === 'completed', r.order.status);
  check('Slots reduced by 1', (await stockOf(key, 'xray-scan', base)) === before - 1);

  console.log('\n--- Whole process crashes mid-order ---');
  before = await stockOf(key, 'xray-scan', base);
  job = await api('/orders/async', { key, base, body: { sku: 'xray-scan', qty: 1, amount: 5, simulateCrash: 'afterReserve' } });
  const code = await waitForExit(server, 20);
  check('Process crashed (exit code 1)', code === 1, code);

  console.log('\n--- Restart: recovery finds the unfinished order ---');
  recovered = -1;
  server = startSingle('S2');
  running.push(server);
  await waitHealthy();
  r = await waitForFinish(job.body.orderId, key, 20, base);
  check('Recovery found unfinished orders', recovered >= 1, recovered);
  check('Order completed after restart', r.order.status === 'completed', r.order.status);
  check('Each step done exactly once', stepsOf(r) === 'reserveStock:done -> chargePayment:done -> createShipment:done', stepsOf(r));
  check('Slots reduced by 1 (not 2)', (await stockOf(key, 'xray-scan', base)) === before - 1);
} catch (err) {
  fail((err as Error).message);
} finally {
  await stopAll(running);
}
finish();
