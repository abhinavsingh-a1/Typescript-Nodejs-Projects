// Runs a workflow: a list of nodes. Output of one node = input of the next.
// 1) Validate ALL nodes first (fail fast, nothing runs).
// 2) Execute one by one, recording time and result of each.
import { performance } from 'node:perf_hooks';
import { pluginRuns } from '../metrics.js';
import type { Data, PluginContext } from '../types.js';
import { asObject } from './helpers.js';
import { getPlugin, listPlugins } from './registry.js';

const MAX_NODES = 20;

export interface StepReport {
  node: number;
  type: string;
  ms: number;
  ok: boolean;
  error?: string;
}

/** Bad workflow definition -> HTTP 400. */
export class WorkflowValidationError extends Error {}

/** A node failed while running -> HTTP 422. */
export class WorkflowRunError extends Error {
  failedNode: number;
  steps: StepReport[];
  constructor(message: string, failedNode: number, steps: StepReport[]) {
    super(message);
    this.failedNode = failedNode;
    this.steps = steps;
  }
}

export async function runWorkflow(
  nodes: unknown,
  input: unknown,
  ctx: PluginContext,
): Promise<{ output: Data; steps: StepReport[] }> {
  // ---- 1. Validate ----
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_NODES) {
    throw new WorkflowValidationError(`nodes must be a list of 1-${MAX_NODES} nodes`);
  }
  let data: Data;
  try {
    data = { ...asObject(input, 'input') };
  } catch (err) {
    throw new WorkflowValidationError((err as Error).message);
  }

  const prepared = nodes.map((node: unknown, i) => {
    const { type, params } = (typeof node === 'object' && node !== null ? node : {}) as { type?: unknown; params?: unknown };
    const plugin = typeof type === 'string' ? getPlugin(type) : undefined;
    if (!plugin) {
      const available = listPlugins().map((p) => p.type).join(', ');
      throw new WorkflowValidationError(`Node ${i}: unknown type "${String(type)}". Available: ${available}`);
    }
    try {
      return { plugin, params: plugin.validate(params) };
    } catch (err) {
      throw new WorkflowValidationError(`Node ${i} (${plugin.type}): ${(err as Error).message}`);
    }
  });

  // ---- 2. Execute ----
  const steps: StepReport[] = [];
  for (const [i, { plugin, params }] of prepared.entries()) {
    const start = performance.now();
    try {
      data = await plugin.execute(data, params, ctx);
      steps.push({ node: i, type: plugin.type, ms: Math.round(performance.now() - start), ok: true });
      pluginRuns.inc({ type: plugin.type, result: 'ok' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ node: i, type: plugin.type, ms: Math.round(performance.now() - start), ok: false, error: message });
      pluginRuns.inc({ type: plugin.type, result: 'error' });
      ctx.log.warn({ node: i, type: plugin.type, err: message }, 'workflow node failed');
      throw new WorkflowRunError(`Node ${i} (${plugin.type}) failed: ${message}`, i, steps);
    }
  }
  return { output: data, steps };
}
