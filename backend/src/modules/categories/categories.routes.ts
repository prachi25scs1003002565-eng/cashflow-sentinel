import { Router, Request, Response, NextFunction } from 'express';
import { CategoriesAndSourcesService, createCategorySchema } from './categories.service';
import { authMiddleware } from '../../middleware/auth';
import { tenantIsolationMiddleware } from '../../middleware/tenant';
import { ResponseUtil } from '../../utils/response';

const router = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(tenantIsolationMiddleware());

router.get('/transaction-categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isActive = req.query.is_active !== undefined ? req.query.is_active === 'true' : undefined;
    const categories = await CategoriesAndSourcesService.listCategories(req.business!.id, isActive);
    return ResponseUtil.sendSuccess(res, categories, 200);
  } catch (err) {
    return next(err);
  }
});

router.post('/transaction-categories', tenantIsolationMiddleware(['OWNER', 'ADMIN']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = createCategorySchema.parse(req.body);
    const cat = await CategoriesAndSourcesService.createCategory(
      req.business!.id,
      req.user!.id,
      validated,
      req.id
    );
    return ResponseUtil.sendSuccess(res, cat, 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/data-sources', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.source_status as string | undefined;
    const sources = await CategoriesAndSourcesService.listDataSources(req.business!.id, status);
    return ResponseUtil.sendSuccess(res, sources, 200);
  } catch (err) {
    return next(err);
  }
});

export default router;
