import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  API_BASE_URL: z.string().url().default('http://localhost:5000/api/v1'),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.coerce.number().int().positive().default(900),
  ANALYTICS_SERVICE_URL: z.string().url().default('http://127.0.0.1:8000'),
  ANALYTICS_SERVICE_TOKEN: z.string().min(32),
  ANALYTICS_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DATABASE_URL: z.string().min(1).optional(),
  DB_HOST: z.string().min(1).optional(),
  DB_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  DB_NAME: z.string().min(1).optional(),
  DB_USER: z.string().min(1).optional(),
  DB_PASSWORD: z.string().optional(),
  DB_SSL: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .or(z.boolean())
    .default(false),
  DB_SSL_REJECT_UNAUTHORIZED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .or(z.boolean())
    .default(true),
  DB_SSL_CA: z.string().optional(),
  DB_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
}).superRefine((value, context) => {
  const hasDatabaseUrl = Boolean(value.DATABASE_URL && value.DATABASE_URL.trim().length > 0);
  const hasIndividualVars = Boolean(
    value.DB_HOST &&
    value.DB_PORT &&
    value.DB_NAME &&
    value.DB_USER &&
    value.DB_PASSWORD !== undefined
  );

  if (!hasDatabaseUrl && !hasIndividualVars) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message:
        'Database configuration missing: Provide either DATABASE_URL or all individual parameters (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD).',
    });
  }
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

let effectiveDatabaseUrl = parsedEnvironment.data.DATABASE_URL?.trim();

if (!effectiveDatabaseUrl) {
  const databaseUrl = new URL('postgresql://localhost');
  databaseUrl.hostname = parsedEnvironment.data.DB_HOST!;
  databaseUrl.port = String(parsedEnvironment.data.DB_PORT!);
  databaseUrl.username = encodeUrlComponent(parsedEnvironment.data.DB_USER!);
  databaseUrl.password = encodeUrlComponent(parsedEnvironment.data.DB_PASSWORD || '');
  databaseUrl.pathname = `/${encodeUrlComponent(parsedEnvironment.data.DB_NAME!)}`;
  effectiveDatabaseUrl = databaseUrl.toString();
}

// Auto-detect SSL requirement from connection string parameters if not explicitly configured
const urlDemandsSsl =
  /sslmode=(require|verify-ca|verify-full)/i.test(effectiveDatabaseUrl) ||
  /[?&]ssl=true/i.test(effectiveDatabaseUrl);
const effectiveDbSsl = parsedEnvironment.data.DB_SSL || urlDemandsSsl;

let resolvedDbHost = parsedEnvironment.data.DB_HOST;
let resolvedDbPort = parsedEnvironment.data.DB_PORT;
let resolvedDbName = parsedEnvironment.data.DB_NAME;
let resolvedDbUser = parsedEnvironment.data.DB_USER;

try {
  const parsed = new URL(effectiveDatabaseUrl);
  resolvedDbHost = resolvedDbHost || parsed.hostname;
  resolvedDbPort = resolvedDbPort || (parsed.port ? parseInt(parsed.port, 10) : 5432);
  resolvedDbName = resolvedDbName || decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  resolvedDbUser = resolvedDbUser || decodeURIComponent(parsed.username);
} catch {
  // Fallback to defaults if URL parsing fails
}

export const env = Object.freeze({
  ...parsedEnvironment.data,
  DB_HOST: resolvedDbHost || 'localhost',
  DB_PORT: resolvedDbPort || 5432,
  DB_NAME: resolvedDbName || 'cashflow_sentinel',
  DB_USER: resolvedDbUser || 'postgres',
  DB_PASSWORD: parsedEnvironment.data.DB_PASSWORD || '',
  DB_SSL: effectiveDbSsl,
  DB_SSL_REJECT_UNAUTHORIZED: parsedEnvironment.data.DB_SSL_REJECT_UNAUTHORIZED,
  DB_SSL_CA: parsedEnvironment.data.DB_SSL_CA,
  DATABASE_URL: effectiveDatabaseUrl,
});
