import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AuthenticationError } from '../utils/errors';

export interface AuthUser {
  id: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.header('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AuthenticationError('AUTHENTICATION_REQUIRED', 'Bearer authorization token required.'));
  }

  const token = authHeader.substring(7).trim();

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as any;
    req.user = {
      id: payload.sub,
      email: payload.email,
    };
    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      return next(new AuthenticationError('TOKEN_EXPIRED', 'Your session token has expired. Please log in again.'));
    }
    return next(new AuthenticationError('AUTHENTICATION_REQUIRED', 'Invalid authentication token.'));
  }
}
