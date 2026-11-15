import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { PoolClient } from 'pg';
import { Database } from './index';
import {
  MigrationSource,
  SchemaDefinition,
  SchemaVerificationError,
  normalizeSql,
  parseSchemaDefinition,
  verifyFreshDatabase,
  verifySchema,
} from './schema-verifier';

const MIGRATIONS = [
  {
    version: '001_initial_schema.sql',
    checksum: '4116e33791e607164d7af823fb8de0835f61db4470e297637f06760e3b0bc96a',
  },
  {
    version: '002_triggers_and_checks.sql',
    checksum: '91dd72e26e33363356ce4d2f12ade47946f7aeedfc69504838a140614e45b0bd',
  },
] as const;

const ADVISORY_LOCK_CLASS = 0x434653;
const ADVISORY_LOCK_ID = 1;
const LEDGER_TABLE = 'schema_migrations';

interface MigrationDatabase {
  withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
}

interface LedgerEntry {
  version: string;
  checksum: string;
  applied_at: Date | string;
}

interface CatalogRow extends Record<string, unknown> {
  schema_name?: string;
  object_name?: string;
  relkind?: string;
  relpersistence?: string;
}

function migrationDirectory(): string {
  return path.resolve(__dirname, '../../../database/migrations');
}

export function loadMigrationSources(directory = migrationDirectory()): MigrationSource[] {
  return MIGRATIONS.map(({ version, checksum }) => {
    const filePath = path.join(directory, version);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Migration file not found: ${version}`);
    }

    const sql = fs.readFileSync(filePath, 'utf8');
    const actualChecksum = createHash('sha256').update(sql, 'utf8').digest('hex');
    if (actualChecksum !== checksum) {
      throw new Error(`Migration checksum mismatch: ${version}`);
    }
    return { version, sql };
  });
}

async function queryRows(client: PoolClient, sql: string, parameters: unknown[] = []): Promise<CatalogRow[]> {
  const result = await client.query(sql, parameters);
  return result.rows as CatalogRow[];
}

async function ledgerExists(client: PoolClient): Promise<boolean> {
  const rows = await queryRows(client, `
    SELECT n.nspname AS schema_name, c.relkind, c.relpersistence
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = $1 AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
  `, [LEDGER_TABLE]);

  if (rows.length === 0) return false;
  if (rows.length !== 1 ||
      rows[0].schema_name !== 'public' ||
      rows[0].relkind !== 'r' ||
      rows[0].relpersistence !== 'p') {
    throw new Error('Invalid schema_migrations object; refusing to continue');
  }
  return true;
}

async function validateLedger(client: PoolClient): Promise<void> {
  const columns = await queryRows(client, `
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null, a.attcollation = t.typcollation AS default_collation,
           a.attidentity AS identity_kind, a.attgenerated AS generated_kind,
           pg_get_expr(d.adbin, d.adrelid) AS default_value
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname = $1
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `, [LEDGER_TABLE]);

  const expectedColumns = [
    { name: 'version', data_type: 'text', not_null: true, default_collation: true, identity_kind: '', generated_kind: '', default_value: null },
    { name: 'checksum', data_type: 'character(64)', not_null: true, default_collation: true, identity_kind: '', generated_kind: '', default_value: null },
    { name: 'applied_at', data_type: 'timestamp with time zone', not_null: true, default_collation: true, identity_kind: '', generated_kind: '', default_value: 'now()' },
  ];
  if (columns.length !== expectedColumns.length || expectedColumns.some((expected) => {
    const actual = columns.find((column) => column.name === expected.name);
    return !actual ||
      actual.data_type !== expected.data_type ||
      actual.not_null !== expected.not_null ||
      actual.default_collation !== expected.default_collation ||
      actual.identity_kind !== expected.identity_kind ||
      actual.generated_kind !== expected.generated_kind ||
      (expected.default_value === null
        ? actual.default_value !== null
        : normalizeSql(String(actual.default_value)) !== normalizeSql(expected.default_value));
  })) {
    throw new Error('Invalid schema_migrations columns; refusing to continue');
  }

  const constraints = await queryRows(client, `
    SELECT con.conname AS name, con.contype AS constraint_type, con.convalidated AS validated,
           con.condeferrable AS deferrable, con.condeferred AS initially_deferred,
           pg_get_constraintdef(con.oid, false) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1 AND con.contype <> 'n'
  `, [LEDGER_TABLE]);
  if (constraints.length !== 1 ||
      constraints[0].name !== 'schema_migrations_pkey' ||
      constraints[0].constraint_type !== 'p' ||
      constraints[0].validated !== true ||
      constraints[0].deferrable !== false ||
      constraints[0].initially_deferred !== false ||
      normalizeSql(String(constraints[0].definition)) !== normalizeSql('PRIMARY KEY (version)')) {
    throw new Error('Invalid schema_migrations constraints; refusing to continue');
  }

  const indexes = await queryRows(client, `
    SELECT irel.relname AS name, pg_get_indexdef(i.indexrelid, 0, false) AS definition,
           i.indisunique AS is_unique, i.indisvalid AS is_valid, i.indisready AS is_ready,
           i.indisprimary AS is_primary, i.indimmediate AS is_immediate, i.indislive AS is_live,
           am.amname AS access_method
    FROM pg_index i
    JOIN pg_class irel ON irel.oid = i.indexrelid
    JOIN pg_class table_rel ON table_rel.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = table_rel.relnamespace
    JOIN pg_am am ON am.oid = irel.relam
    WHERE n.nspname = 'public' AND table_rel.relname = $1
  `, [LEDGER_TABLE]);
  if (indexes.length !== 1 ||
      indexes[0].name !== 'schema_migrations_pkey' ||
      indexes[0].is_unique !== true ||
      indexes[0].is_valid !== true ||
      indexes[0].is_ready !== true ||
      indexes[0].is_primary !== true ||
      indexes[0].is_immediate !== true ||
      indexes[0].is_live !== true ||
      indexes[0].access_method !== 'btree' ||
      normalizeSql(String(indexes[0].definition)) !== normalizeSql(
        'CREATE UNIQUE INDEX schema_migrations_pkey ON public.schema_migrations USING btree (version)'
      )) {
    throw new Error('Invalid schema_migrations indexes; refusing to continue');
  }

  const triggers = await queryRows(client, `
    SELECT t.tgname AS name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1 AND NOT t.tgisinternal
  `, [LEDGER_TABLE]);
  if (triggers.length) {
    throw new Error('Unexpected schema_migrations triggers; refusing to continue');
  }
}

async function createLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE public.schema_migrations (
      version text PRIMARY KEY,
      checksum character(64) NOT NULL,
      applied_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await validateLedger(client);
}

async function readLedger(client: PoolClient): Promise<LedgerEntry[]> {
  const result = await client.query<LedgerEntry>(`
    SELECT version, checksum, applied_at
    FROM public.schema_migrations
    ORDER BY version
  `);
  return result.rows;
}

function validateHistory(entries: LedgerEntry[]): number {
  if (entries.length > MIGRATIONS.length) {
    throw new Error('Unknown migration history; refusing to continue');
  }

  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expected = MIGRATIONS[index];
    if (seen.has(entry.version) ||
        !expected ||
        entry.version !== expected.version ||
        entry.checksum.trim() !== expected.checksum ||
        !entry.applied_at) {
      throw new Error('Inconsistent migration history or checksum; refusing to continue');
    }
    seen.add(entry.version);
  }
  return entries.length;
}

function appliedDefinition(sources: MigrationSource[], count: number): SchemaDefinition {
  return parseSchemaDefinition(sources.slice(0, count));
}

async function verifyAppliedState(
  client: PoolClient,
  sources: MigrationSource[],
  appliedCount: number
): Promise<void> {
  if (appliedCount === 0) {
    await verifyFreshDatabase(client);
    return;
  }
  await verifySchema(client, appliedDefinition(sources, appliedCount), appliedCount >= 2);
}

async function insertLedgerEntry(client: PoolClient, source: MigrationSource): Promise<void> {
  const migration = MIGRATIONS.find((item) => item.version === source.version);
  if (!migration) throw new Error('Unknown migration source; refusing to continue');
  await client.query(
    'INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)',
    [migration.version, migration.checksum]
  );
}

async function baselineExistingSchema(
  client: PoolClient,
  sources: MigrationSource[]
): Promise<number> {
  try {
    await verifySchema(client, appliedDefinition(sources, 1), false);
    return 1;
  } catch (error) {
    if (!(error instanceof SchemaVerificationError)) throw error;
  }

  await verifySchema(client, appliedDefinition(sources, 2), true);
  return 2;
}

export async function runMigrations(
  database: MigrationDatabase = Database,
  directory = migrationDirectory()
): Promise<void> {
  const sources = loadMigrationSources(directory);

  await database.withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      ADVISORY_LOCK_CLASS,
      ADVISORY_LOCK_ID,
    ]);
    await client.query('SET LOCAL search_path TO public');

    const hasLedger = await ledgerExists(client);
    let appliedCount: number;

    if (hasLedger) {
      await validateLedger(client);
      appliedCount = validateHistory(await readLedger(client));
      await verifyAppliedState(client, sources, appliedCount);
    } else {
      try {
        await verifyFreshDatabase(client);
        appliedCount = 0;
      } catch (error) {
        if (!(error instanceof SchemaVerificationError)) throw error;
        appliedCount = await baselineExistingSchema(client, sources);
      }

      await createLedger(client);
      for (const source of sources.slice(0, appliedCount)) {
        await insertLedgerEntry(client, source);
      }
    }

    for (let index = appliedCount; index < sources.length; index += 1) {
      const source = sources[index];
      await client.query(source.sql);
      await verifySchema(client, appliedDefinition(sources, index + 1), index + 1 >= 2);
      await insertLedgerEntry(client, source);
    }
  });
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('Migration process completed.');
      process.exit(0);
    })
    .catch((error: unknown) => {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`Migration failed (${errorName}). No migration state was committed.`);
      process.exit(1);
    });
}
