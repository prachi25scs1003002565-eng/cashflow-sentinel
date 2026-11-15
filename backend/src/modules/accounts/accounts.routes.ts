import { Router } from 'express';
import { AccountsController } from './accounts.controller';
import { authMiddleware } from '../../middleware/auth';
import { tenantIsolationMiddleware } from '../../middleware/tenant';

const router = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(tenantIsolationMiddleware());

router.post('/accounts', AccountsController.create);
router.get('/accounts', AccountsController.list);
router.post('/accounts/:accountId/balance-snapshots', AccountsController.createSnapshot);
router.get('/balances', AccountsController.getBalances);

export default router;
