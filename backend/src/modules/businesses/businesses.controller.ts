import { Request, Response, NextFunction } from 'express';
import { BusinessesService } from './businesses.service';
import { createBusinessSchema, updateBusinessSchema } from './businesses.validators';
import { ResponseUtil } from '../../utils/response';
import { getUuidPathParam } from '../../utils/request';

export class BusinessesController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = createBusinessSchema.parse(req.body);
      const result = await BusinessesService.createBusiness(req.user!.id, validated, req.id);
      return ResponseUtil.sendSuccess(res, result, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const businesses = await BusinessesService.listUserBusinesses(req.user!.id);
      return ResponseUtil.sendSuccess(res, businesses, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const business = await BusinessesService.getBusinessDetails(getUuidPathParam(req, 'businessId'), req.user!.id);
      return ResponseUtil.sendSuccess(res, business, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = updateBusinessSchema.parse(req.body);
      const updated = await BusinessesService.updateBusiness(
        getUuidPathParam(req, 'businessId'),
        req.user!.id,
        validated,
        req.id
      );
      return ResponseUtil.sendSuccess(res, updated, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async listMemberships(req: Request, res: Response, next: NextFunction) {
    try {
      const memberships = await BusinessesService.listMemberships(getUuidPathParam(req, 'businessId'));
      return ResponseUtil.sendSuccess(res, memberships, 200);
    } catch (err) {
      return next(err);
    }
  }
}
