import { Database } from '../db';
import { PoolClient } from 'pg';

export interface AuditEventParams {
  businessId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityName: string;
  entityId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, any>;
}

export class AuditLogger {
  static async log(params: AuditEventParams, client?: PoolClient): Promise<void> {
    const sql = `
      INSERT INTO audit_events (
        business_id, actor_user_id, action, entity_name, entity_id, request_id, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    const values = [
      params.businessId || null,
      params.actorUserId || null,
      params.action,
      params.entityName,
      params.entityId || null,
      params.requestId || null,
      JSON.stringify(params.metadata || {}),
    ];

    try {
      if (client) {
        await client.query(sql, values);
      } else {
        await Database.query(sql, values);
      }
    } catch (err) {
      console.error('Failed to write audit event:', err);
    }
  }
}
