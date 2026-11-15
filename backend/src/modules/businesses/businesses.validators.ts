import { z } from 'zod';

export const createBusinessSchema = z.object({
  name: z.string().min(2, 'Business name must be at least 2 characters').trim(),
  business_type: z.enum(['KIRANA', 'APPAREL', 'WHOLESALE', 'OTHER']).optional(),
  city: z.string().optional(),
  currency_code: z.literal('INR').default('INR'),
  timezone: z.string().default('Asia/Kolkata'),
  minimum_cash_buffer_paise: z.string().regex(/^\d+$/, 'minimum_cash_buffer_paise must be a non-negative integer string').default('0'),
});

export const updateBusinessSchema = z.object({
  name: z.string().min(2).trim().optional(),
  city: z.string().optional(),
  timezone: z.string().optional(),
  minimum_cash_buffer_paise: z.string().regex(/^\d+$/, 'must be a non-negative integer string').optional(),
});

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;
export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;
