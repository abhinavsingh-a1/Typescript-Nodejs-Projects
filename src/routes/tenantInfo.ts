// GET /tenants/me -> who am I?
import { Router } from 'express';
import { requireTenant } from '../tenants.js';

export const tenantInfoRouter = Router();

tenantInfoRouter.get('/me', (req, res) => {
  res.json(requireTenant(req));
});
