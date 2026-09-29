// Live updates over WebSocket, isolated per clinic. Needs: API running.
import { WebSocket } from 'ws';
import { BASE, KEYS, api, check, fail, finish, sleep } from './helpers.js';

const WS_BASE = BASE.replace(/^http/, 'ws');

interface Listener {
  ws: WebSocket;
  events: { type: string; orderId?: number; step?: string; status?: string }[];
}

function listen(apiKey: string): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/live?apiKey=${apiKey}`);
    const listener: Listener = { ws, events: [] };
    const timer = setTimeout(() => reject(new Error('WebSocket did not connect')), 5000);
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === 'connected') {
        clearTimeout(timer);
        resolve(listener);
      } else listener.events.push(event);
    });
    ws.on('error', reject);
  });
}

function closeCode(apiKey: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/live?apiKey=${apiKey}`);
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
}

try {
  check('Invalid key is rejected (4001)', (await closeCode('wrong-key')) === 4001);

  const amina = await listen(KEYS.amina);
  const berlin = await listen(KEYS.berlin);
  check('Amina and Berlin connected', true);

  const order = await api('/orders', { key: KEYS.amina, body: { sku: 'xray-scan', qty: 1, amount: 5 } });
  const orderId: number = order.body.order.id;
  await sleep(1500); // let events arrive

  const mine = amina.events.filter((e) => e.orderId === orderId);
  const summary = mine.map((e) => (e.type === 'order.step' ? `${e.step}:${e.status}` : `status:${e.status}`)).join(' -> ');
  check(
    'Amina sees live progress',
    summary === 'status:processing -> reserveStock:done -> chargePayment:done -> createShipment:done -> status:completed',
    summary,
  );
  check('Berlin sees nothing of Amina\'s order', berlin.events.every((e) => e.orderId !== orderId), berlin.events);

  amina.ws.close();
  berlin.ws.close();
} catch (err) {
  fail(`${(err as Error).message}\nIs the API running? (npm start)`);
}
finish();
