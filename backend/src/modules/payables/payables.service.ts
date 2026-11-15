import { Database } from '../../db';
import {
  CreateSupplierInput,
  CreateSupplierBillInput,
  ReceiveBillInput,
  UpdatePayableInput,
  AllocatePayableInput,
  RecordPayablePaymentInput,
} from './payables.validators';
import { AuditLogger } from '../../middleware/audit';
import { NotFoundError, ConflictError, ValidationError } from '../../utils/errors';

export class PayablesService {
  // 1. Suppliers
  static async createSupplier(businessId: string, input: CreateSupplierInput) {
    const query = `
      INSERT INTO suppliers (business_id, display_name, external_reference, contact_hint, record_status)
      VALUES ($1, $2, $3, $4, 'ACTIVE')
      RETURNING *
    `;
    const res = await Database.query(query, [
      businessId,
      input.display_name,
      input.external_reference || null,
      input.contact_hint || null,
    ]);
    return res.rows[0];
  }

  static async listSuppliers(businessId: string) {
    const query = 'SELECT * FROM suppliers WHERE business_id = $1 ORDER BY display_name ASC';
    const res = await Database.query(query, [businessId]);
    return res.rows;
  }

  // 2. Supplier Bills
  static async createBill(businessId: string, userId: string, input: CreateSupplierBillInput) {
    if (new Date(input.due_date) < new Date(input.bill_date)) {
      throw new ValidationError('due_date cannot be earlier than bill_date.');
    }

    const query = `
      INSERT INTO supplier_bills (
        business_id, supplier_id, bill_number, bill_date, due_date, total_paise,
        bill_status, external_reference
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'DRAFT', $7)
      RETURNING *
    `;
    const res = await Database.query(query, [
      businessId,
      input.supplier_id,
      input.bill_number,
      input.bill_date,
      input.due_date,
      input.total_paise,
      input.external_reference || null,
    ]);

    const bill = res.rows[0];
    return {
      ...bill,
      total_paise: bill.total_paise.toString(),
    };
  }

  static async listBills(businessId: string, filters: { supplier_id?: string; bill_status?: string }) {
    let query = `
      SELECT sb.*, s.display_name as supplier_name, p.id as payable_id, p.expected_payment_date,
             (sb.total_paise - COALESCE(SUM(ppa.amount_paise), 0)) as outstanding_paise
      FROM supplier_bills sb
      JOIN suppliers s ON s.business_id = sb.business_id AND s.id = sb.supplier_id
      LEFT JOIN payables p ON p.business_id = sb.business_id AND p.bill_id = sb.id
      LEFT JOIN payable_payment_allocations ppa ON ppa.business_id = sb.business_id AND ppa.payable_id = p.id
      WHERE sb.business_id = $1
    `;
    const params: any[] = [businessId];
    let idx = 2;

    if (filters.supplier_id) {
      query += ` AND sb.supplier_id = $${idx++}`;
      params.push(filters.supplier_id);
    }
    if (filters.bill_status) {
      query += ` AND sb.bill_status = $${idx++}`;
      params.push(filters.bill_status);
    }

    query += `
      GROUP BY sb.id, s.display_name, p.id, p.expected_payment_date
      ORDER BY sb.due_date ASC
    `;

    const res = await Database.query(query, params);
    return res.rows.map((row) => ({
      ...row,
      total_paise: row.total_paise.toString(),
      outstanding_paise: row.outstanding_paise ? row.outstanding_paise.toString() : row.total_paise.toString(),
    }));
  }

  static async getBill(businessId: string, billId: string) {
    const query = `
      SELECT sb.*, s.display_name as supplier_name, p.id as payable_id, p.expected_payment_date,
             (sb.total_paise - COALESCE(SUM(ppa.amount_paise), 0)) as outstanding_paise
      FROM supplier_bills sb
      JOIN suppliers s ON s.business_id = sb.business_id AND s.id = sb.supplier_id
      LEFT JOIN payables p ON p.business_id = sb.business_id AND p.bill_id = sb.id
      LEFT JOIN payable_payment_allocations ppa ON ppa.business_id = sb.business_id AND ppa.payable_id = p.id
      WHERE sb.business_id = $1 AND sb.id = $2
      GROUP BY sb.id, s.display_name, p.id, p.expected_payment_date
    `;
    const res = await Database.query(query, [businessId, billId]);
    if (res.rows.length === 0) {
      throw new NotFoundError('RESOURCE_NOT_FOUND', 'Supplier bill not found.');
    }
    const row = res.rows[0];
    return {
      ...row,
      total_paise: row.total_paise.toString(),
      outstanding_paise: row.outstanding_paise ? row.outstanding_paise.toString() : row.total_paise.toString(),
    };
  }

  static async receiveBill(businessId: string, billId: string, userId: string, input: ReceiveBillInput, requestId?: string) {
    return Database.withTransaction(async (client) => {
      const billRes = await client.query(
        'SELECT * FROM supplier_bills WHERE business_id = $1 AND id = $2 FOR UPDATE',
        [businessId, billId]
      );
      if (billRes.rows.length === 0) {
        throw new NotFoundError('RESOURCE_NOT_FOUND', 'Supplier bill not found.');
      }
      const bill = billRes.rows[0];
      if (bill.bill_status !== 'DRAFT') {
        throw new ConflictError('STATE_CONFLICT', `Bill cannot be marked received from status ${bill.bill_status}`);
      }

      await client.query(
        "UPDATE supplier_bills SET bill_status = 'RECEIVED', updated_at = now() WHERE business_id = $1 AND id = $2",
        [businessId, billId]
      );

      const expDate = input.expected_payment_date || bill.due_date;
      const payRes = await client.query(
        `INSERT INTO payables (
          business_id, bill_id, expected_payment_date, expected_date_source,
          expected_certainty, payment_state
        )
        VALUES ($1, $2, $3, $4, $5, 'OPEN')
        RETURNING *`,
        [businessId, billId, expDate, input.expected_date_source, input.expected_certainty]
      );
      const payable = payRes.rows[0];

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'BILL_RECEIVED',
          entityName: 'supplier_bills',
          entityId: billId,
          requestId,
        },
        client
      );

      return {
        bill_id: billId,
        bill_status: 'RECEIVED',
        payable: {
          id: payable.id,
          expected_payment_date: payable.expected_payment_date,
          expected_date_source: payable.expected_date_source,
          expected_certainty: payable.expected_certainty,
          payment_state: payable.payment_state,
          outstanding_paise: bill.total_paise.toString(),
        },
      };
    });
  }

  static async voidBill(businessId: string, billId: string, userId: string, reason: string, requestId?: string) {
    return Database.withTransaction(async (client) => {
      const billRes = await client.query(
        'SELECT * FROM supplier_bills WHERE business_id = $1 AND id = $2 FOR UPDATE',
        [businessId, billId]
      );
      if (billRes.rows.length === 0) {
        throw new NotFoundError('RESOURCE_NOT_FOUND', 'Supplier bill not found.');
      }
      const bill = billRes.rows[0];
      if (bill.bill_status === 'VOID') {
        throw new ConflictError('STATE_CONFLICT', 'Supplier bill is already VOID.');
      }

      // Check allocations
      const allocRes = await client.query(
        `SELECT ppa.id
         FROM payable_payment_allocations ppa
         JOIN payables p ON p.business_id = ppa.business_id AND p.id = ppa.payable_id
         WHERE p.business_id = $1 AND p.bill_id = $2`,
        [businessId, billId]
      );
      if (allocRes.rows.length > 0) {
        throw new ConflictError('HAS_ALLOCATIONS', 'Cannot void a bill with active payment allocations.');
      }

      await client.query(
        "UPDATE supplier_bills SET bill_status = 'VOID', updated_at = now() WHERE business_id = $1 AND id = $2",
        [businessId, billId]
      );

      await client.query(
        "UPDATE payables SET payment_state = 'CANCELLED', updated_at = now() WHERE business_id = $1 AND bill_id = $2",
        [businessId, billId]
      );

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'BILL_VOIDED',
          entityName: 'supplier_bills',
          entityId: billId,
          requestId,
          metadata: { reason },
        },
        client
      );

      return {
        bill_id: billId,
        bill_status: 'VOID',
        payable_state: 'CANCELLED',
      };
    });
  }

  // 3. Payables & Allocations
  static async listPayables(
    businessId: string,
    filters: { payment_state?: string; overdue?: boolean }
  ) {
    let query = `
      SELECT p.*, sb.bill_number, sb.due_date, sb.total_paise, s.display_name as supplier_name,
             (sb.total_paise - COALESCE(SUM(ppa.amount_paise), 0)) as outstanding_paise
      FROM payables p
      JOIN supplier_bills sb ON sb.business_id = p.business_id AND sb.id = p.bill_id
      JOIN suppliers s ON s.business_id = sb.business_id AND s.id = sb.supplier_id
      LEFT JOIN payable_payment_allocations ppa ON ppa.business_id = p.business_id AND ppa.payable_id = p.id
      WHERE p.business_id = $1
    `;
    const params: any[] = [businessId];
    let idx = 2;

    if (filters.payment_state) {
      query += ` AND p.payment_state = $${idx++}`;
      params.push(filters.payment_state);
    }
    if (filters.overdue) {
      query += ` AND sb.due_date < CURRENT_DATE`;
    }

    query += `
      GROUP BY p.id, sb.bill_number, sb.due_date, sb.total_paise, s.display_name
      ORDER BY p.expected_payment_date ASC NULLS LAST
    `;

    const res = await Database.query(query, params);
    return res.rows.map((row) => ({
      ...row,
      total_paise: row.total_paise.toString(),
      outstanding_paise: row.outstanding_paise.toString(),
    }));
  }

  static async getPayable(businessId: string, payableId: string) {
    const query = `
      SELECT p.*, sb.bill_number, sb.due_date, sb.total_paise, s.display_name as supplier_name,
             (sb.total_paise - COALESCE(SUM(ppa.amount_paise), 0)) as outstanding_paise
      FROM payables p
      JOIN supplier_bills sb ON sb.business_id = p.business_id AND sb.id = p.bill_id
      JOIN suppliers s ON s.business_id = sb.business_id AND s.id = sb.supplier_id
      LEFT JOIN payable_payment_allocations ppa ON ppa.business_id = p.business_id AND ppa.payable_id = p.id
      WHERE p.business_id = $1 AND p.id = $2
      GROUP BY p.id, sb.bill_number, sb.due_date, sb.total_paise, s.display_name
    `;
    const res = await Database.query(query, [businessId, payableId]);
    if (res.rows.length === 0) {
      throw new NotFoundError('RESOURCE_NOT_FOUND', 'Payable not found.');
    }
    const row = res.rows[0];
    return {
      ...row,
      total_paise: row.total_paise.toString(),
      outstanding_paise: row.outstanding_paise.toString(),
    };
  }

  static async updatePayable(
    businessId: string,
    payableId: string,
    userId: string,
    input: UpdatePayableInput,
    requestId?: string
  ) {
    const updates: string[] = ['updated_at = now()'];
    const values: any[] = [businessId, payableId];
    let idx = 3;

    if (input.expected_payment_date !== undefined) {
      updates.push(`expected_payment_date = $${idx++}`);
      values.push(input.expected_payment_date);
    }
    if (input.expected_date_source !== undefined) {
      updates.push(`expected_date_source = $${idx++}`);
      values.push(input.expected_date_source);
    }
    if (input.expected_certainty !== undefined) {
      updates.push(`expected_certainty = $${idx++}`);
      values.push(input.expected_certainty);
    }
    if (input.payment_state !== undefined) {
      updates.push(`payment_state = $${idx++}`);
      values.push(input.payment_state);
    }

    const sql = `
      UPDATE payables
      SET ${updates.join(', ')}
      WHERE business_id = $1 AND id = $2
      RETURNING *
    `;

    const res = await Database.query(sql, values);
    if (res.rows.length === 0) {
      throw new NotFoundError('RESOURCE_NOT_FOUND', 'Payable not found.');
    }

    const pay = await this.getPayable(businessId, payableId);

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'PAYABLE_UPDATED',
      entityName: 'payables',
      entityId: payableId,
      requestId,
      metadata: input,
    });

    return pay;
  }

  static async listAllocations(businessId: string, payableId: string) {
    const query = `
      SELECT ppa.*, t.transaction_date, t.amount_paise as transaction_amount_paise, t.description
      FROM payable_payment_allocations ppa
      JOIN transactions t ON t.business_id = ppa.business_id AND t.id = ppa.transaction_id
      WHERE ppa.business_id = $1 AND ppa.payable_id = $2
      ORDER BY ppa.allocated_at DESC
    `;
    const res = await Database.query(query, [businessId, payableId]);
    return res.rows.map((row) => ({
      ...row,
      amount_paise: row.amount_paise.toString(),
      transaction_amount_paise: row.transaction_amount_paise.toString(),
    }));
  }

  static async allocatePayable(
    businessId: string,
    payableId: string,
    userId: string,
    input: AllocatePayableInput,
    requestId?: string
  ) {
    const query = `
      INSERT INTO payable_payment_allocations (
        business_id, payable_id, transaction_id, amount_paise, created_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    const res = await Database.query(query, [
      businessId,
      payableId,
      input.transaction_id,
      input.amount_paise,
      userId,
    ]);

    const alloc = res.rows[0];
    const pay = await this.getPayable(businessId, payableId);

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'PAYABLE_ALLOCATED',
      entityName: 'payable_payment_allocations',
      entityId: alloc.id,
      requestId,
      metadata: { payable_id: payableId, amount_paise: input.amount_paise },
    });

    return {
      id: alloc.id,
      payable_id: alloc.payable_id,
      transaction_id: alloc.transaction_id,
      amount_paise: alloc.amount_paise.toString(),
      allocated_at: alloc.allocated_at,
      outstanding_paise: pay.outstanding_paise,
    };
  }

  static async recordPayment(
    businessId: string,
    payableId: string,
    userId: string,
    input: RecordPayablePaymentInput,
    requestId?: string
  ) {
    return Database.withTransaction(async (client) => {
      // 1. Get payable & bill
      const pay = await this.getPayable(businessId, payableId);
      const remainingPaise = BigInt(pay.outstanding_paise);
      const paymentPaise = BigInt(input.amount_paise);

      if (paymentPaise > remainingPaise) {
        throw new ConflictError(
          'ALLOCATION_LIMIT_EXCEEDED',
          `Payment amount (${input.amount_paise}) exceeds outstanding payable amount (${pay.outstanding_paise}).`
        );
      }

      // Default data source if not provided
      let dataSourceId = input.data_source_id;
      if (!dataSourceId) {
        const dsRes = await client.query(
          "SELECT id FROM data_sources WHERE business_id = $1 AND source_type = 'MANUAL' LIMIT 1",
          [businessId]
        );
        dataSourceId = dsRes.rows[0]?.id;
      }

      // 2. Create actual OUTFLOW transaction
      const txRes = await client.query(
        `INSERT INTO transactions (
          business_id, account_id, category_id, data_source_id, source_reference,
          transaction_date, occurred_at, transaction_type, cash_direction,
          amount_paise, description, counterparty_name, record_status, created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'OUTFLOW', 'OUTFLOW', $8, $9, $10, 'POSTED', $11)
        RETURNING *`,
        [
          businessId,
          input.account_id,
          input.category_id || null,
          dataSourceId,
          input.source_reference || null,
          input.transaction_date,
          input.occurred_at || null,
          input.amount_paise,
          input.description,
          pay.supplier_name,
          userId,
        ]
      );
      const tx = txRes.rows[0];

      // 3. Create allocation
      const allocRes = await client.query(
        `INSERT INTO payable_payment_allocations (
          business_id, payable_id, transaction_id, amount_paise, created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [businessId, payableId, tx.id, input.amount_paise, userId]
      );
      const alloc = allocRes.rows[0];

      const newOutstanding = (remainingPaise - paymentPaise).toString();

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'PAYABLE_PAYMENT_RECORDED',
          entityName: 'payable_payment_allocations',
          entityId: alloc.id,
          requestId,
          metadata: { amount_paise: input.amount_paise, payable_id: payableId },
        },
        client
      );

      return {
        transaction: {
          id: tx.id,
          transaction_type: tx.transaction_type,
          cash_direction: tx.cash_direction,
          amount_paise: tx.amount_paise.toString(),
          record_status: tx.record_status,
        },
        allocation: {
          id: alloc.id,
          payable_id: alloc.payable_id,
          amount_paise: alloc.amount_paise.toString(),
          outstanding_paise: newOutstanding,
        },
      };
    });
  }
}
