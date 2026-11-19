import { Database } from '../../db';
import { CreateAccountInput, CreateBalanceSnapshotInput } from './accounts.validators';
import { AuditLogger } from '../../middleware/audit';
import { NotFoundError } from '../../utils/errors';

export class AccountsService {
  static async createAccount(
    businessId: string,
    userId: string,
    input: CreateAccountInput,
    requestId?: string
  ) {
    const query = `
      INSERT INTO accounts (business_id, account_type, display_name, institution_name, currency_code, is_active)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING id, account_type, display_name, institution_name, currency_code, is_active, created_at
    `;

    const res = await Database.query(query, [
      businessId,
      input.account_type,
      input.display_name,
      input.institution_name || null,
      input.currency_code,
    ]);

    const account = res.rows[0];

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'ACCOUNT_CREATED',
      entityName: 'accounts',
      entityId: account.id,
      requestId,
      metadata: input,
    });

    return account;
  }

  static async listAccounts(businessId: string, isActive?: boolean) {
    let query = `
      SELECT id, account_type, display_name, institution_name, currency_code, is_active, created_at
      FROM accounts
      WHERE business_id = $1
    `;
    const params: any[] = [businessId];

    if (isActive !== undefined) {
      query += ` AND is_active = $2`;
      params.push(isActive);
    }

    query += ` ORDER BY created_at ASC`;

    const res = await Database.query(query, params);
    return res.rows;
  }

  static async createBalanceSnapshot(
    businessId: string,
    accountId: string,
    userId: string,
    input: CreateBalanceSnapshotInput,
    requestId?: string
  ) {
    // Check account belongs to business
    const accCheck = await Database.query(
      'SELECT id FROM accounts WHERE business_id = $1 AND id = $2',
      [businessId, accountId]
    );

    if (accCheck.rows.length === 0) {
      throw new NotFoundError('RESOURCE_NOT_FOUND', 'Account not found in this business.');
    }

    const query = `
      INSERT INTO account_balance_snapshots (
        business_id, account_id, snapshot_type, balance_paise, as_of_at, certainty,
        source_data_source_id, entered_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, account_id, snapshot_type, balance_paise, as_of_at, certainty, source_data_source_id, created_at
    `;

    const res = await Database.query(query, [
      businessId,
      accountId,
      input.snapshot_type,
      input.balance_paise,
      input.as_of_at,
      input.certainty,
      input.source_data_source_id || null,
      userId,
    ]);

    const snapshot = res.rows[0];

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'BALANCE_SNAPSHOT_RECORDED',
      entityName: 'account_balance_snapshots',
      entityId: snapshot.id,
      requestId,
      metadata: input,
    });

    return {
      id: snapshot.id,
      account_id: snapshot.account_id,
      snapshot_type: snapshot.snapshot_type,
      balance_paise: snapshot.balance_paise.toString(),
      as_of_at: snapshot.as_of_at,
      certainty: snapshot.certainty,
      source_data_source_id: snapshot.source_data_source_id,
      created_at: snapshot.created_at,
    };
  }

  static async getBalances(businessId: string, asOfAtStr?: string, asOfDateStr?: string) {
    const asOfAt = asOfAtStr ? new Date(asOfAtStr) : new Date();
    const effectiveDateStr =
      asOfDateStr ||
      (asOfAtStr && /^\d{4}-\d{2}-\d{2}$/.test(asOfAtStr)
        ? asOfAtStr
        : asOfAt.toISOString().slice(0, 10));

    // 1. Get all active accounts
    const accounts = await this.listAccounts(businessId, true);

    const accountBalances: Array<{
      account_id: string;
      display_name: string;
      snapshot_id: string | null;
      certainty: string;
      balance_paise: string;
    }> = [];

    let totalPaise = 0n;
    let dataQuality = 'SUFFICIENT';

    for (const acc of accounts) {
      // Find latest eligible snapshot on or before asOfAt
      const snapRes = await Database.query(
        `SELECT id, balance_paise, as_of_at, certainty
         FROM account_balance_snapshots
         WHERE business_id = $1 AND account_id = $2 AND as_of_at <= $3
         ORDER BY as_of_at DESC
         LIMIT 1`,
        [businessId, acc.id, asOfAt.toISOString()]
      );

      if (snapRes.rows.length === 0) {
        dataQuality = 'LIMITED';
        const transRes = await Database.query(
          `SELECT 
            COALESCE(SUM(CASE WHEN cash_direction = 'INFLOW' THEN amount_paise ELSE 0 END), 0) as inflows,
            COALESCE(SUM(CASE WHEN cash_direction = 'OUTFLOW' THEN amount_paise ELSE 0 END), 0) as outflows
           FROM transactions
           WHERE business_id = $1 
             AND account_id = $2
             AND record_status = 'POSTED'
             AND ((occurred_at IS NOT NULL AND occurred_at <= $3)
                  OR (occurred_at IS NULL AND transaction_date <= $4::date))`,
          [businessId, acc.id, asOfAt.toISOString(), effectiveDateStr]
        );
        const inflows = BigInt(transRes.rows[0]?.inflows || '0');
        const outflows = BigInt(transRes.rows[0]?.outflows || '0');
        const currentAccBalance = inflows - outflows;
        totalPaise += currentAccBalance;

        accountBalances.push({
          account_id: acc.id,
          display_name: acc.display_name,
          snapshot_id: null,
          certainty: 'ESTIMATED',
          balance_paise: currentAccBalance.toString(),
        });
        continue;
      }

      const snap = snapRes.rows[0];
      const snapBalance = BigInt(snap.balance_paise);

      // Roll forward posted transactions strictly after snapshot cutoff through asOfAt
      const transRes = await Database.query(
        `SELECT 
          COALESCE(SUM(CASE WHEN cash_direction = 'INFLOW' THEN amount_paise ELSE 0 END), 0) as inflows,
          COALESCE(SUM(CASE WHEN cash_direction = 'OUTFLOW' THEN amount_paise ELSE 0 END), 0) as outflows
         FROM transactions
         WHERE business_id = $1 
           AND account_id = $2
           AND record_status = 'POSTED'
           AND ((occurred_at IS NOT NULL AND occurred_at > $3 AND occurred_at <= $4)
                OR (occurred_at IS NULL AND transaction_date > $3::date AND transaction_date <= $5::date))`,
        [businessId, acc.id, snap.as_of_at, asOfAt.toISOString(), effectiveDateStr]
      );

      const inflows = BigInt(transRes.rows[0]?.inflows || '0');
      const outflows = BigInt(transRes.rows[0]?.outflows || '0');
      const currentAccBalance = snapBalance + inflows - outflows;

      totalPaise += currentAccBalance;

      accountBalances.push({
        account_id: acc.id,
        display_name: acc.display_name,
        snapshot_id: snap.id,
        certainty: snap.certainty,
        balance_paise: currentAccBalance.toString(),
      });
    }

    return {
      as_of_at: asOfAt.toISOString(),
      currency_code: 'INR',
      accounts: accountBalances,
      total_balance_paise: totalPaise.toString(),
      data_quality: accounts.length === 0 ? 'INSUFFICIENT' : dataQuality,
    };
  }
}
