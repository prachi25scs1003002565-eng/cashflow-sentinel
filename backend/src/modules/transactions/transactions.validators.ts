import { z } from 'zod';

export const createTransactionSchema = z.object({
  account_id: z.string().uuid(),
  category_id: z.string().uuid().nullable().optional(),
  data_source_id: z.string().uuid(),
  source_reference: z.string().nullable().optional(),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  occurred_at: z.string().datetime({ offset: true }).optional().nullable(),
  transaction_type: z.enum(['INFLOW', 'OUTFLOW', 'OWNER_CONTRIBUTION', 'OWNER_DRAW', 'ADJUSTMENT']),
  cash_direction: z.enum(['INFLOW', 'OUTFLOW']),
  amount_paise: z.string().regex(/^[1-9]\d*$/, 'amount_paise must be a positive integer string'),
  description: z.string().nullable().optional(),
  counterparty_name: z.string().nullable().optional(),
});

export const createTransferSchema = z.object({
  outgoing_account_id: z.string().uuid(),
  incoming_account_id: z.string().uuid(),
  data_source_id: z.string().uuid().optional(),
  amount_paise: z.string().regex(/^[1-9]\d*$/, 'amount_paise must be a positive integer string'),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  occurred_at: z.string().datetime({ offset: true }).optional().nullable(),
  description: z.string().optional().default('Account Transfer'),
});

export const updateTransactionSchema = z.object({
  category_id: z.string().uuid().nullable().optional(),
  description: z.string().nullable().optional(),
  counterparty_name: z.string().nullable().optional(),
});

export const reverseTransactionSchema = z.object({
  reason: z.string().min(3, 'Reversal reason is required'),
  replacement: createTransactionSchema.optional(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type CreateTransferInput = z.infer<typeof createTransferSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ReverseTransactionInput = z.infer<typeof reverseTransactionSchema>;
