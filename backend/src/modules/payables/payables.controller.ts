import { Request, Response, NextFunction } from 'express';
import { PayablesService } from './payables.service';
import {
  createSupplierSchema,
  createSupplierBillSchema,
  receiveBillSchema,
  updatePayableSchema,
  allocatePayableSchema,
  recordPayablePaymentSchema,
} from './payables.validators';
import { ResponseUtil } from '../../utils/response';
import { getUuidPathParam } from '../../utils/request';

export class PayablesController {
  // Suppliers
  static async createSupplier(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = createSupplierSchema.parse(req.body);
      const supplier = await PayablesService.createSupplier(req.business!.id, validated);
      return ResponseUtil.sendSuccess(res, supplier, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async listSuppliers(req: Request, res: Response, next: NextFunction) {
    try {
      const suppliers = await PayablesService.listSuppliers(req.business!.id);
      return ResponseUtil.sendSuccess(res, suppliers, 200);
    } catch (err) {
      return next(err);
    }
  }

  // Supplier Bills
  static async createBill(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = createSupplierBillSchema.parse(req.body);
      const bill = await PayablesService.createBill(req.business!.id, req.user!.id, validated);
      return ResponseUtil.sendSuccess(res, bill, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async listBills(req: Request, res: Response, next: NextFunction) {
    try {
      const filters = {
        supplier_id: req.query.supplier_id as string,
        bill_status: req.query.bill_status as string,
      };
      const bills = await PayablesService.listBills(req.business!.id, filters);
      return ResponseUtil.sendSuccess(res, bills, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async getBill(req: Request, res: Response, next: NextFunction) {
    try {
      const bill = await PayablesService.getBill(req.business!.id, getUuidPathParam(req, 'billId'));
      return ResponseUtil.sendSuccess(res, bill, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async receiveBill(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = receiveBillSchema.parse(req.body);
      const result = await PayablesService.receiveBill(
        req.business!.id,
        getUuidPathParam(req, 'billId'),
        req.user!.id,
        validated,
        req.id
      );
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async voidBill(req: Request, res: Response, next: NextFunction) {
    try {
      const reason = req.body.reason || 'Voided by user';
      const result = await PayablesService.voidBill(
        req.business!.id,
        getUuidPathParam(req, 'billId'),
        req.user!.id,
        reason,
        req.id
      );
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }

  // Payables
  static async listPayables(req: Request, res: Response, next: NextFunction) {
    try {
      const filters = {
        payment_state: req.query.payment_state as string,
        overdue: req.query.overdue === 'true',
      };
      const payables = await PayablesService.listPayables(req.business!.id, filters);
      return ResponseUtil.sendSuccess(res, payables, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async getPayable(req: Request, res: Response, next: NextFunction) {
    try {
      const payable = await PayablesService.getPayable(req.business!.id, getUuidPathParam(req, 'payableId'));
      return ResponseUtil.sendSuccess(res, payable, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async updatePayable(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = updatePayableSchema.parse(req.body);
      const updated = await PayablesService.updatePayable(
        req.business!.id,
        getUuidPathParam(req, 'payableId'),
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
      const allocs = await PayablesService.listAllocations(req.business!.id, getUuidPathParam(req, 'payableId'));
      return ResponseUtil.sendSuccess(res, allocs, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async allocate(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = allocatePayableSchema.parse(req.body);
      const alloc = await PayablesService.allocatePayable(
        req.business!.id,
        getUuidPathParam(req, 'payableId'),
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
      const validated = recordPayablePaymentSchema.parse(req.body);
      const result = await PayablesService.recordPayment(
        req.business!.id,
        getUuidPathParam(req, 'payableId'),
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
