import { Router } from 'express';
import { TransactionsController } from './transactions.controller';
import { authMiddleware } from '../../middleware/auth';
import { tenantIsolationMiddleware } from '../../middleware/tenant';
import { idempotencyMiddleware } from '../../middleware/idempotency';

const router = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(tenantIsolationMiddleware());

router.post('/transactions', idempotencyMiddleware(false), TransactionsController.create);
router.post('/transfers', idempotencyMiddleware(false), TransactionsController.createTransfer);
router.get('/transactions/summary', TransactionsController.summary);
router.get('/transactions/categories', TransactionsController.listCategories);
router.get('/transactions', TransactionsController.list);
router.get('/transactions/:transactionId', TransactionsController.getById);
router.patch('/transactions/:transactionId', TransactionsController.update);
router.delete('/transactions/:transactionId', TransactionsController.delete);
router.post('/transactions/:transactionId/reverse', idempotencyMiddleware(false), TransactionsController.reverse);

export default router;
