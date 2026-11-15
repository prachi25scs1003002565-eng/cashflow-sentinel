import { Router } from 'express';
import { PayablesController } from './payables.controller';
import { authMiddleware } from '../../middleware/auth';
import { tenantIsolationMiddleware } from '../../middleware/tenant';
import { idempotencyMiddleware } from '../../middleware/idempotency';

const router = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(tenantIsolationMiddleware());

// Suppliers
router.post('/suppliers', PayablesController.createSupplier);
router.get('/suppliers', PayablesController.listSuppliers);

// Supplier Bills
router.post('/supplier-bills', idempotencyMiddleware(false), PayablesController.createBill);
router.get('/supplier-bills', PayablesController.listBills);
router.get('/supplier-bills/:billId', PayablesController.getBill);
router.post('/supplier-bills/:billId/receive', idempotencyMiddleware(false), PayablesController.receiveBill);
router.post('/supplier-bills/:billId/void', PayablesController.voidBill);

// Payables
router.get('/payables', PayablesController.listPayables);
router.get('/payables/:payableId', PayablesController.getPayable);
router.patch('/payables/:payableId', PayablesController.updatePayable);

// Allocations & Payments
router.get('/payables/:payableId/allocations', PayablesController.listAllocations);
router.post('/payables/:payableId/allocations', idempotencyMiddleware(false), PayablesController.allocate);
router.post('/payables/:payableId/payments', idempotencyMiddleware(false), PayablesController.recordPayment);

export default router;
