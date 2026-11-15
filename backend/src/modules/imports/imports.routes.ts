import { Router } from 'express';
import multer from 'multer';
import { ImportsController } from './imports.controller';
import { authMiddleware } from '../../middleware/auth';
import { tenantIsolationMiddleware } from '../../middleware/tenant';
import { idempotencyMiddleware } from '../../middleware/idempotency';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MiB limit
  },
});

const router = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(tenantIsolationMiddleware());

router.post('/imports', upload.single('file'), idempotencyMiddleware(false), ImportsController.upload);
router.get('/imports/:importBatchId', ImportsController.getBatch);
router.get('/imports/:importBatchId/rows', ImportsController.getRows);
router.post('/imports/:importBatchId/confirm', idempotencyMiddleware(false), ImportsController.confirm);

export default router;
