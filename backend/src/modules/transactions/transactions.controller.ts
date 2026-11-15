import { Request, Response, NextFunction } from 'express';
import { TransactionsService } from './transactions.service';
import {
  createTransactionSchema,
  createTransferSchema,
  updateTransactionSchema,
  reverseTransactionSchema,
} from './transactions.validators';
import { ResponseUtil } from '../../utils/response';
import { getUuidPathParam } from '../../utils/request';

export class TransactionsController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = createTransactionSchema.parse(req.body);
      const result = await TransactionsService.createTransaction(
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

  static async createTransfer(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = createTransferSchema.parse(req.body);
      const result = await TransactionsService.createTransfer(
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
      const filters = {
        from_date: req.query.from_date as string,
        to_date: req.query.to_date as string,
        account_id: req.query.account_id as string,
        category_id: req.query.category_id as string,
        cash_direction: req.query.cash_direction as string,
        record_status: req.query.record_status as string,
        page_size: req.query.page_size ? parseInt(req.query.page_size as string, 10) : undefined,
      };
      const transactions = await TransactionsService.listTransactions(req.business!.id, filters);
      return ResponseUtil.sendSuccess(res, transactions, 200, {
        next_cursor: null,
        page_size: filters.page_size || 50,
      });
    } catch (err) {
      return next(err);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const tx = await TransactionsService.getTransaction(req.business!.id, getUuidPathParam(req, 'transactionId'));
      return ResponseUtil.sendSuccess(res, tx, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = updateTransactionSchema.parse(req.body);
      const updated = await TransactionsService.updateTransaction(
        req.business!.id,
        getUuidPathParam(req, 'transactionId'),
        req.user!.id,
        validated,
        req.id
      );
      return ResponseUtil.sendSuccess(res, updated, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async reverse(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = reverseTransactionSchema.parse(req.body);
      const result = await TransactionsService.reverseTransaction(
        req.business!.id,
        getUuidPathParam(req, 'transactionId'),
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
