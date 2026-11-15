import { Database } from '../../db';
import {
  CreateCustomerInput,
  CreateSalesInvoiceInput,
  IssueInvoiceInput,
  UpdateReceivableInput,
  AllocateReceivableInput,
  RecordReceivablePaymentInput,
} from './receivables.validators';
import { AuditLogger } from '../../middleware/audit';
import { NotFoundError, ConflictError, ValidationError } from '../../utils/errors';

export class ReceivablesService {
  // 1. Customers
  static async createCustomer(businessId: string, input: CreateCustomerInput) {
    const query = `
      INSERT INTO customers (business_id, display_name, external_reference, contact_hint, record_status)
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

  static async listCustomers(businessId: string) {
    const query = 'SELECT * FROM customers WHERE business_id = $1 ORDER BY display_name ASC';
    const res = await Database.query(query, [businessId]);
    return res.rows;
  }

  // 2. Sales Invoices
  static async createInvoice(businessId: string, userId: string, input: CreateSalesInvoiceInput) {
    if (new Date(input.due_date) < new Date(input.issued_date)) {
      throw new ValidationError('due_date cannot be earlier than issued_date.');
    }

    const query = `
      INSERT INTO sales_invoices (
        business_id, customer_id, invoice_number, issued_date, due_date, total_paise,
        invoice_status, external_reference
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'DRAFT', $7)
      RETURNING *
    `;
    const res = await Database.query(query, [
      businessId,
      input.customer_id,
      input.invoice_number,
      input.issued_date,
      input.due_date,
      input.total_paise,
      input.external_reference || null,
    ]);

    const invoice = res.rows[0];
    return {
      ...invoice,
      total_paise: invoice.total_paise.toString(),
    };
  }

  static async listInvoices(businessId: string, filters: { customer_id?: string; invoice_status?: string }) {
    let query = `
      SELECT si.*, c.display_name as customer_name, r.id as receivable_id, r.expected_collection_date,
             (si.total_paise - COALESCE(SUM(rpa.amount_paise), 0)) as outstanding_paise
      FROM sales_invoices si
      JOIN customers c ON c.business_id = si.business_id AND c.id = si.customer_id
      LEFT JOIN receivables r ON r.business_id = si.business_id AND r.invoice_id = si.id
      LEFT JOIN receivable_payment_allocations rpa ON rpa.business_id = si.business_id AND rpa.receivable_id = r.id
      WHERE si.business_id = $1
    `;
    const params: any[] = [businessId];
    let idx = 2;

    if (filters.customer_id) {
      query += ` AND si.customer_id = $${idx++}`;
      params.push(filters.customer_id);
    }
    if (filters.invoice_status) {
      query += ` AND si.invoice_status = $${idx++}`;
      params.push(filters.invoice_status);
    }

    query += `
      GROUP BY si.id, c.display_name, r.id, r.expected_collection_date
      ORDER BY si.due_date ASC
    `;

    const res = await Database.query(query, params);
    return res.rows.map((row) => ({
      ...row,
      total_paise: row.total_paise.toString(),
      outstanding_paise: row.outstanding_paise ? row.outstanding_paise.toString() : row.total_paise.toString(),
    }));
  }

  static async getInvoice(businessId: string, invoiceId: string) {
    const query = `
      SELECT si.*, c.display_name as customer_name, r.id as receivable_id, r.expected_collection_date,
             (si.total_paise - COALESCE(SUM(rpa.amount_paise), 0)) as outstanding_paise
      FROM sales_invoices si
      JOIN customers c ON c.business_id = si.business_id AND c.id = si.customer_id
      LEFT JOIN receivables r ON r.business_id = si.business_id AND r.invoice_id = si.id
      LEFT JOIN receivable_payment_allocations rpa ON rpa.business_id = si.business_id AND rpa.receivable_id = r.id
      WHERE si.business_id = $1 AND si.id = $2
      GROUP BY si.id, c.display_name, r.id, r.expected_collection_date
    `;
    const res = await Database.query(query, [businessId, invoiceId]);
    if (res.rows.length === 0) {
      throw new NotFoundError('RESOURCE_NOT_FOUND', 'Invoice not found.');
    }
    const row = res.rows[0];
    return {
      ...row,
      total_paise: row.total_paise.toString(),
      outstanding_paise: row.outstanding_paise ? row.outstanding_paise.toString() : row.total_paise.toString(),
    };
  }

  static async issueInvoice(businessId: string, invoiceId: string, userId: string, input: IssueInvoiceInput, requestId?: string) {
    return Database.withTransaction(async (client) => {
      const invRes = await client.query(
        'SELECT * FROM sales_invoices WHERE business_id = $1 AND id = $2 FOR UPDATE',
        [businessId, invoiceId]
      );
      if (invRes.rows.length === 0) {
        throw new NotFoundError('RESOURCE_NOT_FOUND', 'Invoice not found.');
      }
      const inv = invRes.rows[0];
      if (inv.invoice_status !== 'DRAFT') {
        throw new ConflictError('STATE_CONFLICT', `Invoice cannot be issued from status ${inv.invoice_status}`);
      }

      // Mark invoice ISSUED
      await client.query(
        "UPDATE sales_invoices SET invoice_status = 'ISSUED', updated_at = now() WHERE business_id = $1 AND id = $2",
        [businessId, invoiceId]
      );

      // Create Receivable
      const expDate = input.expected_collection_date || inv.due_date;
      const recRes = await client.query(
        `INSERT INTO receivables (
          business_id, invoice_id, expected_collection_date, expected_date_source,
          expected_certainty, collection_state
        )
        VALUES ($1, $2, $3, $4, $5, 'OPEN')
        RETURNING *`,
        [businessId, invoiceId, expDate, input.expected_date_source, input.expected_certainty]
      );
      const rec = recRes.rows[0];

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'INVOICE_ISSUED',
          entityName: 'sales_invoices',
          entityId: invoiceId,
          requestId,
        },
        client
      );

      return {
        invoice_id: invoiceId,
        invoice_status: 'ISSUED',
        receivable: {
          id: rec.id,
          expected_collection_date: rec.expected_collection_date,
          expected_date_source: rec.expected_date_source,
          expected_certainty: rec.expected_certainty,
          collection_state: rec.collection_state,
          outstanding_paise: inv.total_paise.toString(),
        },
      };
    });
  }

  static async voidInvoice(businessId: string, invoiceId: string, userId: string, reason: string, requestId?: string) {
    return Database.withTransaction(async (client) => {
      const invRes = await client.query(
        'SELECT * FROM sales_invoices WHERE business_id = $1 AND id = $2 FOR UPDATE',
        [businessId, invoiceId]
      );
      if (invRes.rows.length === 0) {
        throw new NotFoundError('RESOURCE_NOT_FOUND', 'Invoice not found.');
      }
      const inv = invRes.rows[0];
      if (inv.invoice_status === 'VOID') {
        throw new ConflictError('STATE_CONFLICT', 'Invoice is already VOID.');
      }

      // Check if allocations exist
      const allocRes = await client.query(
        `SELECT rpa.id
         FROM receivable_payment_allocations rpa
         JOIN receivables r ON r.business_id = rpa.business_id AND r.id = rpa.receivable_id
         WHERE r.business_id = $1 AND r.invoice_id = $2`,
        [businessId, invoiceId]
      );
      if (allocRes.rows.length > 0) {
        throw new ConflictError('HAS_ALLOCATIONS', 'Cannot void an invoice with active payment allocations.');
      }

      await client.query(
        "UPDATE sales_invoices SET invoice_status = 'VOID', updated_at = now() WHERE business_id = $1 AND id = $2",
        [businessId, invoiceId]
      );

      await client.query(
        "UPDATE receivables SET collection_state = 'CANCELLED', updated_at = now() WHERE business_id = $1 AND invoice_id = $2",
        [businessId, invoiceId]
      );

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'INVOICE_VOIDED',
          entityName: 'sales_invoices',
          entityId: invoiceId,
          requestId,
          metadata: { reason },
        },
        client
      );

      return {
        invoice_id: invoiceId,
        invoice_status: 'VOID',
        receivable_state: 'CANCELLED',
      };
    });
  }

  // 3. Receivables & Allocations
  static async listReceivables(
    businessId: string,
    filters: { collection_state?: string; overdue?: boolean }
  ) {
    let query = `
      SELECT r.*, si.invoice_number, si.due_date, si.total_paise, c.display_name as customer_name,
             (si.total_paise - COALESCE(SUM(rpa.amount_paise), 0)) as outstanding_paise
      FROM receivables r
      JOIN sales_invoices si ON si.business_id = r.business_id AND si.id = r.invoice_id
      JOIN customers c ON c.business_id = si.business_id AND c.id = si.customer_id
      LEFT JOIN receivable_payment_allocations rpa ON rpa.business_id = r.business_id AND rpa.receivable_id = r.id
      WHERE r.business_id = $1
    `;
    const params: any[] = [businessId];
    let idx = 2;

    if (filters.collection_state) {
      query += ` AND r.collection_state = $${idx++}`;
      params.push(filters.collection_state);
    }
    if (filters.overdue) {
      query += ` AND si.due_date < CURRENT_DATE`;
    }

    query += `
      GROUP BY r.id, si.invoice_number, si.due_date, si.total_paise, c.display_name
      ORDER BY r.expected_collection_date ASC NULLS LAST
    `;

    const res = await Database.query(query, params);
    return res.rows.map((row) => ({
      ...row,
      total_paise: row.total_paise.toString(),
      outstanding_paise: row.outstanding_paise.toString(),
    }));
  }

  static async getReceivable(businessId: string, receivableId: string) {
    const query = `
      SELECT r.*, si.invoice_number, si.due_date, si.total_paise, c.display_name as customer_name,
             (si.total_paise - COALESCE(SUM(rpa.amount_paise), 0)) as outstanding_paise
      FROM receivables r
      JOIN sales_invoices si ON si.business_id = r.business_id AND si.id = r.invoice_id
      JOIN customers c ON c.business_id = si.business_id AND c.id = si.customer_id
      LEFT JOIN receivable_payment_allocations rpa ON rpa.business_id = r.business_id AND rpa.receivable_id = r.id
      WHERE r.business_id = $1 AND r.id = $2
      GROUP BY r.id, si.invoice_number, si.due_date, si.total_paise, c.display_name
    `;
    const res = await Database.query(query, [businessId, receivableId]);
    if (res.rows.length === 0) {
      throw new NotFoundError('RESOURCE_NOT_FOUND', 'Receivable not found.');
    }
    const row = res.rows[0];
    return {
      ...row,
      total_paise: row.total_paise.toString(),
      outstanding_paise: row.outstanding_paise.toString(),
    };
  }

  static async updateReceivable(
    businessId: string,
    receivableId: string,
    userId: string,
    input: UpdateReceivableInput,
    requestId?: string
  ) {
    const updates: string[] = ['updated_at = now()'];
    const values: any[] = [businessId, receivableId];
    let idx = 3;

    if (input.expected_collection_date !== undefined) {
      updates.push(`expected_collection_date = $${idx++}`);
      values.push(input.expected_collection_date);
    }
    if (input.expected_date_source !== undefined) {
      updates.push(`expected_date_source = $${idx++}`);
      values.push(input.expected_date_source);
    }
    if (input.expected_certainty !== undefined) {
      updates.push(`expected_certainty = $${idx++}`);
      values.push(input.expected_certainty);
    }
    if (input.collection_state !== undefined) {
      updates.push(`collection_state = $${idx++}`);
      values.push(input.collection_state);
    }

    const sql = `
      UPDATE receivables
      SET ${updates.join(', ')}
      WHERE business_id = $1 AND id = $2
      RETURNING *
    `;

    const res = await Database.query(sql, values);
    if (res.rows.length === 0) {
      throw new NotFoundError('RESOURCE_NOT_FOUND', 'Receivable not found.');
    }

    const rec = await this.getReceivable(businessId, receivableId);

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'RECEIVABLE_UPDATED',
      entityName: 'receivables',
      entityId: receivableId,
      requestId,
      metadata: input,
    });

    return rec;
  }

  static async listAllocations(businessId: string, receivableId: string) {
    const query = `
      SELECT rpa.*, t.transaction_date, t.amount_paise as transaction_amount_paise, t.description
      FROM receivable_payment_allocations rpa
      JOIN transactions t ON t.business_id = rpa.business_id AND t.id = rpa.transaction_id
      WHERE rpa.business_id = $1 AND rpa.receivable_id = $2
      ORDER BY rpa.allocated_at DESC
    `;
    const res = await Database.query(query, [businessId, receivableId]);
    return res.rows.map((row) => ({
      ...row,
      amount_paise: row.amount_paise.toString(),
      transaction_amount_paise: row.transaction_amount_paise.toString(),
    }));
  }

  static async allocateReceivable(
    businessId: string,
    receivableId: string,
    userId: string,
    input: AllocateReceivableInput,
    requestId?: string
  ) {
    const query = `
      INSERT INTO receivable_payment_allocations (
        business_id, receivable_id, transaction_id, amount_paise, created_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    const res = await Database.query(query, [
      businessId,
      receivableId,
      input.transaction_id,
      input.amount_paise,
      userId,
    ]);

    const alloc = res.rows[0];
    const rec = await this.getReceivable(businessId, receivableId);

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'RECEIVABLE_ALLOCATED',
      entityName: 'receivable_payment_allocations',
      entityId: alloc.id,
      requestId,
      metadata: { receivable_id: receivableId, amount_paise: input.amount_paise },
    });

    return {
      id: alloc.id,
      receivable_id: alloc.receivable_id,
      transaction_id: alloc.transaction_id,
      amount_paise: alloc.amount_paise.toString(),
      allocated_at: alloc.allocated_at,
      outstanding_paise: rec.outstanding_paise,
    };
  }

  static async recordPayment(
    businessId: string,
    receivableId: string,
    userId: string,
    input: RecordReceivablePaymentInput,
    requestId?: string
  ) {
    return Database.withTransaction(async (client) => {
      // 1. Get receivable & invoice
      const rec = await this.getReceivable(businessId, receivableId);
      const remainingPaise = BigInt(rec.outstanding_paise);
      const paymentPaise = BigInt(input.amount_paise);

      if (paymentPaise > remainingPaise) {
        throw new ConflictError(
          'ALLOCATION_LIMIT_EXCEEDED',
          `Payment amount (${input.amount_paise}) exceeds outstanding receivable amount (${rec.outstanding_paise}).`
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

      // 2. Create actual INFLOW transaction
      const txRes = await client.query(
        `INSERT INTO transactions (
          business_id, account_id, category_id, data_source_id, source_reference,
          transaction_date, occurred_at, transaction_type, cash_direction,
          amount_paise, description, counterparty_name, record_status, created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'INFLOW', 'INFLOW', $8, $9, $10, 'POSTED', $11)
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
          rec.customer_name,
          userId,
        ]
      );
      const tx = txRes.rows[0];

      // 3. Create allocation
      const allocRes = await client.query(
        `INSERT INTO receivable_payment_allocations (
          business_id, receivable_id, transaction_id, amount_paise, created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [businessId, receivableId, tx.id, input.amount_paise, userId]
      );
      const alloc = allocRes.rows[0];

      const newOutstanding = (remainingPaise - paymentPaise).toString();

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'RECEIVABLE_PAYMENT_RECORDED',
          entityName: 'receivable_payment_allocations',
          entityId: alloc.id,
          requestId,
          metadata: { amount_paise: input.amount_paise, receivable_id: receivableId },
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
          receivable_id: alloc.receivable_id,
          amount_paise: alloc.amount_paise.toString(),
          outstanding_paise: newOutstanding,
        },
      };
    });
  }
}
