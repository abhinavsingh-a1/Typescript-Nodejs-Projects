// Durable saga runner.
// - Runs steps in order; on failure, undoes finished steps in REVERSE.
// - Progress is saved in saga_log, so a restarted run RESUMES
//   from the last finished step (crash recovery).
// - Step work + its log line are saved in ONE transaction:
//   both happen, or neither. No half-done steps.
// - Every transaction is tenant-scoped (Row-Level Security).
import { withTenant } from '../db.js';
import type { Db, OrderStatus, SagaResult, SagaStep, StepLogStatus } from '../types.js';

function isAlreadyDone(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e?.constraint === 'saga_log_once';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface RunSagaOptions<Ctx> {
  tenantId: string;
  sagaId: number;
  steps: SagaStep<Ctx>[];
  ctx: Ctx;
  /** Called after a step is really done by THIS run (not when skipped). */
  afterStep?: (stepName: string, ctx: Ctx) => Promise<void>;
  /** Called for every new log line (used for live updates). */
  onLog?: (stepName: string, status: StepLogStatus) => Promise<void>;
}

export async function runSaga<Ctx>(options: RunSagaOptions<Ctx>): Promise<SagaResult> {
  const { tenantId, sagaId, steps, ctx, afterStep, onLog } = options;

  // Live updates are "nice to have": never let them break the saga.
  const emit = async (step: string, status: StepLogStatus) => {
    try {
      await onLog?.(step, status);
    } catch {
      /* ignore */
    }
  };

  // Do a step exactly once. Returns true if WE did it,
  // false if it was already done (e.g. by another worker).
  async function doOnce(stepName: string, status: StepLogStatus, work: (db: Db) => Promise<void>): Promise<boolean> {
    try {
      await withTenant(tenantId, async (db) => {
        // Claim the step first. Unique index blocks a second claim.
        await db.query('INSERT INTO saga_log (tenant_id, order_id, step, status) VALUES ($1, $2, $3, $4)', [
          tenantId,
          sagaId,
          stepName,
          status,
        ]);
        await work(db);
      });
      return true;
    } catch (err) {
      if (isAlreadyDone(err)) return false;
      throw err;
    }
  }

  // Write a log line, ignore if it already exists.
  async function logOnce(stepName: string, status: StepLogStatus, error: string): Promise<void> {
    await withTenant(tenantId, (db) =>
      db.query(
        `INSERT INTO saga_log (tenant_id, order_id, step, status, error) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (order_id, step, status) DO NOTHING`,
        [tenantId, sagaId, stepName, status, error],
      ),
    );
  }

  async function loadLog(): Promise<(step: string, status: StepLogStatus) => boolean> {
    const rows = await withTenant(tenantId, async (db) => {
      const result = await db.query<{ step: string; status: StepLogStatus }>(
        'SELECT step, status FROM saga_log WHERE order_id = $1',
        [sagaId],
      );
      return result.rows;
    });
    return (step, status) => rows.some((r) => r.step === step && r.status === status);
  }

  let has = await loadLog();
  let failedStep: string | undefined = steps.find((s) => has(s.name, 'failed'))?.name;

  // ---- Forward: do steps (skip the ones already done) ----
  if (!failedStep) {
    for (const step of steps) {
      if (has(step.name, 'done')) continue; // resume point

      let didIt: boolean;
      try {
        didIt = await doOnce(step.name, 'done', (db) => step.run(ctx, db));
      } catch (err) {
        await logOnce(step.name, 'failed', messageOf(err));
        await emit(step.name, 'failed');
        failedStep = step.name;
        break;
      }
      if (didIt) {
        await emit(step.name, 'done');
        if (afterStep) await afterStep(step.name, ctx);
      }
    }
    if (!failedStep) return { ok: true };
  }

  // ---- Backward: undo done steps in reverse (skip already undone) ----
  has = await loadLog();
  let compensationFailed = false;

  const doneSteps = steps.filter((s) => has(s.name, 'done')).reverse();
  for (const step of doneSteps) {
    if (has(step.name, 'compensated')) continue;
    try {
      const didIt = await doOnce(step.name, 'compensated', (db) => step.compensate(ctx, db));
      if (didIt) await emit(step.name, 'compensated');
    } catch (err) {
      compensationFailed = true;
      await logOnce(step.name, 'compensation_failed', messageOf(err)).catch(() => {});
      await emit(step.name, 'compensation_failed');
    }
  }

  return { ok: false, failedStep, compensationFailed };
}

/** Maps a saga result to the final order status. */
export function finalStatus(result: SagaResult): OrderStatus {
  if (result.ok) return 'completed';
  return result.compensationFailed ? 'needs_attention' : 'failed';
}
