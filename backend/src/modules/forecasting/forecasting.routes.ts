import { Router } from 'express';
import { ForecastingController } from './forecasting.controller';
import { authMiddleware } from '../../middleware/auth';
import { tenantIsolationMiddleware } from '../../middleware/tenant';
import { idempotencyMiddleware } from '../../middleware/idempotency';

const router = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(tenantIsolationMiddleware());

router.get('/forecasts/latest', ForecastingController.getLatest);
router.get('/forecasts/sufficiency', ForecastingController.checkSufficiency);
router.post('/forecasts/generate', idempotencyMiddleware(false), ForecastingController.generate);
router.post('/forecasts/simulate', ForecastingController.simulate);

export default router;
