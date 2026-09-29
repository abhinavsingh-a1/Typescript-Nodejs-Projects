// Shared helpers for the test scripts.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const BASE = process.env.BASE_URL || 'http://localhost:3000';
export const KEYS = { amina: 'demo-key-amina', berlin: 'demo-key-berlin', tiny: 'demo-key-tiny' } as const;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- PASS / FAIL ----------
let failed = false;

export function check(name: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failed = true;
}

export function fail(message: string): void {
  console.error(`\nTest error: ${message}`);
  failed = true;
}

export function finish(): void {
  console.log(failed ? '\nSome tests FAILED.' : '\nAll tests PASSED.');
  process.exitCode = failed ? 1 : 0;
}

// ---------- HTTP ----------
export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Headers;
}

export async function api(
  path: string,
  options: { key?: string; body?: unknown; method?: string; base?: string; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.key) headers['x-api-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${options.base ?? BASE}${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, headers: res.headers };
}

/** Turns an order's step log into "reserveStock:done -> ..." */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const stepsOf = (details: any): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (details?.log ?? []).map((l: any) => `${l.step}:${l.status}`).join(' -> ');

export async function stockOf(key: string, sku: string, base?: string): Promise<number> {
  return (await api(`/inventory/${sku}`, { key, base })).body.stock;
}

const FINAL = ['completed', 'failed', 'needs_attention'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function waitForFinish(orderId: number, key: string, seconds: number, base?: string): Promise<any> {
  for (let i = 0; i < seconds; i++) {
    const { body } = await api(`/orders/${orderId}`, { key, base });
    if (FINAL.includes(body?.order?.status)) return body;
    await sleep(1000);
  }
  throw new Error(`Order ${orderId} did not finish in ${seconds}s`);
}

// ---------- Child processes ----------
const HIDE = new Set(['level', 'time', 'pid', 'hostname', 'service', 'instance', 'msg', 'mode', 'req', 'res']);

export interface LogEntry {
  msg?: string;
  [key: string]: unknown;
}

/** Starts src/<file> with tsx + JSON logs. onLog gets every log line as an object. */
export function spawnService(
  file: string,
  opts: { label: string; env?: Record<string, string>; onLog?: (entry: LogEntry) => void },
): ChildProcess {
  const path = fileURLToPath(new URL(`../src/${file}`, import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', path], {
    env: { ...process.env, ...opts.env, LOG_FORMAT: 'json' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const handle = (line: string) => {
    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch {
      console.log(`   ${opts.label} | ${line}`);
      return;
    }
    const extra = Object.entries(entry)
      .filter(([k]) => !HIDE.has(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ');
    console.log(`   ${opts.label} | ${entry.msg ?? ''}${extra ? `  (${extra})` : ''}`);
    opts.onLog?.(entry);
  };
  if (child.stdout) createInterface({ input: child.stdout }).on('line', handle);
  if (child.stderr) createInterface({ input: child.stderr }).on('line', handle);
  return child;
}

/** Stops children and waits until they are gone. */
export async function stopAll(children: ChildProcess[]): Promise<void> {
  await Promise.all(
    children.map((c) =>
      c.exitCode !== null || c.signalCode !== null
        ? null
        : new Promise((resolve) => {
            c.once('exit', resolve);
            c.kill();
          }),
    ),
  );
}

/** Waits until a child process exits. Returns its exit code. */
export function waitForExit(child: ChildProcess, seconds: number): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit in ${seconds}s`)), seconds * 1000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
