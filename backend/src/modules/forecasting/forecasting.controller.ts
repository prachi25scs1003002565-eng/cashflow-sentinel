import { Request, Response, NextFunction } from 'express';
import { ForecastingService } from './forecasting.service';
import { generateForecastSchema } from './forecasting.validators';
import { SimulationService } from './simulation.service';
import { simulationInputSchema } from './simulation.validators';
import { ResponseUtil } from '../../utils/response';

export class ForecastingController {
  static async getLatest(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await ForecastingService.getLatestForecast(
        req.business!.id,
        req.user!.id
      );
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async generate(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = generateForecastSchema.parse(req.body || {});
      const result = await ForecastingService.generateForecast(
        req.business!.id,
        req.user!.id,
        validated.horizon_days,
        validated.as_of_date,
        req.id
      );
      return ResponseUtil.sendSuccess(res, result, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async checkSufficiency(req: Request, res: Response, next: NextFunction) {
    try {
      const asOfDateStr =
        typeof req.query.as_of_date === 'string'
          ? req.query.as_of_date
          : new Date().toISOString().slice(0, 10);

      const result = await ForecastingService.checkDataSufficiency(
        req.business!.id,
        asOfDateStr
      );
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async simulate(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = simulationInputSchema.parse(req.body);
      const result = await SimulationService.simulate(
        req.business!.id,
        req.user!.id,
        validated,
        req.id
      );
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }
}
