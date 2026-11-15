import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { ZodError } from 'zod';

export function errorHandlerMiddleware(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const requestId = req.id || `req_${Date.now()}`;

  // Log non-validation server errors
  if (!(err instanceof AppError && err.statusCode < 500)) {
    console.error(`[${requestId}] Internal Error:`, err);
  }

  // Handle known domain AppError
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      request_id: requestId,
    });
  }

  // Handle Zod schema validation errors
  if (err instanceof ZodError) {
    const details = err.errors.map((e) => ({
      field: e.path.join('.'),
      issue: e.message || 'invalid_value',
    }));

    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'One or more fields are invalid.',
        details,
      },
      request_id: requestId,
    });
  }

  // Handle PostgreSQL unique constraint violations (code 23505)
  if ((err as any).code === '23505') {
    return res.status(409).json({
      error: {
        code: 'STATE_CONFLICT',
        message: 'A resource with this key or identifier already exists.',
      },
      request_id: requestId,
    });
  }

  // Handle PostgreSQL foreign key violations (code 23503)
  if ((err as any).code === '23503') {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Referenced entity does not exist or does not belong to this business.',
      },
      request_id: requestId,
    });
  }

  // Default internal server error (500)
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred. Please try again.',
    },
    request_id: requestId,
  });
}
