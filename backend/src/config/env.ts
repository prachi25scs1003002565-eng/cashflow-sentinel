import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  API_BASE_URL: z.string().url().default('http://localhost:5000/api/v1'),
  CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.coerce.number().int().positive().default(900),
  ANALYTICS_SERVICE_URL: z.string().url().default('http://127.0.0.1:8000'),
  ANALYTICS_SERVICE_TOKEN: z.string().min(32),
  ANALYTICS_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
}).superRefine((value, context) => {
  if (value.DB_POOL_MIN > value.DB_POOL_MAX) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DB_POOL_MIN'],
      message: 'Must not exceed DB_POOL_MAX',
    });
  }

  if (value.NODE_ENV === 'production' && (
    value.JWT_SECRET.startsWith('replace_with_') ||
    value.ANALYTICS_SERVICE_TOKEN.startsWith('replace_with_')
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_SECRET'],
      message: 'Production secrets must be replaced with unique generated values',
    });
  }
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const issues = parsedEnvironment.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid backend environment configuration: ${issues}`);
}

function encodeUrlComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

const databaseUrl = new URL('postgresql://localhost');
databaseUrl.hostname = parsedEnvironment.data.DB_HOST;
databaseUrl.port = String(parsedEnvironment.data.DB_PORT);
databaseUrl.username = encodeUrlComponent(parsedEnvironment.data.DB_USER);
databaseUrl.password = encodeUrlComponent(parsedEnvironment.data.DB_PASSWORD);
databaseUrl.pathname = `/${encodeUrlComponent(parsedEnvironment.data.DB_NAME)}`;

export const env = Object.freeze({
  ...parsedEnvironment.data,
  DATABASE_URL: databaseUrl.toString(),
});
