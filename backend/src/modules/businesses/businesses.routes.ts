import { Router } from 'express';
import { BusinessesController } from './businesses.controller';
import { authMiddleware } from '../../middleware/auth';
import { tenantIsolationMiddleware } from '../../middleware/tenant';

const router = Router();

// Global business operations
router.post('/', authMiddleware, BusinessesController.create);
router.get('/', authMiddleware, BusinessesController.list);

// Business-scoped operations
router.get('/:businessId', authMiddleware, tenantIsolationMiddleware(), BusinessesController.getById);
router.patch(
  '/:businessId',
  authMiddleware,
  tenantIsolationMiddleware(['OWNER', 'ADMIN']),
  BusinessesController.update
);
router.get(
  '/:businessId/memberships',
  authMiddleware,
  tenantIsolationMiddleware(),
  BusinessesController.listMemberships
);

export default router;
