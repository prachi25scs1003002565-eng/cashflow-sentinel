import { Request, Response, NextFunction } from 'express';
import { Database } from '../db';
import { NotFoundError, ForbiddenError, AuthenticationError } from '../utils/errors';
import { getUuidPathParam } from '../utils/request';
import { BusinessesService } from '../modules/businesses/businesses.service';
import { AccountsService } from '../modules/accounts/accounts.service';

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
      if (!req.user) {
        return next(new AuthenticationError('AUTHENTICATION_REQUIRED', 'Authentication required.'));
      }

      const businessIdParam = req.params.businessId;
      let businessId: string | null = null;

      if (typeof businessIdParam === 'string' && businessIdParam.length > 0) {
        businessId = getUuidPathParam(req, 'businessId');
      }

      // Query database for user status & active tenant membership in a single query
      let query = `
        SELECT 
          u.account_status,
          b.id,
          b.name,
          b.minimum_cash_buffer_paise,
          b.timezone,
          b.currency_code,
          bm.role,
          bm.membership_status
        FROM users u
        LEFT JOIN business_memberships bm 
          ON bm.user_id = u.id 
         AND bm.membership_status = 'ACTIVE'
      `;
      const params: any[] = [req.user.id];

      if (businessId) {
        query += ` AND bm.business_id = $2
        LEFT JOIN businesses b 
          ON b.id = bm.business_id 
         AND b.business_status = 'ACTIVE'
        WHERE u.id = $1
        LIMIT 1`;
        params.push(businessId);
      } else {
        query += `
        LEFT JOIN businesses b 
          ON b.id = bm.business_id 
         AND b.business_status = 'ACTIVE'
        WHERE u.id = $1
        ORDER BY (b.id IS NOT NULL) DESC, bm.created_at ASC NULLS LAST
        LIMIT 1`;
      }

      let result = await Database.query(query, params);

      if (result.rows.length === 0) {
        return next(new AuthenticationError('AUTHENTICATION_REQUIRED', 'Authentication required.'));
      }

      const initialRow = result.rows[0];

      // SEC-04: Immediately reject inactive accounts BEFORE any auto-provisioning
      if (initialRow.account_status === 'DISABLED') {
        return next(new AuthenticationError('ACCOUNT_DISABLED', 'Your account has been disabled. Please contact support.'));
      }

      if (initialRow.account_status === 'PENDING_VERIFICATION') {
        return next(new AuthenticationError('ACCOUNT_PENDING_VERIFICATION', 'Your account is pending verification. Please verify your email.'));
      }

      if (initialRow.account_status !== 'ACTIVE') {
        return next(new AuthenticationError('ACCOUNT_DISABLED', 'Your account is not active.'));
      }

      let activeRow = initialRow;

      if (!activeRow.id) {
        if (businessId) {
          // Explicit businessId provided but not accessible to user
          return next(new NotFoundError('BUSINESS_NOT_FOUND', 'Business not found or access denied.'));
        }

        // Auto-provision default business & cash account ONLY for active users without an existing business
        const userRes = await Database.query(
          'SELECT display_name, email FROM users WHERE id = $1',
          [req.user.id]
        );
        const displayName = userRes.rows[0]?.display_name || 'My Business';
        const businessName = `${displayName}'s Business`;

        const newBusiness = await BusinessesService.createBusiness(
          req.user.id,
          {
            name: businessName,
            business_type: 'OTHER',
            currency_code: 'INR',
            timezone: 'Asia/Kolkata',
            minimum_cash_buffer_paise: '0',
          },
          req.id
        );

        await AccountsService.createAccount(
          newBusiness.id,
          req.user.id,
          {
            account_type: 'CASH',
            display_name: 'Cash Drawer',
            currency_code: 'INR',
          },
          req.id
        );

        result = await Database.query(query, params);
        activeRow = result.rows[0];
      }

      if (!activeRow || !activeRow.id) {
        return next(new NotFoundError('BUSINESS_NOT_FOUND', 'Business not found or access denied.'));
      }

      if (requiredRoles && requiredRoles.length > 0 && !requiredRoles.includes(activeRow.role)) {
        return next(new ForbiddenError('ROLE_REQUIRED', `Action requires one of the following roles: ${requiredRoles.join(', ')}`));
      }

      req.business = {
        id: activeRow.id,
        name: activeRow.name,
        role: activeRow.role,
        minimumCashBufferPaise: BigInt(activeRow.minimum_cash_buffer_paise || 0),
        timezone: activeRow.timezone,
        currencyCode: activeRow.currency_code,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}
