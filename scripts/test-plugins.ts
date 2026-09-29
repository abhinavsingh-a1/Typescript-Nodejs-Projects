// Plugins: workflows built from nodes (like n8n). Needs: API running.
import { BASE, KEYS, api, check, fail, finish } from './helpers.js';

const key = KEYS.amina;
const run = (nodes: unknown, input?: unknown) => api('/workflows/run', { key, body: { nodes, input } });

try {
  const list = await api('/plugins', { key });
  const types = (list.body as { type: string }[]).map((p) => p.type).sort().join(',');
  check('4 plugins available', types === 'delay,http,tbRiskMock,transform', types);

  console.log('\n--- TB screening pipeline ---');
  const r = await run(
    [
      { type: 'transform', params: { set: { clinic: 'amina' } } },
      { type: 'tbRiskMock', params: { threshold: 60 } },
      { type: 'delay', params: { ms: 50 } },
      { type: 'http', params: { url: `${BASE}/health` } },
      { type: 'transform', params: { pick: ['patientRef', 'tbRisk', 'http'] } },
    ],
    { patientRef: 'P-001', opacityScore: 0.9, coughWeeks: 6 },
  );
  check('Workflow ran (200)', r.status === 200, r.body);
  check('5 steps, all ok', r.body.steps?.length === 5 && r.body.steps.every((s: { ok: boolean }) => s.ok), r.body.steps);
  check('TB risk: 93% high', r.body.output?.tbRisk?.percent === 93 && r.body.output?.tbRisk?.level === 'high', r.body.output?.tbRisk);
  check('HTTP node called /health', r.body.output?.http?.status === 200, r.body.output?.http);
  check('pick removed other fields', r.body.output?.clinic === undefined && r.body.output?.patientRef === 'P-001');

  console.log('\n--- Validation (nothing runs) ---');
  const unknown = await run([{ type: 'sendFax' }]);
  check('Unknown node type -> 400', unknown.status === 400 && String(unknown.body.error).includes('Available'), unknown.body);
  const ssrf = await run([{ type: 'http', params: { url: 'http://169.254.169.254/latest' } }]);
  check('Blocked host (SSRF) -> 400', ssrf.status === 400 && String(ssrf.body.error).includes('not allowed'), ssrf.body);

  console.log('\n--- Runtime failure ---');
  const bad = await run([{ type: 'tbRiskMock' }], { coughWeeks: 2 });
  check('Missing input -> 422 with failed node', bad.status === 422 && bad.body.failedNode === 0, bad.body);
} catch (err) {
  fail(`${(err as Error).message}\nIs the API running? (npm start)`);
}
finish();
