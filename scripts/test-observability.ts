// Observability: request IDs + Prometheus metrics. Needs: API running.
import { KEYS, api, check, fail, finish } from './helpers.js';

try {
  const fresh = await api('/health');
  check('Response has X-Request-Id', Boolean(fresh.headers.get('x-request-id')));
  const kept = await api('/health', { headers: { 'X-Request-Id': 'my-trace-123' } });
  check('Own X-Request-Id is kept', kept.headers.get('x-request-id') === 'my-trace-123', kept.headers.get('x-request-id'));

  // Some traffic so metrics have values.
  await api('/inventory/xray-scan', { key: KEYS.amina });
  await api('/webhooks/payment', { body: { eventId: `evt_obs_${Date.now()}`, orderId: 'order_obs', amount: 5 } });

  const metrics = await api('/metrics');
  const text = String(metrics.body);
  check('/metrics returns 200', metrics.status === 200, metrics.status);
  for (const name of [
    'flowlite_http_requests_total',
    'flowlite_http_request_duration_seconds',
    'flowlite_webhook_events_total{result="processed"}',
    'flowlite_orders{tenant="amina"',
    'flowlite_queue_jobs{',
    'flowlite_process_cpu_user_seconds_total',
  ]) {
    check(`metric ${name}`, text.includes(name), 'missing');
  }
  check('Route pattern used (no raw IDs)', text.includes('route="/inventory/:sku"') && !text.includes('route="/inventory/xray-scan"'));
} catch (err) {
  fail(`${(err as Error).message}\nIs the API running? (npm start)`);
}
finish();
