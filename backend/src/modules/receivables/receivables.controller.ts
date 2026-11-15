import { Request, Response, NextFunction } from 'express';
import { ReceivablesService } from './receivables.service';
import {
  createCustomerSchema,
  createSalesInvoiceSchema,
  issueInvoiceSchema,
  updateReceivableSchema,
  allocateReceivableSchema,
  recordReceivablePaymentSchema,
} from './receivables.validators';
import { ResponseUtil } from '../../utils/response';
import { getUuidPathParam } from '../../utils/request';

export class ReceivablesController {
  // Customers
  static async createCustomer(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = createCustomerSchema.parse(req.body);
      const customer = await ReceivablesService.createCustomer(req.business!.id, validated);
      return ResponseUtil.sendSuccess(res, customer, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async listCustomers(req: Request, res: Response, next: NextFunction) {
    try {
      const customers = await ReceivablesService.listCustomers(req.business!.id);
      return ResponseUtil.sendSuccess(res, customers, 200);
    } catch (err) {
      return next(err);
    }
  }

  // Invoices
  static async createInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = createSalesInvoiceSchema.parse(req.body);
      const invoice = await ReceivablesService.createInvoice(req.business!.id, req.user!.id, validated);
      return ResponseUtil.sendSuccess(res, invoice, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async listInvoices(req: Request, res: Response, next: NextFunction) {
    try {
      const filters = {
        customer_id: req.query.customer_id as string,
        invoice_status: req.query.invoice_status as string,
      };
      const invoices = await ReceivablesService.listInvoices(req.business!.id, filters);
      return ResponseUtil.sendSuccess(res, invoices, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async getInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const invoice = await ReceivablesService.getInvoice(req.business!.id, getUuidPathParam(req, 'invoiceId'));
      return ResponseUtil.sendSuccess(res, invoice, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async issueInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = issueInvoiceSchema.parse(req.body);
      const result = await ReceivablesService.issueInvoice(
        req.business!.id,
        getUuidPathParam(req, 'invoiceId'),
        req.user!.id,
        validated,
        req.id
      );
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async voidInvoice(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = req.body.reason || 'Voided by user';
      const result = await ReceivablesService.voidInvoice(
        req.business!.id,
        getUuidPathParam(req, 'invoiceId'),
        req.user!.id,
        reason,
        req.id
      );
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }

  // Receivables
  static async listReceivables(req: Request, res: Response, next: NextFunction) {
    try {
      const filters = {
        collection_state: req.query.collection_state as string,
        overdue: req.query.overdue === 'true',
      };
      const receivables = await ReceivablesService.listReceivables(req.business!.id, filters);
      return ResponseUtil.sendSuccess(res, receivables, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async getReceivable(req: Request, res: Response, next: NextFunction) {
    try {
      const rec = await ReceivablesService.getReceivable(req.business!.id, getUuidPathParam(req, 'receivableId'));
      return ResponseUtil.sendSuccess(res, rec, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async updateReceivable(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = updateReceivableSchema.parse(req.body);
      const updated = await ReceivablesService.updateReceivable(
        req.business!.id,
        getUuidPathParam(req, 'receivableId'),
        req.user!.id,
        validated,
        req.id
      );
      return ResponseUtil.sendSuccess(res, updated, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async listAllocations(req: Request, res: Response, next: NextFunction) {
    try {
      const allocs = await ReceivablesService.listAllocations(req.business!.id, getUuidPathParam(req, 'receivableId'));
      return ResponseUtil.sendSuccess(res, allocs, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async allocate(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = allocateReceivableSchema.parse(req.body);
      const alloc = await ReceivablesService.allocateReceivable(
        req.business!.id,
        getUuidPathParam(req, 'receivableId'),
        req.user!.id,
        validated,
        req.id
      );
      return ResponseUtil.sendSuccess(res, alloc, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async recordPayment(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = recordReceivablePaymentSchema.parse(req.body);
      const result = await ReceivablesService.recordPayment(
        req.business!.id,
        getUuidPathParam(req, 'receivableId'),
        req.user!.id,
        validated,
        req.id
      );
      return ResponseUtil.sendSuccess(res, result, 201);
    } catch (err) {
      return next(err);
    }
  }
}
