import { z } from 'zod';

export const generateForecastSchema = z.object({
  horizon_days: z.coerce.number().int().min(1).max(90).default(30),
  as_of_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'as_of_date must be formatted as YYYY-MM-DD')
    .optional(),
});

export type GenerateForecastInput = z.infer<typeof generateForecastSchema>;
