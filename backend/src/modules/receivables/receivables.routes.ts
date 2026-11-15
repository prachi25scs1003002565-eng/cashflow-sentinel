import { Router } from 'express';
import { ReceivablesController } from './receivables.controller';
import { authMiddleware } from '../../middleware/auth';
import { tenantIsolationMiddleware } from '../../middleware/tenant';
import { idempotencyMiddleware } from '../../middleware/idempotency';

const router = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(tenantIsolationMiddleware());

// Customers
router.post('/customers', ReceivablesController.createCustomer);
router.get('/customers', ReceivablesController.listCustomers);

// Sales Invoices
router.post('/sales-invoices', idempotencyMiddleware(false), ReceivablesController.createInvoice);
router.get('/sales-invoices', ReceivablesController.listInvoices);
router.get('/sales-invoices/:invoiceId', ReceivablesController.getInvoice);
router.post('/sales-invoices/:invoiceId/issue', idempotencyMiddleware(false), ReceivablesController.issueInvoice);
router.post('/sales-invoices/:invoiceId/void', ReceivablesController.voidInvoice);

// Receivables
router.get('/receivables', ReceivablesController.listReceivables);
router.get('/receivables/:receivableId', ReceivablesController.getReceivable);
router.patch('/receivables/:receivableId', ReceivablesController.updateReceivable);

// Allocations & Payments
router.get('/receivables/:receivableId/allocations', ReceivablesController.listAllocations);
router.post('/receivables/:receivableId/allocations', idempotencyMiddleware(false), ReceivablesController.allocate);
router.post('/receivables/:receivableId/payments', idempotencyMiddleware(false), ReceivablesController.recordPayment);

export default router;
