import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Invalid email address').transform((val) => val.trim().toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
  display_name: z.string().min(2, 'Display name must be at least 2 characters').trim(),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address').transform((val) => val.trim().toLowerCase()),
  password: z.string().min(1, 'Password is required'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
