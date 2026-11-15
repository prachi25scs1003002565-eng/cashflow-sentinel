import { Database } from '../../db';
import { z } from 'zod';
import { AuditLogger } from '../../middleware/audit';

export const createCategorySchema = z.object({
  category_code: z.string().min(2).max(50).toUpperCase().trim(),
  display_name: z.string().min(2).trim(),
  allowed_direction: z.enum(['INFLOW', 'OUTFLOW', 'BOTH']),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export class CategoriesAndSourcesService {
  static async listCategories(businessId: string, isActive?: boolean) {
    let query = `
      SELECT id, category_code, display_name, allowed_direction, is_active
      FROM transaction_categories
      WHERE business_id = $1
    `;
    const params: any[] = [businessId];

    if (isActive !== undefined) {
      query += ` AND is_active = $2`;
      params.push(isActive);
    }

    query += ` ORDER BY display_name ASC`;
    const res = await Database.query(query, params);
    return res.rows;
  }

  static async createCategory(
    businessId: string,
    userId: string,
    input: CreateCategoryInput,
    requestId?: string
  ) {
    const query = `
      INSERT INTO transaction_categories (business_id, category_code, display_name, allowed_direction, is_active)
      VALUES ($1, $2, $3, $4, true)
      RETURNING id, category_code, display_name, allowed_direction, is_active
    `;

    const res = await Database.query(query, [
      businessId,
      input.category_code,
      input.display_name,
      input.allowed_direction,
    ]);

    const cat = res.rows[0];

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'CATEGORY_CREATED',
      entityName: 'transaction_categories',
      entityId: cat.id,
      requestId,
      metadata: input,
    });

    return cat;
  }

  static async listDataSources(businessId: string, status?: string) {
    let query = `
      SELECT id, source_type, display_name, provider_name, source_status
      FROM data_sources
      WHERE business_id = $1
    `;
    const params: any[] = [businessId];

    if (status) {
      query += ` AND source_status = $2`;
      params.push(status);
    }

    query += ` ORDER BY created_at ASC`;
    const res = await Database.query(query, params);
    return res.rows;
  }
}
