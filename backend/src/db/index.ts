import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env';

// Configure node-postgres to return BIGINT (type 20) as string to prevent 64-bit float loss
import { types } from 'pg';
types.setTypeParser(20, (val: string) => val); // return as string

export class Database {
  private static pool: Pool | null = null;
  private static isMockMode = false;

  static getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: env.DATABASE_URL,
        min: env.DB_POOL_MIN,
        max: env.DB_POOL_MAX,
        idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
      });

      this.pool.on('error', (err) => {
        console.error('Unexpected PostgreSQL client error:', err);
      });
    }
    return this.pool;
  }

  static async query<T extends QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<QueryResult<T>> {
    const pool = this.getPool();
    try {
      return await pool.query<T>(text, params);
    } catch (error: any) {
      // Re-throw with enriched message for debugging
      throw error;
    }
  }

  static async withTransaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const pool = this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async testConnection(): Promise<boolean> {
    try {
      const res = await this.query('SELECT 1 as connected');
      return res.rows[0]?.connected === 1;
    } catch (err) {
      return false;
    }
  }

  static async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
