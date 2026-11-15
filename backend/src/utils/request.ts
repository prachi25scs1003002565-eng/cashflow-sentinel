import type { Request } from 'express';
import { z } from 'zod';
import { ValidationError } from './errors';

const uuidSchema = z.string().uuid();

export function getUuidPathParam(req: Request, name: string): string {
  const value = req.params[name];

  if (typeof value !== 'string') {
    throw new ValidationError(`Path parameter "${name}" must be a UUID.`, [
      { field: name, issue: 'must_be_single_uuid' },
    ]);
  }

  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`Path parameter "${name}" must be a UUID.`, [
      { field: name, issue: 'invalid_uuid' },
    ]);
  }

  return parsed.data;
}
