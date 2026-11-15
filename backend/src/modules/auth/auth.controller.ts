import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import { registerSchema, loginSchema } from './auth.validators';
import { ResponseUtil } from '../../utils/response';

export class AuthController {
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = registerSchema.parse(req.body);
      const result = await AuthService.register(validated, req.id);
      return ResponseUtil.sendSuccess(res, result, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = loginSchema.parse(req.body);
      const result = await AuthService.login(validated, req.id);
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async me(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await AuthService.getProfile(req.user!.id);
      return ResponseUtil.sendSuccess(res, user, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async logout(_req: Request, res: Response) {
    // Stateless token: client discards bearer token
    return ResponseUtil.sendNoContent(res);
  }
}
