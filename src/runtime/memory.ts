// MODE=single: everything lives inside ONE process. No Redis needed.
// Good for small installs, laptops, self-hosting.
// Durability still comes from Postgres (saga_log + recovery on startup).
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type {
  Counter,
  EventBus,
  JobHandler,
  JobQueue,
  Lock,
  OrderEvent,
  OrderJob,
  Runtime,
} from '../types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_ATTEMPTS = 3;

/** Simple in-process queue: one job at a time, retries on errors. */
class MemoryQueue implements JobQueue {
  private waiting: OrderJob[] = [];
  private known = new Set<string>(); // waiting or active -> never queued twice
  private handler?: JobHandler;
  private log?: Logger;
  private running = false;
  private stats = { active: 0, completed: 0, failed: 0 };

  async enqueue(job: OrderJob): Promise<void> {
    const id = `${job.tenantId}:${job.orderId}`;
    if (this.known.has(id)) return;
    this.known.add(id);
    this.waiting.push(job);
    setImmediate(() => void this.drain()); // start AFTER the HTTP response is sent
  }

  startWorker(handler: JobHandler, log: Logger): void {
    this.handler = handler;
    this.log = log;
    setImmediate(() => void this.drain());
  }

  private async drain(): Promise<void> {
    const handler = this.handler;
    const log = this.log;
    if (this.running || !handler || !log) return;
    this.running = true;
    try {
      while (this.waiting.length > 0) {
        const job = this.waiting.shift() as OrderJob;
        const jobLog = log.child({ tenantId: job.tenantId, orderId: job.orderId });
        this.stats.active = 1;

        let ok = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
          try {
            jobLog.info('picked order');
            const status = await handler(job, jobLog);
            jobLog.info({ status }, 'order finished');
            ok = true;
          } catch (err) {
            jobLog.error({ err: err instanceof Error ? err.message : String(err), attempt }, 'order error');
            if (attempt < MAX_ATTEMPTS) await sleep(1000 * attempt);
          }
        }

        this.stats.active = 0;
        if (ok) this.stats.completed++;
        else this.stats.failed++;
        this.known.delete(`${job.tenantId}:${job.orderId}`);
      }
    } finally {
      this.running = false;
    }
  }

  async counts(): Promise<Record<string, number>> {
    return { waiting: this.waiting.length, ...this.stats };
  }

  async close(): Promise<void> {
    this.waiting = [];
  }
}

class MemoryBus implements EventBus {
  private emitter = new EventEmitter();

  async publish(event: OrderEvent): Promise<void> {
    this.emitter.emit('event', event);
  }

  async subscribe(handler: (event: OrderEvent) => void): Promise<void> {
    this.emitter.on('event', handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

/** Only one process exists, so a simple in-memory map is enough. */
class MemoryLock implements Lock {
  private locks = new Map<string, number>(); // key -> expires at

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    for (const [k, expires] of this.locks) if (expires <= now) this.locks.delete(k);
    if (this.locks.has(key)) return false;
    this.locks.set(key, now + ttlMs);
    return true;
  }
}

class MemoryCounter implements Counter {
  private counts = new Map<string, { n: number; expires: number }>();

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    if (this.counts.size > 1000) {
      for (const [k, v] of this.counts) if (v.expires <= now) this.counts.delete(k);
    }
    let entry = this.counts.get(key);
    if (!entry || entry.expires <= now) {
      entry = { n: 0, expires: now + ttlSeconds * 1000 };
      this.counts.set(key, entry);
    }
    entry.n++;
    return entry.n;
  }
}

export function createMemoryRuntime(): Runtime {
  const queue = new MemoryQueue();
  const bus = new MemoryBus();
  return {
    mode: 'single',
    queue,
    bus,
    lock: new MemoryLock(),
    counter: new MemoryCounter(),
    async close() {
      await queue.close();
      await bus.close();
    },
  };
}
