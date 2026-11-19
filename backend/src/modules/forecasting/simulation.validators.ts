import { z } from 'zod';
import { ValidationError } from '../../utils/errors';

export const ScenarioTypeEnum = z.enum([
  'DELAYED_RECEIPT',
  'EARLIER_RECEIPT',
  'NEW_PURCHASE',
  'EXPENSE_CHANGE',
  'MANUAL_CASH_MOVEMENT',
]);

export type ScenarioType = z.infer<typeof ScenarioTypeEnum>;

export function isValidIsoDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

const isoDateSchema = z
  .string()
  .refine(isValidIsoDate, { message: 'Must be a valid ISO calendar date in YYYY-MM-DD format.' });

export const simulationInputSchema = z
  .object({
    baseline_forecast_id: z.string().uuid().optional(),
    scenario_type: ScenarioTypeEnum,
    amount: z.union([z.number(), z.string()]).optional(),
    amount_paise: z.union([z.string(), z.number()]).optional(),
    date: isoDateSchema.optional(),
    original_date: isoDateSchema.optional(),
    new_date: isoDateSchema.optional(),
    delay_days: z.coerce.number().int().min(1, 'delay_days must be at least 1').optional(),
    direction: z.enum(['INFLOW', 'OUTFLOW']).optional(),
    description: z.string().max(255).optional(),
    label: z.string().max(255).optional(),
    target_id: z.string().optional(),
    assumptions: z
      .array(
        z.object({
          assumption_type: ScenarioTypeEnum,
          target_id: z.string().optional(),
          target_type: z.string().optional(),
          amount_delta_paise: z.string().optional(),
          date_override: isoDateSchema.optional(),
          assumption_label: z.string().optional(),
          assumption_snapshot: z.record(z.unknown()).optional(),
        })
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    // If explicit assumptions array is provided and non-empty, individual scenario validation is bypassed
    if (data.assumptions && data.assumptions.length > 0) {
      return;
    }

    // Resolve amount in paise
    let paise: bigint | null = null;
    if (data.amount_paise !== undefined) {
      try {
        paise = BigInt(Math.round(Number(data.amount_paise)));
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amount_paise'],
          message: 'Invalid amount_paise format.',
        });
        return;
      }
    } else if (data.amount !== undefined) {
      const num = typeof data.amount === 'string' ? parseFloat(data.amount) : data.amount;
      if (isNaN(num)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amount'],
          message: 'Amount must be a valid number.',
        });
        return;
      }
      paise = BigInt(Math.round(num * 100));
    }

    // Scenario-specific validations
    switch (data.scenario_type) {
      case 'DELAYED_RECEIPT': {
        if (paise === null || paise <= 0n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['amount'],
            message: 'Amount must be greater than zero for delayed receipt.',
          });
        }
        if (!data.original_date) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['original_date'],
            message: 'original_date is required for DELAYED_RECEIPT.',
          });
        }
        const effectiveNewDate = data.new_date || data.date;
        if (!effectiveNewDate && data.delay_days === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['new_date'],
            message: 'Either new_date (or date) or delay_days is required for DELAYED_RECEIPT.',
          });
        }
        if (data.original_date && effectiveNewDate && effectiveNewDate <= data.original_date) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['new_date'],
            message: 'new_date must be after original_date for DELAYED_RECEIPT.',
          });
        }
        break;
      }

      case 'EARLIER_RECEIPT': {
        if (paise === null || paise <= 0n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['amount'],
            message: 'Amount must be greater than zero for earlier receipt.',
          });
        }
        const effectiveNewDate = data.new_date || data.date;
        if (!effectiveNewDate) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['date'],
            message: 'date (or new_date) is required for EARLIER_RECEIPT.',
          });
        }
        if (data.original_date && effectiveNewDate && effectiveNewDate >= data.original_date) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['date'],
            message: 'New date must be earlier than original_date for EARLIER_RECEIPT.',
          });
        }
        break;
      }

      case 'NEW_PURCHASE': {
        if (paise === null || paise <= 0n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['amount'],
            message: 'Amount must be greater than zero for new purchase.',
          });
        }
        if (!data.date && !data.new_date) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['date'],
            message: 'date is required for NEW_PURCHASE.',
          });
        }
        break;
      }

      case 'EXPENSE_CHANGE': {
        if (paise === null || paise === 0n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['amount'],
            message: 'Amount delta must be non-zero for expense change.',
          });
        }
        if (!data.date && !data.new_date) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['date'],
            message: 'date is required for EXPENSE_CHANGE.',
          });
        }
        break;
      }

      case 'MANUAL_CASH_MOVEMENT': {
        if (paise === null || paise <= 0n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['amount'],
            message: 'Amount must be greater than zero for manual cash movement.',
          });
        }
        if (!data.date && !data.new_date) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['date'],
            message: 'date is required for MANUAL_CASH_MOVEMENT.',
          });
        }
        break;
      }
    }
  });

export type SimulationInput = z.infer<typeof simulationInputSchema>;
