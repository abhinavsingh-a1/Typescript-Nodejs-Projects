// Scenario 4: 3 schedulers (like 3 servers), each report slot must run ONCE per clinic.
// Needs: Docker + migrate. API NOT needed.
import 'dotenv/config';
import pg from 'pg';
import { check, fail, finish, sleep, spawnService, stopAll } from './helpers.js';

/** Runs 3 schedulers for ~10 s. Returns "slot:tenant" -> number of emails. */
async function runRound(useLock: boolean): Promise<Map<string, number>> {
  const emails = new Map<string, number>();
  let ready = 0;
  const children = ['A', 'B', 'C'].map((name) =>
    spawnService('scheduler.ts', {
      label: name,
      env: { MODE: 'distributed', REPORT_INTERVAL_SECONDS: '3', USE_LOCK: String(useLock), INSTANCE_NAME: name },
      onLog: (entry) => {
        if (entry.msg === 'ready') ready++;
        if (entry.event === 'email_sent') {
          const k = `${entry.slot}:${entry.tenant}`;
          emails.set(k, (emails.get(k) ?? 0) + 1);
        }
      },
    }),
  );

  for (let i = 0; i < 30 && ready < 3; i++) await sleep(500);
  if (ready < 3) {
    await stopAll(children);
    throw new Error(`only ${ready} of 3 schedulers started`);
  }
  await sleep(10000); // ~3 slots
  await stopAll(children);
  return emails;
}

try {
  console.log('--- Round 1: 3 servers, lock OFF (shows the problem) ---');
  const noLock = await runRound(false);
  const worst = Math.max(0, ...noLock.values());
  check(`Problem shown: same report sent up to ${worst} times`, worst > 1, `max ${worst}`);

  console.log('\n--- Round 2: 3 servers, lock ON (the fix) ---');
  const withLock = await runRound(true);
  const slots = new Set([...withLock.keys()].map((k) => k.split(':')[0]));
  check('At least 3 slots ran', slots.size >= 3, `${slots.size} slots`);
  check('Every clinic got exactly 1 email per slot', [...withLock.values()].every((c) => c === 1), Object.fromEntries(withLock));

  // Admin user bypasses RLS, so it can count all clinics' rows.
  const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM reports WHERE slot = ANY($1)', [
      [...slots].map((s) => new Date(Number(s))),
    ]);
    check('1 report row per slot per clinic', rows[0].n === withLock.size, `${rows[0].n} rows, expected ${withLock.size}`);
  } finally {
    await admin.end();
  }
} catch (err) {
  fail(`${(err as Error).message}\nIs Docker running? Did you run npm run migrate?`);
}
finish();
