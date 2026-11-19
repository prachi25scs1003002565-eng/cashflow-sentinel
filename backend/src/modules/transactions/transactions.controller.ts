import { Request, Response, NextFunction } from 'express';
import { TransactionsService } from './transactions.service';
import {
  createTransactionSchema,
  createTransferSchema,
  updateTransactionSchema,
  reverseTransactionSchema,
} from './transactions.validators';
import { ResponseUtil } from '../../utils/response';
import { ValidationError } from '../../utils/errors';
import { getUuidPathParam } from '../../utils/request';
import { CategoriesAndSourcesService } from '../categories/categories.service';

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

  static async summary(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await TransactionsService.getSummary(req.business!.id);
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async listCategories(req: Request, res: Response, next: NextFunction) {
    try {
      const categories = await CategoriesAndSourcesService.listCategories(req.business!.id, true);
      return ResponseUtil.sendSuccess(res, categories, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      let cashDirection = req.query.cash_direction as string | undefined;
      if (!cashDirection && req.query.type) {
        const norm = (req.query.type as string).toUpperCase();
        if (norm === 'INCOME' || norm === 'INFLOW') cashDirection = 'INFLOW';
        else if (norm === 'EXPENSE' || norm === 'OUTFLOW') cashDirection = 'OUTFLOW';
      }

      let page = 1;
      if (req.query.page !== undefined) {
        const p = Number(req.query.page);
        if (!Number.isInteger(p) || p < 1) {
          throw new ValidationError('page must be an integer greater than or equal to 1.');
        }
        page = p;
      }

      let limit = 50;
      const rawLimit = req.query.limit ?? req.query.page_size;
      if (rawLimit !== undefined) {
        const l = Number(rawLimit);
        if (!Number.isInteger(l) || l < 1 || l > 100) {
          throw new ValidationError('limit must be an integer between 1 and 100.');
        }
        limit = l;
      } else if (req.query.page !== undefined) {
        limit = 10;
      }

      const filters = {
        from_date: req.query.from_date as string | undefined,
        to_date: req.query.to_date as string | undefined,
        account_id: req.query.account_id as string | undefined,
        category_id: req.query.category_id as string | undefined,
        cash_direction: cashDirection,
        search: (req.query.search as string) || (req.query.q as string) || undefined,
        record_status: req.query.record_status as string | undefined,
        page,
        limit,
      };

      const result = await TransactionsService.listTransactions(req.business!.id, filters);

      return ResponseUtil.sendSuccess(res, result.items, 200, {
        page: result.page,
        limit: result.limit,
        page_size: result.limit,
        total_items: result.total_count,
        total_count: result.total_count,
        total_pages: result.total_pages,
        next_cursor: null,
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

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await TransactionsService.deleteTransaction(
        req.business!.id,
        getUuidPathParam(req, 'transactionId'),
        req.user!.id,
        req.id
      );
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }
}
