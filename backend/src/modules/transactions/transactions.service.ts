import { Database } from '../../db';
import {
  CreateTransactionInput,
  CreateTransferInput,
  UpdateTransactionInput,
  ReverseTransactionInput,
} from './transactions.validators';
import { AuditLogger } from '../../middleware/audit';
import { NotFoundError, ConflictError, ValidationError } from '../../utils/errors';

export class TransactionsService {
  static async createTransaction(
    businessId: string,
    userId: string,
    input: CreateTransactionInput,
    requestId?: string
  ) {
    // Validate account belongs to business
    const acc = await Database.query(
      'SELECT id, currency_code, is_active FROM accounts WHERE business_id = $1 AND id = $2',
      [businessId, input.account_id]
    );
    if (acc.rows.length === 0 || !acc.rows[0].is_active) {
      throw new ValidationError('Invalid or inactive account specified.');
    }

    // Direction check
    if (
      (input.transaction_type === 'INFLOW' || input.transaction_type === 'OWNER_CONTRIBUTION') &&
      input.cash_direction !== 'INFLOW'
    ) {
      throw new ValidationError('transaction_type and cash_direction mismatch.');
    }
    if (
      (input.transaction_type === 'OUTFLOW' || input.transaction_type === 'OWNER_DRAW') &&
      input.cash_direction !== 'OUTFLOW'
    ) {
      throw new ValidationError('transaction_type and cash_direction mismatch.');
    }

    const query = `
      INSERT INTO transactions (
        business_id, account_id, category_id, data_source_id, source_reference,
        transaction_date, occurred_at, transaction_type, cash_direction,
        amount_paise, description, counterparty_name, record_status, created_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'POSTED', $13)
      RETURNING *
    `;

    const res = await Database.query(query, [
      businessId,
      input.account_id,
      input.category_id || null,
      input.data_source_id,
      input.source_reference || null,
      input.transaction_date,
      input.occurred_at || null,
      input.transaction_type,
      input.cash_direction,
      input.amount_paise,
      input.description || null,
      input.counterparty_name || null,
      userId,
    ]);

    const tx = res.rows[0];

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'TRANSACTION_RECORDED',
      entityName: 'transactions',
      entityId: tx.id,
      requestId,
      metadata: { amount_paise: input.amount_paise, direction: input.cash_direction },
    });

    return {
      ...tx,
      amount_paise: tx.amount_paise.toString(),
    };
  }

  static async createTransfer(
    businessId: string,
    userId: string,
    input: CreateTransferInput,
    requestId?: string
  ) {
    if (input.outgoing_account_id === input.incoming_account_id) {
      throw new ValidationError('Outgoing and incoming accounts must be distinct.');
    }

    return Database.withTransaction(async (client) => {
      // Find default or provided data source
      let dataSourceId = input.data_source_id;
      if (!dataSourceId) {
        const dsRes = await client.query(
          "SELECT id FROM data_sources WHERE business_id = $1 AND source_type = 'MANUAL' LIMIT 1",
          [businessId]
        );
        dataSourceId = dsRes.rows[0]?.id;
        if (!dataSourceId) {
          throw new ValidationError('No valid MANUAL data source found for this business.');
        }
      }

      // 1. Create OUTFLOW leg
      const outRes = await client.query(
        `INSERT INTO transactions (
          business_id, account_id, data_source_id, transaction_date, occurred_at,
          transaction_type, cash_direction, amount_paise, description, record_status, created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, 'TRANSFER_OUT', 'OUTFLOW', $6, $7, 'POSTED', $8)
        RETURNING id`,
        [
          businessId,
          input.outgoing_account_id,
          dataSourceId,
          input.transaction_date,
          input.occurred_at || null,
          input.amount_paise,
          input.description,
          userId,
        ]
      );
      const outTxId = outRes.rows[0].id;

      // 2. Create INFLOW leg
      const inRes = await client.query(
        `INSERT INTO transactions (
          business_id, account_id, data_source_id, transaction_date, occurred_at,
          transaction_type, cash_direction, amount_paise, description, record_status, created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, 'TRANSFER_IN', 'INFLOW', $6, $7, 'POSTED', $8)
        RETURNING id`,
        [
          businessId,
          input.incoming_account_id,
          dataSourceId,
          input.transaction_date,
          input.occurred_at || null,
          input.amount_paise,
          input.description,
          userId,
        ]
      );
      const inTxId = inRes.rows[0].id;

      // 3. Create transfer pairing row
      const transferRes = await client.query(
        `INSERT INTO transaction_transfers (
          business_id, outgoing_transaction_id, incoming_transaction_id, amount_paise
        )
        VALUES ($1, $2, $3, $4)
        RETURNING id, amount_paise, created_at`,
        [businessId, outTxId, inTxId, input.amount_paise]
      );

      const transfer = transferRes.rows[0];

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'ACCOUNT_TRANSFER_EXECUTED',
          entityName: 'transaction_transfers',
          entityId: transfer.id,
          requestId,
          metadata: {
            outgoing_account_id: input.outgoing_account_id,
            incoming_account_id: input.incoming_account_id,
            amount_paise: input.amount_paise,
          },
        },
        client
      );

      return {
        id: transfer.id,
        outgoing_transaction_id: outTxId,
        incoming_transaction_id: inTxId,
        outgoing_account_id: input.outgoing_account_id,
        incoming_account_id: input.incoming_account_id,
        amount_paise: input.amount_paise,
        transaction_date: input.transaction_date,
      };
    });
  }

  static async listTransactions(
    businessId: string,
    filters: {
      from_date?: string;
      to_date?: string;
      account_id?: string;
      category_id?: string;
      cash_direction?: string;
      record_status?: string;
      page_size?: number;
      cursor?: string;
    }
  ) {
    const conditions: string[] = ['business_id = $1'];
    const params: any[] = [businessId];
    let idx = 2;

    if (filters.from_date) {
      conditions.push(`transaction_date >= $${idx++}`);
      params.push(filters.from_date);
    }
    if (filters.to_date) {
      conditions.push(`transaction_date <= $${idx++}`);
      params.push(filters.to_date);
    }
    if (filters.account_id) {
      conditions.push(`account_id = $${idx++}`);
      params.push(filters.account_id);
    }
    if (filters.category_id) {
      conditions.push(`category_id = $${idx++}`);
      params.push(filters.category_id);
    }
    if (filters.cash_direction) {
      conditions.push(`cash_direction = $${idx++}`);
      params.push(filters.cash_direction);
    }

    const status = filters.record_status || 'POSTED';
    conditions.push(`record_status = $${idx++}`);
    params.push(status);

    const limit = Math.min(Math.max(filters.page_size || 50, 1), 100);
    params.push(limit);

    const query = `
      SELECT t.*, tc.display_name as category_name, a.display_name as account_name
      FROM transactions t
      LEFT JOIN transaction_categories tc ON tc.business_id = t.business_id AND tc.id = t.category_id
      JOIN accounts a ON a.business_id = t.business_id AND a.id = t.account_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.transaction_date DESC, t.created_at DESC
      LIMIT $${idx}
    `;

    const res = await Database.query(query, params);
    return res.rows.map((row) => ({
      ...row,
      amount_paise: row.amount_paise.toString(),
    }));
  }

  static async getTransaction(businessId: string, transactionId: string) {
    const query = `
      SELECT t.*, tc.display_name as category_name, a.display_name as account_name
      FROM transactions t
      LEFT JOIN transaction_categories tc ON tc.business_id = t.business_id AND tc.id = t.category_id
      JOIN accounts a ON a.business_id = t.business_id AND a.id = t.account_id
      WHERE t.business_id = $1 AND t.id = $2
    `;

    const res = await Database.query(query, [businessId, transactionId]);
    if (res.rows.length === 0) {
      throw new NotFoundError('RESOURCE_NOT_FOUND', 'Transaction not found.');
    }

    const row = res.rows[0];
    return {
      ...row,
      amount_paise: row.amount_paise.toString(),
    };
  }

  static async updateTransaction(
    businessId: string,
    transactionId: string,
    userId: string,
    input: UpdateTransactionInput,
    requestId?: string
  ) {
    // Check transaction exists and is POSTED
    const tx = await this.getTransaction(businessId, transactionId);
    if (tx.record_status !== 'POSTED') {
      throw new ConflictError('TRANSACTION_NOT_EDITABLE', 'Only POSTED transactions may be edited.');
    }

    const updates: string[] = ['updated_at = now()'];
    const values: any[] = [businessId, transactionId];
    let idx = 3;

    if (input.category_id !== undefined) {
      updates.push(`category_id = $${idx++}`);
      values.push(input.category_id);
    }
    if (input.description !== undefined) {
      updates.push(`description = $${idx++}`);
      values.push(input.description);
    }
    if (input.counterparty_name !== undefined) {
      updates.push(`counterparty_name = $${idx++}`);
      values.push(input.counterparty_name);
    }

    const sql = `
      UPDATE transactions
      SET ${updates.join(', ')}
      WHERE business_id = $1 AND id = $2
      RETURNING *
    `;

    const res = await Database.query(sql, values);
    const updated = res.rows[0];

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'TRANSACTION_METADATA_UPDATED',
      entityName: 'transactions',
      entityId: transactionId,
      requestId,
      metadata: input,
    });

    return {
      ...updated,
      amount_paise: updated.amount_paise.toString(),
    };
  }

  static async reverseTransaction(
    businessId: string,
    transactionId: string,
    userId: string,
    input: ReverseTransactionInput,
    requestId?: string
  ) {
    return Database.withTransaction(async (client) => {
      // 1. Lock and fetch original transaction
      const origRes = await client.query(
        'SELECT * FROM transactions WHERE business_id = $1 AND id = $2 FOR UPDATE',
        [businessId, transactionId]
      );

      if (origRes.rows.length === 0) {
        throw new NotFoundError('RESOURCE_NOT_FOUND', 'Transaction not found.');
      }

      const orig = origRes.rows[0];
      if (orig.record_status === 'REVERSED') {
        throw new ConflictError('STATE_CONFLICT', 'Transaction is already reversed.');
      }
      if (orig.reversal_of_transaction_id) {
        throw new ConflictError('STATE_CONFLICT', 'Reversal transactions cannot themselves be reversed.');
      }

      // Opposite direction
      const oppositeDir = orig.cash_direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW';
      const reversalType = oppositeDir === 'INFLOW' ? 'INFLOW' : 'OUTFLOW';

      // 2. Insert reversal row
      const revRes = await client.query(
        `INSERT INTO transactions (
          business_id, account_id, category_id, data_source_id, transaction_date,
          occurred_at, transaction_type, cash_direction, amount_paise, description,
          counterparty_name, record_status, reversal_of_transaction_id, created_by_user_id
        )
        VALUES ($1, $2, $3, $4, CURRENT_DATE, now(), $5, $6, $7, $8, $9, 'POSTED', $10, $11)
        RETURNING id`,
        [
          businessId,
          orig.account_id,
          orig.category_id,
          orig.data_source_id,
          reversalType,
          oppositeDir,
          orig.amount_paise,
          `Reversal: ${input.reason}`,
          orig.counterparty_name,
          orig.id,
          userId,
        ]
      );
      const reversalId = revRes.rows[0].id;

      // 3. Update original to REVERSED
      await client.query(
        "UPDATE transactions SET record_status = 'REVERSED', updated_at = now() WHERE business_id = $1 AND id = $2",
        [businessId, transactionId]
      );

      // 4. Remove any existing allocations
      const delRecAlloc = await client.query(
        'DELETE FROM receivable_payment_allocations WHERE business_id = $1 AND transaction_id = $2 RETURNING receivable_id',
        [businessId, transactionId]
      );
      const delPayAlloc = await client.query(
        'DELETE FROM payable_payment_allocations WHERE business_id = $1 AND transaction_id = $2 RETURNING payable_id',
        [businessId, transactionId]
      );
      const removedAllocationCount = delRecAlloc.rowCount! + delPayAlloc.rowCount!;
      const reopenedReceivableIds = delRecAlloc.rows.map((r) => r.receivable_id);

      // 5. If replacement is supplied, create replacement transaction
      let replacementId: string | null = null;
      if (input.replacement) {
        const replRes = await client.query(
          `INSERT INTO transactions (
            business_id, account_id, category_id, data_source_id, source_reference,
            transaction_date, occurred_at, transaction_type, cash_direction,
            amount_paise, description, counterparty_name, record_status, created_by_user_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'POSTED', $13)
          RETURNING id`,
          [
            businessId,
            input.replacement.account_id,
            input.replacement.category_id || null,
            input.replacement.data_source_id,
            input.replacement.source_reference || null,
            input.replacement.transaction_date,
            input.replacement.occurred_at || null,
            input.replacement.transaction_type,
            input.replacement.cash_direction,
            input.replacement.amount_paise,
            input.replacement.description || null,
            input.replacement.counterparty_name || null,
            userId,
          ]
        );
        replacementId = replRes.rows[0].id;
      }

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'TRANSACTION_REVERSED',
          entityName: 'transactions',
          entityId: transactionId,
          requestId,
          metadata: {
            reason: input.reason,
            reversal_id: reversalId,
            replacement_id: replacementId,
          },
        },
        client
      );

      return {
        reversed_transaction_ids: [transactionId],
        reversal_transaction_ids: [reversalId],
        replacement_transaction_ids: replacementId ? [replacementId] : [],
        removed_allocation_count: removedAllocationCount,
        reopened_receivable_ids: reopenedReceivableIds,
        restored_occurrence_ids: [],
        record_status: 'REVERSED',
      };
    });
  }
}
