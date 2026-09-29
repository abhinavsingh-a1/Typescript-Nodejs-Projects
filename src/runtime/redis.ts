// MODE=distributed: API, workers and schedulers are separate processes.
// They coordinate through Redis: BullMQ queue, pub/sub, locks, counters.
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { closeRedis, getRedis } from '../redis.js';
import type {
  Counter,
  EventBus,
  JobHandler,
  JobQueue,
  Lock,
  OrderEvent,
  OrderJob,
  OrderStatus,
  Runtime,
} from '../types.js';

const QUEUE_NAME = 'orders';
const CHANNEL = 'order-events';
const log = createLogger({ service: 'runtime' });

// BullMQ needs its own Redis settings (maxRetriesPerRequest: null is required).
function bullConnection() {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

class BullQueue implements JobQueue {
  private queue = new Queue<OrderJob>(QUEUE_NAME, { connection: bullConnection() });
  private worker?: Worker<OrderJob, OrderStatus>;

  async enqueue(job: OrderJob): Promise<void> {
    await this.queue.add('process-order', job, {
      jobId: `order-${job.tenantId}-${job.orderId}`, // same order is never queued twice
      attempts: 3, // retry on errors (e.g. DB briefly down)
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }

  startWorker(handler: JobHandler, workerLog: Logger): void {
    const worker = new Worker<OrderJob, OrderStatus>(
      QUEUE_NAME,
      async (job) => {
        const jobLog = workerLog.child({ tenantId: job.data.tenantId, orderId: job.data.orderId, jobId: job.id });
        jobLog.info('picked order');
        return handler(job.data, jobLog);
      },
      {
        connection: bullConnection(),
        concurrency: 1,
        lockDuration: 10000, // a job is "owned" for 10s, renewed while alive
        stalledInterval: 5000, // every 5s, check for jobs whose owner died
        maxStalledCount: 2, // give up after 2 crashes on the same job
      },
    );

    worker.on('ready', () => workerLog.info('ready'));
    worker.on('completed', (job, status) => workerLog.info({ orderId: job.data.orderId, status }, 'order finished'));
    worker.on('failed', (job, err) => workerLog.error({ orderId: job?.data.orderId, err: err.message }, 'order error'));
    worker.on('stalled', (jobId) => workerLog.warn({ jobId }, 'stalled job found (owner died) -> back to queue'));
    worker.on('error', (err) => workerLog.error({ err: err.message }, 'worker error'));
    this.worker = worker;
  }

  async counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

class RedisBus implements EventBus {
  private subscriber?: Redis;

  async publish(event: OrderEvent): Promise<void> {
    await getRedis().publish(CHANNEL, JSON.stringify(event));
  }

  async subscribe(handler: (event: OrderEvent) => void): Promise<void> {
    // A subscribing connection can't run other commands, so use a copy.
    const sub = getRedis().duplicate();
    sub.on('error', (err) => log.error({ err: err.message }, 'redis subscriber error'));
    sub.on('message', (_channel, message) => {
      try {
        handler(JSON.parse(message) as OrderEvent);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'bad live event ignored');
      }
    });
    await sub.subscribe(CHANNEL);
    this.subscriber = sub;
  }

  async close(): Promise<void> {
    this.subscriber?.disconnect();
  }
}

class RedisLock implements Lock {
  async acquire(key: string, ttlMs: number, owner: string): Promise<boolean> {
    // NX = only if Not eXists. PX = auto-delete after ttlMs.
    const result = await getRedis().set(key, owner, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }
}

class RedisCounter implements Counter {
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const redis = getRedis();
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ttlSeconds);
    return n;
  }
}

export function createRedisRuntime(): Runtime {
  // Created on first use, so e.g. the scheduler never opens a queue connection.
  let queue: BullQueue | undefined;
  let bus: RedisBus | undefined;
  return {
    mode: 'distributed',
    get queue() {
      return (queue ??= new BullQueue());
    },
    get bus() {
      return (bus ??= new RedisBus());
    },
    lock: new RedisLock(),
    counter: new RedisCounter(),
    async close() {
      await queue?.close();
      await bus?.close();
      closeRedis();
    },
  };
}
