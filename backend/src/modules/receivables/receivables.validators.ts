import { z } from 'zod';

export const createCustomerSchema = z.object({
  display_name: z.string().min(2, 'Customer name required').trim(),
  external_reference: z.string().nullable().optional(),
  contact_hint: z.string().nullable().optional(),
});

export const createSalesInvoiceSchema = z.object({
  customer_id: z.string().uuid(),
  invoice_number: z.string().min(1, 'invoice_number required').trim(),
  issued_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  total_paise: z.string().regex(/^[1-9]\d*$/, 'total_paise must be a positive integer string'),
  external_reference: z.string().nullable().optional(),
});

export const issueInvoiceSchema = z.object({
  expected_collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expected_date_source: z.enum(['CONTRACT_DUE', 'OWNER_ESTIMATE', 'HISTORICAL_PATTERN']).default('CONTRACT_DUE'),
  expected_certainty: z.enum(['ESTIMATED', 'CONFIRMED']).default('ESTIMATED'),
});

export const updateReceivableSchema = z.object({
  expected_collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expected_date_source: z.enum(['CONTRACT_DUE', 'OWNER_ESTIMATE', 'HISTORICAL_PATTERN']).optional(),
  expected_certainty: z.enum(['ESTIMATED', 'CONFIRMED']).optional(),
  collection_state: z.enum(['OPEN', 'ON_HOLD', 'WRITTEN_OFF', 'CANCELLED']).optional(),
});

export const allocateReceivableSchema = z.object({
  transaction_id: z.string().uuid(),
  amount_paise: z.string().regex(/^[1-9]\d*$/, 'amount_paise must be positive'),
});

export const recordReceivablePaymentSchema = z.object({
  account_id: z.string().uuid(),
  category_id: z.string().uuid().nullable().optional(),
  data_source_id: z.string().uuid().optional(),
  source_reference: z.string().nullable().optional(),
  amount_paise: z.string().regex(/^[1-9]\d*$/, 'amount_paise must be positive'),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  occurred_at: z.string().datetime({ offset: true }).optional().nullable(),
  description: z.string().optional().default('Customer payment allocation'),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type CreateSalesInvoiceInput = z.infer<typeof createSalesInvoiceSchema>;
export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;
export type UpdateReceivableInput = z.infer<typeof updateReceivableSchema>;
export type AllocateReceivableInput = z.infer<typeof allocateReceivableSchema>;
export type RecordReceivablePaymentInput = z.infer<typeof recordReceivablePaymentSchema>;
