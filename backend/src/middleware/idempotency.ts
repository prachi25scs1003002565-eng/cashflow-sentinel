import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Database } from '../db';
import { ConflictError, ValidationError } from '../utils/errors';

export function idempotencyMiddleware(required = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('idempotency-key');

    if (!key) {
      if (required) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Idempotency-Key header is required for this operation.',
          },
          request_id: req.id,
        });
      }
      return next();
    }

    const userId = req.user?.id;
    if (!userId) {
      return next();
    }

    const businessIdParam = req.params.businessId;
    if (Array.isArray(businessIdParam)) {
      return next(new ValidationError('Business path parameter must be a single identifier.'));
    }
    const businessId = businessIdParam || null;
    const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
    const payloadString = JSON.stringify({ body: req.body, query: req.query });
    const requestHash = crypto.createHash('sha256').update(payloadString).digest('hex');

    try {
      // Check existing idempotency key
      const query = `
        SELECT status, request_hash, response_code, response_body
        FROM idempotency_keys
        WHERE business_id IS NOT DISTINCT FROM $1 AND idempotency_key = $2 AND expires_at > now()
      `;
      const result = await Database.query(query, [businessId, key]);

      if (result.rows.length > 0) {
        const record = result.rows[0];

        // Mismatched payload: conflict
        if (record.request_hash !== requestHash) {
          return next(new ConflictError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different request payload.'));
        }

        // Still pending
        if (record.status === 'PENDING') {
          return next(new ConflictError('IDEMPOTENCY_CONFLICT', 'A request with this idempotency key is currently processing.'));
        }

        // Return completed cached response
        if (record.status === 'COMPLETED' && record.response_code) {
          return res.status(record.response_code).json(record.response_body);
        }
      }

      // Record pending key
      const insertSql = `
        INSERT INTO idempotency_keys (
          business_id, user_id, idempotency_key, endpoint, request_hash, status, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, 'PENDING', now() + interval '24 hours')
        ON CONFLICT (business_id, idempotency_key) DO NOTHING
      `;
      await Database.query(insertSql, [businessId, userId, key, endpoint, requestHash]);

      // Hook response.json to store the result on completion
      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          Database.query(
            `UPDATE idempotency_keys
             SET status = 'COMPLETED', response_code = $1, response_body = $2
             WHERE business_id IS NOT DISTINCT FROM $3 AND idempotency_key = $4`,
            [res.statusCode, JSON.stringify(body), businessId, key]
          ).catch((e) => console.error('Failed to update idempotency key:', e));
        } else {
          Database.query(
            `UPDATE idempotency_keys
             SET status = 'FAILED', response_code = $1
             WHERE business_id IS NOT DISTINCT FROM $2 AND idempotency_key = $3`,
            [res.statusCode, businessId, key]
          ).catch((e) => console.error('Failed to update idempotency key on failure:', e));
        }
        return originalJson(body);
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}
