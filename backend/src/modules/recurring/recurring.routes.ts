import { Router, Request, Response, NextFunction } from 'express';
import {
  RecurringService,
  createRecurringItemSchema,
  updateOccurrenceSchema,
} from './recurring.service';
import { authMiddleware } from '../../middleware/auth';
import { tenantIsolationMiddleware } from '../../middleware/tenant';
import { ResponseUtil } from '../../utils/response';
import { idempotencyMiddleware } from '../../middleware/idempotency';
import { z } from 'zod';
import { getUuidPathParam } from '../../utils/request';

const router = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(tenantIsolationMiddleware());

// Recurring Items
router.post('/recurring-items', idempotencyMiddleware(false), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = createRecurringItemSchema.parse(req.body);
    const item = await RecurringService.createItem(req.business!.id, req.user!.id, validated, req.id);
    return ResponseUtil.sendSuccess(res, item, 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/recurring-items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const direction = req.query.direction as string | undefined;
    const items = await RecurringService.listItems(req.business!.id, direction);
    return ResponseUtil.sendSuccess(res, items, 200);
  } catch (err) {
    return next(err);
  }
});

// Occurrences
router.get('/recurring-occurrences', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const fromDate = req.query.from_date as string | undefined;
    const toDate = req.query.to_date as string | undefined;
    const occs = await RecurringService.listOccurrences(req.business!.id, fromDate, toDate);
    return ResponseUtil.sendSuccess(res, occs, 200);
  } catch (err) {
    return next(err);
  }
});

router.patch('/recurring-occurrences/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = updateOccurrenceSchema.parse(req.body);
    const occ = await RecurringService.updateOccurrence(
      req.business!.id,
      getUuidPathParam(req, 'id'),
      req.user!.id,
      validated,
      req.id
    );
    return ResponseUtil.sendSuccess(res, occ, 200);
  } catch (err) {
    return next(err);
  }
});

router.post('/recurring-occurrences/:id/reconcile', idempotencyMiddleware(false), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({ actual_transaction_id: z.string().uuid() });
    const validated = schema.parse(req.body);
    const occ = await RecurringService.reconcileOccurrence(
      req.business!.id,
      getUuidPathParam(req, 'id'),
      validated.actual_transaction_id,
      req.user!.id,
      req.id
    );
    return ResponseUtil.sendSuccess(res, occ, 200);
  } catch (err) {
    return next(err);
  }
});

export default router;
