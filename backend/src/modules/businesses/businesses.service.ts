import { Database } from '../../db';
import { CreateBusinessInput, UpdateBusinessInput } from './businesses.validators';
import { AuditLogger } from '../../middleware/audit';
import { NotFoundError } from '../../utils/errors';

export class BusinessesService {
  static async createBusiness(userId: string, input: CreateBusinessInput, requestId?: string) {
    return Database.withTransaction(async (client) => {
      // 1. Create business
      const businessRes = await client.query(
        `INSERT INTO businesses (
          name, business_type, city, currency_code, timezone, minimum_cash_buffer_paise, business_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
        RETURNING id, name, business_type, city, currency_code, timezone, minimum_cash_buffer_paise, business_status, created_at, updated_at`,
        [
          input.name,
          input.business_type || null,
          input.city || null,
          input.currency_code,
          input.timezone,
          input.minimum_cash_buffer_paise,
        ]
      );

      const business = businessRes.rows[0];

      // 2. Create OWNER membership
      await client.query(
        `INSERT INTO business_memberships (business_id, user_id, role, membership_status)
         VALUES ($1, $2, 'OWNER', 'ACTIVE')`,
        [business.id, userId]
      );

      // 3. Provision default data sources (MANUAL & CSV)
      await client.query(
        `INSERT INTO data_sources (business_id, source_type, display_name, source_status)
         VALUES 
          ($1, 'MANUAL', 'Owner Direct Entry', 'ACTIVE'),
          ($1, 'CSV', 'Bank Statement Upload', 'ACTIVE')`,
        [business.id]
      );

      // 4. Provision default categories
      await client.query(
        `INSERT INTO transaction_categories (business_id, category_code, display_name, allowed_direction)
         VALUES 
          ($1, 'SALES', 'Sales & Customer Inflow', 'INFLOW'),
          ($1, 'INVENTORY', 'Inventory & Supplies', 'OUTFLOW'),
          ($1, 'RENT', 'Rent', 'OUTFLOW'),
          ($1, 'UTILITIES', 'Utilities & Bills', 'OUTFLOW'),
          ($1, 'OTHER_INFLOW', 'Other Income', 'INFLOW'),
          ($1, 'OTHER_OUTFLOW', 'Other Expense', 'OUTFLOW')`,
        [business.id]
      );

      // 5. Audit creation
      await AuditLogger.log(
        {
          businessId: business.id,
          actorUserId: userId,
          action: 'BUSINESS_CREATED',
          entityName: 'businesses',
          entityId: business.id,
          requestId,
        },
        client
      );

      return {
        id: business.id,
        name: business.name,
        business_type: business.business_type,
        city: business.city,
        currency_code: business.currency_code,
        timezone: business.timezone,
        minimum_cash_buffer_paise: business.minimum_cash_buffer_paise.toString(),
        business_status: business.business_status,
        created_at: business.created_at,
      };
    });
  }

  static async listUserBusinesses(userId: string) {
    const query = `
      SELECT 
        b.id,
        b.name,
        b.business_type,
        b.city,
        b.currency_code,
        b.timezone,
        b.minimum_cash_buffer_paise,
        bm.role,
        bm.membership_status
      FROM businesses b
      JOIN business_memberships bm ON bm.business_id = b.id
      WHERE bm.user_id = $1 
        AND bm.membership_status = 'ACTIVE'
        AND b.business_status = 'ACTIVE'
      ORDER BY b.created_at ASC
    `;

    const res = await Database.query(query, [userId]);
    return res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      business_type: row.business_type,
      city: row.city,
      currency_code: row.currency_code,
      timezone: row.timezone,
      minimum_cash_buffer_paise: row.minimum_cash_buffer_paise.toString(),
      role: row.role,
      membership_status: row.membership_status,
    }));
  }

  static async getBusinessDetails(businessId: string, userId: string) {
    const query = `
      SELECT 
        b.id,
        b.name,
        b.business_type,
        b.city,
        b.currency_code,
        b.timezone,
        b.minimum_cash_buffer_paise,
        b.business_status,
        b.created_at,
        b.updated_at,
        bm.role
      FROM businesses b
      JOIN business_memberships bm ON bm.business_id = b.id
      WHERE b.id = $1 AND bm.user_id = $2 AND bm.membership_status = 'ACTIVE'
    `;

    const res = await Database.query(query, [businessId, userId]);
    if (res.rows.length === 0) {
      throw new NotFoundError('BUSINESS_NOT_FOUND', 'Business not found or access denied.');
    }

    const row = res.rows[0];
    return {
      id: row.id,
      name: row.name,
      business_type: row.business_type,
      city: row.city,
      currency_code: row.currency_code,
      timezone: row.timezone,
      minimum_cash_buffer_paise: row.minimum_cash_buffer_paise.toString(),
      business_status: row.business_status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      role: row.role,
    };
  }

  static async updateBusiness(
    businessId: string,
    userId: string,
    input: UpdateBusinessInput,
    requestId?: string
  ) {
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (input.name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(input.name);
    }
    if (input.city !== undefined) {
      updates.push(`city = $${idx++}`);
      values.push(input.city);
    }
    if (input.timezone !== undefined) {
      updates.push(`timezone = $${idx++}`);
      values.push(input.timezone);
    }
    if (input.minimum_cash_buffer_paise !== undefined) {
      updates.push(`minimum_cash_buffer_paise = $${idx++}`);
      values.push(input.minimum_cash_buffer_paise);
    }

    if (updates.length === 0) {
      return this.getBusinessDetails(businessId, userId);
    }

    updates.push(`updated_at = now()`);
    values.push(businessId);

    const sql = `
      UPDATE businesses
      SET ${updates.join(', ')}
      WHERE id = $${idx}
      RETURNING id, name, business_type, city, currency_code, timezone, minimum_cash_buffer_paise, business_status, created_at, updated_at
    `;

    const res = await Database.query(sql, values);
    const updated = res.rows[0];

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'BUSINESS_UPDATED',
      entityName: 'businesses',
      entityId: businessId,
      requestId,
      metadata: input,
    });

    return {
      id: updated.id,
      name: updated.name,
      business_type: updated.business_type,
      city: updated.city,
      currency_code: updated.currency_code,
      timezone: updated.timezone,
      minimum_cash_buffer_paise: updated.minimum_cash_buffer_paise.toString(),
      business_status: updated.business_status,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    };
  }

  static async listMemberships(businessId: string) {
    const query = `
      SELECT 
        bm.id,
        bm.user_id,
        u.display_name,
        u.email,
        bm.role,
        bm.membership_status,
        bm.invited_by_user_id,
        bm.created_at
      FROM business_memberships bm
      JOIN users u ON u.id = bm.user_id
      WHERE bm.business_id = $1
      ORDER BY bm.created_at ASC
    `;

    const res = await Database.query(query, [businessId]);
    return res.rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      display_name: row.display_name,
      email: row.email,
      role: row.role,
      membership_status: row.membership_status,
      invited_by_user_id: row.invited_by_user_id,
      created_at: row.created_at,
    }));
  }
}
