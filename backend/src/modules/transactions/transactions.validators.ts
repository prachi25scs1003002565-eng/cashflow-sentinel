import { z } from 'zod';

export const createTransactionSchema = z.object({
  account_id: z.string().uuid().optional(),
  category_id: z.string().uuid().nullable().optional(),
  category: z.string().nullable().optional(),
  data_source_id: z.string().uuid().optional(),
  source_reference: z.string().nullable().optional(),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  occurred_at: z.string().datetime({ offset: true }).optional().nullable(),
  type: z.enum(['income', 'expense', 'INCOME', 'EXPENSE', 'INFLOW', 'OUTFLOW']).optional(),
  transaction_type: z.enum(['INFLOW', 'OUTFLOW', 'OWNER_CONTRIBUTION', 'OWNER_DRAW', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT']).optional(),
  cash_direction: z.enum(['INFLOW', 'OUTFLOW']).optional(),
  amount: z.union([z.number().positive(), z.string().min(1)]).optional(),
  amount_paise: z.string().regex(/^[1-9]\d*$/, 'amount_paise must be a positive integer string').optional(),
  description: z.string().nullable().optional(),
  counterparty_name: z.string().nullable().optional(),
}).superRefine((data, ctx) => {
  if (!data.amount && !data.amount_paise) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Either amount or amount_paise is required.',
      path: ['amount'],
    });
  }
  if (!data.type && !data.cash_direction) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Either type (income/expense) or cash_direction (INFLOW/OUTFLOW) is required.',
      path: ['type'],
    });
  }
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
  amount: z.union([z.number().positive(), z.string().min(1)]).optional(),
  amount_paise: z.string().regex(/^[1-9]\d*$/, 'amount_paise must be a positive integer string').optional(),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  category_id: z.string().uuid().nullable().optional(),
  category: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  counterparty_name: z.string().nullable().optional(),
}).refine((data) => {
  if (data.amount !== undefined) {
    const val = typeof data.amount === 'string' ? parseFloat(data.amount) : data.amount;
    return !isNaN(val) && val > 0;
  }
  return true;
}, {
  message: 'Amount must be greater than zero.',
  path: ['amount'],
});

export const reverseTransactionSchema = z.object({
  reason: z.string().min(3, 'Reversal reason is required'),
  replacement: createTransactionSchema.optional(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type CreateTransferInput = z.infer<typeof createTransferSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ReverseTransactionInput = z.infer<typeof reverseTransactionSchema>;
