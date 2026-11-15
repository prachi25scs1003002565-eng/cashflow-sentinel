import { Request, Response, NextFunction } from 'express';
import { AccountsService } from './accounts.service';
import { createAccountSchema, createBalanceSnapshotSchema } from './accounts.validators';
import { ResponseUtil } from '../../utils/response';
import { getUuidPathParam } from '../../utils/request';

export class AccountsController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = createAccountSchema.parse(req.body);
      const result = await AccountsService.createAccount(
        req.business!.id,
        req.user!.id,
        validated,
        req.id
      );
      return ResponseUtil.sendSuccess(res, result, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const isActive = req.query.is_active !== undefined ? req.query.is_active === 'true' : undefined;
      const accounts = await AccountsService.listAccounts(req.business!.id, isActive);
      return ResponseUtil.sendSuccess(res, accounts, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async createSnapshot(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = createBalanceSnapshotSchema.parse(req.body);
      const snapshot = await AccountsService.createBalanceSnapshot(
        req.business!.id,
        getUuidPathParam(req, 'accountId'),
        req.user!.id,
        validated,
        req.id
      );
      return ResponseUtil.sendSuccess(res, snapshot, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async getBalances(req: Request, res: Response, next: NextFunction) {
    try {
      const asOfAt = req.query.as_of_at as string | undefined;
      const balances = await AccountsService.getBalances(req.business!.id, asOfAt);
      return ResponseUtil.sendSuccess(res, balances, 200);
    } catch (err) {
      return next(err);
    }
  }
}
