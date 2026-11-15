import { Request, Response, NextFunction } from 'express';
import { Database } from '../db';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { getUuidPathParam } from '../utils/request';

export interface BusinessContext {
  id: string;
  name: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  minimumCashBufferPaise: bigint;
  timezone: string;
  currencyCode: string;
}

declare global {
  namespace Express {
    interface Request {
      business?: BusinessContext;
    }
  }
}

export function tenantIsolationMiddleware(requiredRoles?: Array<'OWNER' | 'ADMIN' | 'MEMBER'>) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const businessIdParam = req.params.businessId;

      if (typeof businessIdParam !== 'string' || businessIdParam.length === 0) {
        return next(new NotFoundError('BUSINESS_NOT_FOUND', 'Business ID required.'));
      }
      const businessId = getUuidPathParam(req, 'businessId');

      if (!req.user) {
        return next(new NotFoundError('BUSINESS_NOT_FOUND', 'Authentication required.'));
      }

      // Query database for active membership
      const query = `
        SELECT 
          b.id,
          b.name,
          b.minimum_cash_buffer_paise,
          b.timezone,
          b.currency_code,
          bm.role,
          bm.membership_status
        FROM businesses b
        JOIN business_memberships bm ON bm.business_id = b.id
        WHERE b.id = $1 
          AND bm.user_id = $2 
          AND bm.membership_status = 'ACTIVE'
          AND b.business_status = 'ACTIVE'
      `;

      const result = await Database.query(query, [businessId, req.user.id]);

      if (result.rows.length === 0) {
        // Return 404 to avoid disclosing whether business exists to unauthorized users
        return next(new NotFoundError('BUSINESS_NOT_FOUND', 'Business not found or access denied.'));
      }

      const row = result.rows[0];

      if (requiredRoles && requiredRoles.length > 0 && !requiredRoles.includes(row.role)) {
        return next(new ForbiddenError('ROLE_REQUIRED', `Action requires one of the following roles: ${requiredRoles.join(', ')}`));
      }

      req.business = {
        id: row.id,
        name: row.name,
        role: row.role,
        minimumCashBufferPaise: BigInt(row.minimum_cash_buffer_paise),
        timezone: row.timezone,
        currencyCode: row.currency_code,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}
