// Shared CONTRACTS for the whole app.
// If code breaks one of these rules, `npm run typecheck` fails.
import type { PoolClient } from 'pg';
import type { Logger } from 'pino';

// ---------- Runtime mode ----------
/** single = one process, no Redis. distributed = many processes + Redis. */
export type Mode = 'single' | 'distributed';

// ---------- Tenants ----------
/** A customer (clinic). Every order belongs to exactly one tenant. */
export interface Tenant {
  id: string;
  displayName: string;
  rateLimitPerMinute: number;
}

// ---------- Orders ----------
/** All statuses an order can have. The database has the same CHECK rule. */
export type OrderStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'needs_attention';

/** Statuses where the order is finished and must not run again. */
export const FINAL_STATUSES: readonly OrderStatus[] = ['completed', 'failed', 'needs_attention'];

export function isFinalStatus(status: OrderStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

/** Values allowed in saga_log.status. */
export type StepLogStatus = 'done' | 'failed' | 'compensated' | 'compensation_failed';

/** Demo switches. */
export type SimulateFail = 'payment' | 'shipping';
export type SimulateCrash = 'afterReserve';

/** Everything a step needs to know about an order. */
export interface OrderContext {
  tenantId: string;
  orderId: number;
  sku: string;
  qty: number;
  amount: number;
  simulateFail: SimulateFail | null;
  simulateCrash: SimulateCrash | null;
}

// ---------- Saga ----------
/** Database handle given to steps (a tenant-scoped transaction). */
export type Db = Pick<PoolClient, 'query'>;

/** Contract every saga step must follow: do + undo. */
export interface SagaStep<Ctx> {
  name: string;
  run(ctx: Ctx, db: Db): Promise<void>;
  compensate(ctx: Ctx, db: Db): Promise<void>;
}

/** Result of a saga. "ok: false" always tells which step failed. */
export type SagaResult =
  | { ok: true }
  | { ok: false; failedStep: string; compensationFailed: boolean };

// ---------- Queue & events ----------
/** Data inside a queue job. Producer (API) and consumer (worker) share it. */
export interface OrderJob {
  tenantId: string;
  orderId: number;
}

/** Live events sent to browsers over WebSocket. */
export type OrderEvent =
  | { type: 'order.status'; tenantId: string; orderId: number; status: OrderStatus }
  | { type: 'order.step'; tenantId: string; orderId: number; step: string; status: StepLogStatus };

export type JobHandler = (job: OrderJob, log: Logger) => Promise<OrderStatus>;

/** A job queue. Two implementations: in-memory (single) and BullMQ (distributed). */
export interface JobQueue {
  enqueue(job: OrderJob): Promise<void>;
  startWorker(handler: JobHandler, log: Logger): void;
  counts(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

/** Publish/subscribe for live events. */
export interface EventBus {
  publish(event: OrderEvent): Promise<void>;
  subscribe(handler: (event: OrderEvent) => void): Promise<void>;
  close(): Promise<void>;
}

/** "Only one may do this" lock. Returns true if WE got it. */
export interface Lock {
  acquire(key: string, ttlMs: number, owner: string): Promise<boolean>;
}

/** Counter that resets after ttlSeconds (used for rate limits). */
export interface Counter {
  incr(key: string, ttlSeconds: number): Promise<number>;
}

/** Everything that changes between single and distributed mode. */
export interface Runtime {
  mode: Mode;
  queue: JobQueue;
  bus: EventBus;
  lock: Lock;
  counter: Counter;
  close(): Promise<void>;
}

// ---------- Plugins (workflow nodes) ----------
export type Data = Record<string, unknown>;

export interface PluginContext {
  tenantId: string;
  log: Logger;
}

/**
 * Contract for a workflow node plugin (like an n8n node).
 * validate() runs BEFORE anything executes, so bad workflows fail early.
 */
export interface NodePlugin<Params> {
  type: string;
  description: string;
  validate(params: unknown): Params;
  execute(input: Data, params: Params, ctx: PluginContext): Promise<Data>;
}

export interface WorkflowNode {
  type: string;
  params?: unknown;
}
