import { Database } from '../../db';
import { z } from 'zod';
import { AuditLogger } from '../../middleware/audit';
import { NotFoundError, ConflictError, ValidationError } from '../../utils/errors';

export const createRecurringItemSchema = z.object({
  category_id: z.string().uuid().nullable().optional(),
  counterparty_type: z.enum(['CUSTOMER', 'SUPPLIER', 'OTHER']),
  customer_id: z.string().uuid().nullable().optional(),
  supplier_id: z.string().uuid().nullable().optional(),
  direction: z.enum(['INFLOW', 'OUTFLOW']),
  description: z.string().min(2).trim(),
  amount_paise: z.string().regex(/^[1-9]\d*$/, 'amount_paise must be positive'),
  recurrence: z.enum(['WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
  interval_count: z.number().int().min(1).default(1),
  day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  next_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const updateOccurrenceSchema = z.object({
  expected_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expected_amount_paise: z.string().regex(/^[1-9]\d*$/).optional(),
  certainty: z.enum(['ESTIMATED', 'CONFIRMED']).optional(),
  occurrence_status: z.enum(['PLANNED', 'CONFIRMED', 'SKIPPED', 'CANCELLED']).optional(),
});

export class RecurringService {
  static async createItem(businessId: string, userId: string, input: z.infer<typeof createRecurringItemSchema>, requestId?: string) {
    // Validate counterparty mappings
    if (input.counterparty_type === 'CUSTOMER' && (!input.customer_id || input.direction !== 'INFLOW')) {
      throw new ValidationError('CUSTOMER counterparty requires customer_id and direction INFLOW.');
    }
    if (input.counterparty_type === 'SUPPLIER' && (!input.supplier_id || input.direction !== 'OUTFLOW')) {
      throw new ValidationError('SUPPLIER counterparty requires supplier_id and direction OUTFLOW.');
    }
    if (input.counterparty_type === 'OTHER' && (input.customer_id || input.supplier_id)) {
      throw new ValidationError('OTHER counterparty must have null customer_id and supplier_id.');
    }

    const nextDue = input.next_due_date || input.start_date;

    return Database.withTransaction(async (client) => {
      const itemRes = await client.query(
        `INSERT INTO recurring_items (
          business_id, category_id, counterparty_type, customer_id, supplier_id,
          direction, description, amount_paise, recurrence, interval_count,
          day_of_month, start_date, end_date, next_due_date, schedule_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'ACTIVE')
        RETURNING *`,
        [
          businessId,
          input.category_id || null,
          input.counterparty_type,
          input.customer_id || null,
          input.supplier_id || null,
          input.direction,
          input.description,
          input.amount_paise,
          input.recurrence,
          input.interval_count,
          input.day_of_month || null,
          input.start_date,
          input.end_date || null,
          nextDue,
        ]
      );
      const item = itemRes.rows[0];

      // Auto-generate first occurrence
      await client.query(
        `INSERT INTO recurring_occurrences (
          business_id, recurring_item_id, period_key, expected_date,
          expected_amount_paise, certainty, occurrence_status
        )
        VALUES ($1, $2, $3, $3, $4, 'ESTIMATED', 'PLANNED')
        ON CONFLICT DO NOTHING`,
        [businessId, item.id, nextDue, input.amount_paise]
      );

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'RECURRING_ITEM_CREATED',
          entityName: 'recurring_items',
          entityId: item.id,
          requestId,
        },
        client
      );

      return {
        ...item,
        amount_paise: item.amount_paise.toString(),
      };
    });
  }

  static async listItems(businessId: string, direction?: string) {
    let query = 'SELECT * FROM recurring_items WHERE business_id = $1';
    const params: any[] = [businessId];
    if (direction) {
      query += ' AND direction = $2';
      params.push(direction);
    }
    query += ' ORDER BY next_due_date ASC';
    const res = await Database.query(query, params);
    return res.rows.map((row) => ({
      ...row,
      amount_paise: row.amount_paise.toString(),
    }));
  }

  static async listOccurrences(businessId: string, fromDate?: string, toDate?: string) {
    let query = `
      SELECT ro.*, ri.description, ri.direction
      FROM recurring_occurrences ro
      JOIN recurring_items ri ON ri.business_id = ro.business_id AND ri.id = ro.recurring_item_id
      WHERE ro.business_id = $1
    `;
    const params: any[] = [businessId];
    let idx = 2;

    if (fromDate) {
      query += ` AND ro.expected_date >= $${idx++}`;
      params.push(fromDate);
    }
    if (toDate) {
      query += ` AND ro.expected_date <= $${idx++}`;
      params.push(toDate);
    }

    query += ' ORDER BY ro.expected_date ASC';
    const res = await Database.query(query, params);
    return res.rows.map((row) => ({
      ...row,
      expected_amount_paise: row.expected_amount_paise.toString(),
    }));
  }

  static async updateOccurrence(
    businessId: string,
    occurrenceId: string,
    userId: string,
    input: z.infer<typeof updateOccurrenceSchema>,
    requestId?: string
  ) {
    const updates: string[] = ['updated_at = now()'];
    const values: any[] = [businessId, occurrenceId];
    let idx = 3;

    if (input.expected_date !== undefined) {
      updates.push(`expected_date = $${idx++}`);
      values.push(input.expected_date);
    }
    if (input.expected_amount_paise !== undefined) {
      updates.push(`expected_amount_paise = $${idx++}`);
      values.push(input.expected_amount_paise);
    }
    if (input.certainty !== undefined) {
      updates.push(`certainty = $${idx++}`);
      values.push(input.certainty);
    }
    if (input.occurrence_status !== undefined) {
      updates.push(`occurrence_status = $${idx++}`);
      values.push(input.occurrence_status);
    }

    const sql = `
      UPDATE recurring_occurrences
      SET ${updates.join(', ')}
      WHERE business_id = $1 AND id = $2
      RETURNING *
    `;

    const res = await Database.query(sql, values);
    if (res.rows.length === 0) {
      throw new NotFoundError('RESOURCE_NOT_FOUND', 'Recurring occurrence not found.');
    }

    const occ = res.rows[0];
    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'RECURRING_OCCURRENCE_UPDATED',
      entityName: 'recurring_occurrences',
      entityId: occurrenceId,
      requestId,
    });

    return {
      ...occ,
      expected_amount_paise: occ.expected_amount_paise.toString(),
    };
  }

  static async reconcileOccurrence(
    businessId: string,
    occurrenceId: string,
    transactionId: string,
    userId: string,
    requestId?: string
  ) {
    return Database.withTransaction(async (client) => {
      // 1. Validate occurrence
      const occRes = await client.query(
        'SELECT * FROM recurring_occurrences WHERE business_id = $1 AND id = $2 FOR UPDATE',
        [businessId, occurrenceId]
      );
      if (occRes.rows.length === 0) {
        throw new NotFoundError('RESOURCE_NOT_FOUND', 'Occurrence not found.');
      }
      const occ = occRes.rows[0];
      if (occ.occurrence_status === 'SETTLED') {
        throw new ConflictError('STATE_CONFLICT', 'Occurrence is already settled.');
      }

      // 2. Validate transaction
      const txRes = await client.query(
        'SELECT * FROM transactions WHERE business_id = $1 AND id = $2',
        [businessId, transactionId]
      );
      if (txRes.rows.length === 0) {
        throw new NotFoundError('RESOURCE_NOT_FOUND', 'Transaction not found.');
      }
      const tx = txRes.rows[0];
      if (tx.record_status !== 'POSTED') {
        throw new ConflictError('STATE_CONFLICT', 'Can only reconcile to a POSTED transaction.');
      }

      // 3. Mark occurrence SETTLED and set actual_transaction_id atomically
      const updatedRes = await client.query(
        `UPDATE recurring_occurrences
         SET occurrence_status = 'SETTLED',
             actual_transaction_id = $1,
             updated_at = now()
         WHERE business_id = $2 AND id = $3
         RETURNING *`,
        [transactionId, businessId, occurrenceId]
      );
      const updated = updatedRes.rows[0];

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'RECURRING_OCCURRENCE_RECONCILED',
          entityName: 'recurring_occurrences',
          entityId: occurrenceId,
          requestId,
          metadata: { actual_transaction_id: transactionId },
        },
        client
      );

      return {
        ...updated,
        expected_amount_paise: updated.expected_amount_paise.toString(),
      };
    });
  }
}
