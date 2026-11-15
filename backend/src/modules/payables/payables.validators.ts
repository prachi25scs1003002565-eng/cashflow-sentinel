import { z } from 'zod';

export const createSupplierSchema = z.object({
  display_name: z.string().min(2, 'Supplier name required').trim(),
  external_reference: z.string().nullable().optional(),
  contact_hint: z.string().nullable().optional(),
});

export const createSupplierBillSchema = z.object({
  supplier_id: z.string().uuid(),
  bill_number: z.string().min(1, 'bill_number required').trim(),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  total_paise: z.string().regex(/^[1-9]\d*$/, 'total_paise must be a positive integer string'),
  external_reference: z.string().nullable().optional(),
});

export const receiveBillSchema = z.object({
  expected_payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expected_date_source: z.enum(['CONTRACT_DUE', 'OWNER_ESTIMATE']).default('CONTRACT_DUE'),
  expected_certainty: z.enum(['ESTIMATED', 'CONFIRMED']).default('CONFIRMED'),
});

export const updatePayableSchema = z.object({
  expected_payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expected_date_source: z.enum(['CONTRACT_DUE', 'OWNER_ESTIMATE']).optional(),
  expected_certainty: z.enum(['ESTIMATED', 'CONFIRMED']).optional(),
  payment_state: z.enum(['OPEN', 'ON_HOLD', 'DISPUTED', 'WRITTEN_OFF', 'CANCELLED']).optional(),
});

export const allocatePayableSchema = z.object({
  transaction_id: z.string().uuid(),
  amount_paise: z.string().regex(/^[1-9]\d*$/, 'amount_paise must be positive'),
});

export const recordPayablePaymentSchema = z.object({
  account_id: z.string().uuid(),
  category_id: z.string().uuid().nullable().optional(),
  data_source_id: z.string().uuid().optional(),
  source_reference: z.string().nullable().optional(),
  amount_paise: z.string().regex(/^[1-9]\d*$/, 'amount_paise must be positive'),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  occurred_at: z.string().datetime({ offset: true }).optional().nullable(),
  description: z.string().optional().default('Supplier bill payment allocation'),
});

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type CreateSupplierBillInput = z.infer<typeof createSupplierBillSchema>;
export type ReceiveBillInput = z.infer<typeof receiveBillSchema>;
export type UpdatePayableInput = z.infer<typeof updatePayableSchema>;
export type AllocatePayableInput = z.infer<typeof allocatePayableSchema>;
export type RecordPayablePaymentInput = z.infer<typeof recordPayablePaymentSchema>;
