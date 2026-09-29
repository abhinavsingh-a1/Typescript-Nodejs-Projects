// Plugin workflows (like n8n nodes).
//   GET  /plugins        -> list available node types
//   POST /workflows/run  -> { nodes: [{ type, params }], input: {...} }
import { Router } from 'express';
import { listPlugins } from '../plugins/registry.js';
import { WorkflowRunError, WorkflowValidationError, runWorkflow } from '../plugins/runWorkflow.js';
import { requireTenant } from '../tenants.js';

export const pluginsRouter = Router();
export const workflowsRouter = Router();

pluginsRouter.get('/', (req, res) => {
  res.json(listPlugins());
});

workflowsRouter.post('/run', async (req, res, next) => {
  const { nodes, input } = (req.body ?? {}) as { nodes?: unknown; input?: unknown };
  try {
    const tenant = requireTenant(req);
    const result = await runWorkflow(nodes, input, { tenantId: tenant.id, log: req.log });
    res.json(result);
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      res.status(400).json({ error: err.message });
    } else if (err instanceof WorkflowRunError) {
      res.status(422).json({ error: err.message, failedNode: err.failedNode, steps: err.steps });
    } else {
      next(err);
    }
  }
});
