import { Database } from '../../db';
import {
  CreateTransactionInput,
  CreateTransferInput,
  UpdateTransactionInput,
  ReverseTransactionInput,
} from './transactions.validators';
import { AuditLogger } from '../../middleware/audit';
import { NotFoundError, ConflictError, ValidationError } from '../../utils/errors';
import { AccountsService } from '../accounts/accounts.service';
import { MoneyUtil } from '../../utils/money';

export class TransactionsService {
  static async createTransaction(
    businessId: string,
    userId: string,
    input: CreateTransactionInput,
    requestId?: string
  ) {
    // 1. Resolve direction and transaction type
    let cashDirection: 'INFLOW' | 'OUTFLOW' = 'INFLOW';
    let transactionType: string = 'INFLOW';

    if (input.cash_direction) {
      cashDirection = input.cash_direction;
      transactionType = input.transaction_type || input.cash_direction;
    } else if (input.type) {
      const norm = input.type.toUpperCase();
      if (norm === 'INCOME' || norm === 'INFLOW') {
        cashDirection = 'INFLOW';
        transactionType = 'INFLOW';
      } else if (norm === 'EXPENSE' || norm === 'OUTFLOW') {
        cashDirection = 'OUTFLOW';
        transactionType = 'OUTFLOW';
      }
    }

    // Direction validation against strict check constraint
    if (
      (transactionType === 'INFLOW' || transactionType === 'OWNER_CONTRIBUTION' || transactionType === 'TRANSFER_IN') &&
      cashDirection !== 'INFLOW'
    ) {
      throw new ValidationError('transaction_type and cash_direction mismatch.');
    }
    if (
      (transactionType === 'OUTFLOW' || transactionType === 'OWNER_DRAW' || transactionType === 'TRANSFER_OUT') &&
      cashDirection !== 'OUTFLOW'
    ) {
      throw new ValidationError('transaction_type and cash_direction mismatch.');
    }

    // 2. Resolve amount_paise safely
    let amountPaiseStr = input.amount_paise;
    if (!amountPaiseStr && input.amount !== undefined) {
      amountPaiseStr = MoneyUtil.rupeesToPaise(input.amount).toString();
    }
    if (!amountPaiseStr || BigInt(amountPaiseStr) <= 0n) {
      throw new ValidationError('Amount must be greater than zero.');
    }

    // 3. Resolve account_id
    let accountId = input.account_id;
    if (!accountId) {
      const accRes = await Database.query(
        'SELECT id FROM accounts WHERE business_id = $1 AND is_active = true ORDER BY created_at ASC LIMIT 1',
        [businessId]
      );
      if (accRes.rows.length === 0) {
        const newAcc = await AccountsService.createAccount(businessId, userId, {
          account_type: 'CASH',
          display_name: 'Primary Cash Account',
          currency_code: 'INR',
        });
        accountId = newAcc.id;
      } else {
        accountId = accRes.rows[0].id;
      }
    } else {
      const acc = await Database.query(
        'SELECT id, currency_code, is_active FROM accounts WHERE business_id = $1 AND id = $2',
        [businessId, accountId]
      );
      if (acc.rows.length === 0 || !acc.rows[0].is_active) {
        throw new ValidationError('Invalid or inactive account specified.');
      }
    }

    // 4. Resolve data_source_id
    let dataSourceId = input.data_source_id;
    if (!dataSourceId) {
      const dsRes = await Database.query(
        "SELECT id FROM data_sources WHERE business_id = $1 AND source_type = 'MANUAL' AND source_status = 'ACTIVE' LIMIT 1",
        [businessId]
      );
      if (dsRes.rows.length === 0) {
        const newDs = await Database.query(
          `INSERT INTO data_sources (business_id, source_type, display_name, source_status)
           VALUES ($1, 'MANUAL', 'Owner Direct Entry', 'ACTIVE')
           RETURNING id`,
          [businessId]
        );
        dataSourceId = newDs.rows[0].id;
      } else {
        dataSourceId = dsRes.rows[0].id;
      }
    }

    // 5. Resolve category_id
    let categoryId = input.category_id || null;
    if (!categoryId && input.category) {
      const catParam = input.category.trim();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(catParam);
      if (isUuid) {
        const catCheck = await Database.query(
          'SELECT id FROM transaction_categories WHERE business_id = $1 AND id = $2',
          [businessId, catParam]
        );
        if (catCheck.rows.length > 0) {
          categoryId = catCheck.rows[0].id;
        }
      } else {
        const catCheck = await Database.query(
          'SELECT id FROM transaction_categories WHERE business_id = $1 AND (lower(category_code) = lower($2) OR lower(display_name) = lower($2)) LIMIT 1',
          [businessId, catParam]
        );
        if (catCheck.rows.length > 0) {
          categoryId = catCheck.rows[0].id;
        } else {
          const code = catParam.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 30) || 'OTHER';
          try {
            const newCat = await Database.query(
              `INSERT INTO transaction_categories (business_id, category_code, display_name, allowed_direction, is_active)
               VALUES ($1, $2, $3, $4, true)
               ON CONFLICT (business_id, category_code) DO UPDATE SET display_name = EXCLUDED.display_name
               RETURNING id`,
              [businessId, code, catParam, cashDirection]
            );
            categoryId = newCat.rows[0].id;
          } catch {
            categoryId = null;
          }
        }
      }
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
      accountId,
      categoryId,
      dataSourceId,
      input.source_reference || null,
      input.transaction_date,
      input.occurred_at || null,
      transactionType,
      cashDirection,
      amountPaiseStr,
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
      metadata: { amount_paise: amountPaiseStr, direction: cashDirection },
    });

    return this.getTransaction(businessId, tx.id);
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
      search?: string;
      record_status?: string;
      page?: number;
      limit?: number;
      page_size?: number;
      cursor?: string;
    }
  ) {
    const isValidIsoDate = (dateStr: string): boolean => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
      const [year, month, day] = dateStr.split('-').map(Number);
      if (month < 1 || month > 12 || day < 1 || day > 31) return false;
      const d = new Date(Date.UTC(year, month - 1, day));
      return (
        d.getUTCFullYear() === year &&
        d.getUTCMonth() === month - 1 &&
        d.getUTCDate() === day
      );
    };

    if (filters.from_date && !isValidIsoDate(filters.from_date)) {
      throw new ValidationError('from_date must be formatted as YYYY-MM-DD');
    }
    if (filters.to_date && !isValidIsoDate(filters.to_date)) {
      throw new ValidationError('to_date must be formatted as YYYY-MM-DD');
    }
    if (filters.from_date && filters.to_date && filters.from_date > filters.to_date) {
      throw new ValidationError('Invalid date range: from_date cannot be after to_date.');
    }

    const conditions: string[] = ['t.business_id = $1'];
    const params: any[] = [businessId];
    let idx = 2;

    if (filters.from_date) {
      conditions.push(`t.transaction_date >= $${idx++}`);
      params.push(filters.from_date);
    }
    if (filters.to_date) {
      conditions.push(`t.transaction_date <= $${idx++}`);
      params.push(filters.to_date);
    }
    if (filters.account_id) {
      conditions.push(`t.account_id = $${idx++}`);
      params.push(filters.account_id);
    }
    if (filters.category_id) {
      conditions.push(`t.category_id = $${idx++}`);
      params.push(filters.category_id);
    }
    if (filters.cash_direction) {
      conditions.push(`t.cash_direction = $${idx++}`);
      params.push(filters.cash_direction);
    }
    if (filters.search && filters.search.trim().length > 0) {
      const term = `%${filters.search.trim()}%`;
      conditions.push(`(t.description ILIKE $${idx} OR t.counterparty_name ILIKE $${idx})`);
      params.push(term);
      idx++;
    }

    const status = filters.record_status || 'POSTED';
    conditions.push(`t.record_status = $${idx++}`);
    params.push(status);

    // 1. Run count query to obtain total matching rows before LIMIT/OFFSET
    const countSql = `
      SELECT COUNT(*) as total_count
      FROM transactions t
      WHERE ${conditions.join(' AND ')}
    `;
    const countRes = await Database.query(countSql, params);
    const totalCount = parseInt(countRes.rows[0]?.total_count || '0', 10);

    // 2. Resolve page, limit, and offset
    const page = Math.max(filters.page || 1, 1);
    const limit = Math.min(Math.max(filters.limit || filters.page_size || 50, 1), 100);
    const offset = (page - 1) * limit;
    const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / limit);

    // 3. Main query with deterministic order, LIMIT, and OFFSET
    const query = `
      SELECT t.*, tc.display_name as category_name, a.display_name as account_name
      FROM transactions t
      LEFT JOIN transaction_categories tc ON tc.business_id = t.business_id AND tc.id = t.category_id
      JOIN accounts a ON a.business_id = t.business_id AND a.id = t.account_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    const mainParams = [...params, limit, offset];
    const res = await Database.query(query, mainParams);
    const items = res.rows.map((row) => ({
      ...row,
      amount_paise: row.amount_paise.toString(),
      amount_rupees: Number(row.amount_paise) / 100,
    }));

    return {
      items,
      total_count: totalCount,
      page,
      limit,
      total_pages: totalPages,
    };
  }

  static async getSummary(businessId: string) {
    const sumRes = await Database.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN cash_direction = 'INFLOW' THEN amount_paise ELSE 0 END), 0) as total_income_paise,
        COALESCE(SUM(CASE WHEN cash_direction = 'OUTFLOW' THEN amount_paise ELSE 0 END), 0) as total_expense_paise,
        COUNT(*) as transaction_count
       FROM transactions
       WHERE business_id = $1 AND record_status = 'POSTED'`,
      [businessId]
    );

    const row = sumRes.rows[0];
    const totalIncomePaise = BigInt(row.total_income_paise || '0');
    const totalExpensePaise = BigInt(row.total_expense_paise || '0');
    const netCashFlowPaise = totalIncomePaise - totalExpensePaise;
    const transactionCount = parseInt(row.transaction_count || '0', 10);

    const balanceInfo = await AccountsService.getBalances(businessId);
    const currentCashBalancePaise = BigInt(balanceInfo.total_balance_paise || '0');

    const recentTransactionsRes = await this.listTransactions(businessId, { page_size: 10 });

    return {
      total_income_paise: totalIncomePaise.toString(),
      total_expense_paise: totalExpensePaise.toString(),
      net_cash_flow_paise: netCashFlowPaise.toString(),
      current_cash_balance_paise: currentCashBalancePaise.toString(),
      total_income_rupees: Number(totalIncomePaise) / 100,
      total_expense_rupees: Number(totalExpensePaise) / 100,
      net_cash_flow_rupees: Number(netCashFlowPaise) / 100,
      current_cash_balance_rupees: Number(currentCashBalancePaise) / 100,
      transaction_count: transactionCount,
      currency_code: 'INR',
      recent_transactions: recentTransactionsRes.items,
    };
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
      amount_rupees: Number(row.amount_paise) / 100,
    };
  }

  static async updateTransaction(
    businessId: string,
    transactionId: string,
    userId: string,
    input: UpdateTransactionInput,
    requestId?: string
  ) {
    // 1. Check transaction exists, belongs to business, and is POSTED
    const tx = await this.getTransaction(businessId, transactionId);
    if (tx.record_status !== 'POSTED') {
      throw new ConflictError('TRANSACTION_NOT_EDITABLE', 'Only POSTED transactions may be edited.');
    }

    // 2. Resolve amount_paise if amount or amount_paise is provided
    let amountPaiseStr: string | undefined = undefined;
    if (input.amount_paise !== undefined) {
      if (!/^[1-9]\d*$/.test(input.amount_paise)) {
        throw new ValidationError('amount_paise must be a positive integer string.');
      }
      amountPaiseStr = input.amount_paise;
    } else if (input.amount !== undefined) {
      const parsedAmount = typeof input.amount === 'string' ? parseFloat(input.amount) : input.amount;
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError('Amount must be greater than zero.');
      }
      amountPaiseStr = MoneyUtil.rupeesToPaise(input.amount).toString();
    }

    // 3. Resolve category_id if provided (by category_id or category display name)
    let categoryId = input.category_id;
    if (categoryId === undefined && input.category) {
      const catRes = await Database.query(
        'SELECT id FROM transaction_categories WHERE business_id = $1 AND (display_name ILIKE $2 OR category_code ILIKE $2) LIMIT 1',
        [businessId, input.category]
      );
      if (catRes.rows.length > 0) {
        categoryId = catRes.rows[0].id;
      }
    }

    // 4. Validate category compatibility with transaction direction
    if (categoryId !== undefined && categoryId !== null) {
      const catRes = await Database.query(
        'SELECT id, display_name, allowed_direction FROM transaction_categories WHERE business_id = $1 AND id = $2',
        [businessId, categoryId]
      );
      if (catRes.rows.length === 0) {
        throw new ValidationError('Invalid category specified.');
      }
      const cat = catRes.rows[0];
      if (cat.allowed_direction !== 'BOTH' && cat.allowed_direction !== tx.cash_direction) {
        throw new ValidationError(
          `Category "${cat.display_name}" is only allowed for ${
            cat.allowed_direction === 'INFLOW' ? 'income (inflow)' : 'expense (outflow)'
          } transactions and cannot be used for this ${tx.cash_direction.toLowerCase()} transaction.`
        );
      }
    }

    const updates: string[] = ['updated_at = now()'];
    const values: any[] = [businessId, transactionId];
    let idx = 3;

    if (amountPaiseStr !== undefined) {
      updates.push(`amount_paise = $${idx++}`);
      values.push(amountPaiseStr);
    }
    if (input.transaction_date !== undefined) {
      updates.push(`transaction_date = $${idx++}`);
      values.push(input.transaction_date);
    }
    if (categoryId !== undefined) {
      updates.push(`category_id = $${idx++}`);
      values.push(categoryId);
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

    await Database.query(sql, values);

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'TRANSACTION_UPDATED',
      entityName: 'transactions',
      entityId: transactionId,
      requestId,
      metadata: input,
    });

    return this.getTransaction(businessId, transactionId);
  }

  static async deleteTransaction(
    businessId: string,
    transactionId: string,
    userId: string,
    requestId?: string
  ) {
    return Database.withTransaction(async (client) => {
      // 1. Lock and fetch original transaction ensuring tenant ownership
      const origRes = await client.query(
        'SELECT * FROM transactions WHERE business_id = $1 AND id = $2 FOR UPDATE',
        [businessId, transactionId]
      );

      if (origRes.rows.length === 0) {
        throw new NotFoundError('RESOURCE_NOT_FOUND', 'Transaction not found.');
      }

      const orig = origRes.rows[0];
      if (orig.record_status === 'REVERSED') {
        throw new ConflictError('TRANSACTION_ALREADY_DELETED', 'Transaction has already been deleted or reversed.');
      }

      // 2. Soft-delete by setting record_status = 'REVERSED'
      await client.query(
        "UPDATE transactions SET record_status = 'REVERSED', updated_at = now() WHERE business_id = $1 AND id = $2",
        [businessId, transactionId]
      );

      // 3. Remove any related payment allocations so invoice/bill outstanding balances are restored
      await client.query(
        'DELETE FROM receivable_payment_allocations WHERE business_id = $1 AND transaction_id = $2',
        [businessId, transactionId]
      );
      await client.query(
        'DELETE FROM payable_payment_allocations WHERE business_id = $1 AND transaction_id = $2',
        [businessId, transactionId]
      );

      // 4. If this transaction is part of a paired transfer, soft-delete the paired leg too
      const transferRes = await client.query(
        `SELECT outgoing_transaction_id, incoming_transaction_id
         FROM transaction_transfers
         WHERE business_id = $1 AND (outgoing_transaction_id = $2 OR incoming_transaction_id = $2)`,
        [businessId, transactionId]
      );
      if (transferRes.rows.length > 0) {
        const t = transferRes.rows[0];
        const partnerId = t.outgoing_transaction_id === transactionId ? t.incoming_transaction_id : t.outgoing_transaction_id;
        await client.query(
          "UPDATE transactions SET record_status = 'REVERSED', updated_at = now() WHERE business_id = $1 AND id = $2",
          [businessId, partnerId]
        );
      }

      // 5. Audit log the deletion event
      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'TRANSACTION_DELETED',
          entityName: 'transactions',
          entityId: transactionId,
          requestId,
          metadata: {
            previous_status: 'POSTED',
            amount_paise: orig.amount_paise.toString(),
            cash_direction: orig.cash_direction,
            description: orig.description,
            counterparty_name: orig.counterparty_name,
            transaction_date: orig.transaction_date,
          },
        },
        client
      );

      return {
        id: transactionId,
        record_status: 'REVERSED',
        message: 'Transaction successfully deleted.',
      };
    });
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
