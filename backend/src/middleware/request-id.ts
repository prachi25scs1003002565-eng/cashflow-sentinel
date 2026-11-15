import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incomingId = req.header('x-request-id');
  const reqId = incomingId && incomingId.trim().length > 0 
    ? incomingId 
    : `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  req.id = reqId;
  res.setHeader('X-Request-ID', reqId);
  next();
}
