import { z } from 'zod';

export const createAccountSchema = z.object({
  account_type: z.enum(['BANK', 'CASH', 'OTHER']),
  display_name: z.string().min(2, 'display_name required').trim(),
  institution_name: z.string().nullable().optional(),
  currency_code: z.literal('INR').default('INR'),
});

export const createBalanceSnapshotSchema = z.object({
  snapshot_type: z.enum(['OPENING', 'RECONCILIATION', 'IMPORTED_BALANCE']),
  balance_paise: z.string().regex(/^-?\d+$/, 'balance_paise must be a signed integer string'),
  as_of_at: z.string().datetime({ offset: true }),
  certainty: z.enum(['CONFIRMED', 'ESTIMATED']),
  source_data_source_id: z.string().uuid().optional().nullable(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type CreateBalanceSnapshotInput = z.infer<typeof createBalanceSnapshotSchema>;
