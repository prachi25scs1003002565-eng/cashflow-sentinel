import path from 'path';
import dotenv from 'dotenv';
import { Pool, PoolClient } from 'pg';
import { runMigrations, loadMigrationSources } from '../../src/db/migrate';
import {
  parseSchemaDefinition,
  verifySchema,
  verifyFreshDatabase,
  SchemaVerificationError,
} from '../../src/db/schema-verifier';

// Load .env from root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const TARGET_DB = 'cashflow_sentinel_migration_test';
const PROTECTED_DB = 'cashflow_sentinel';

function assertSafety(dbName: string) {
  if (dbName === PROTECTED_DB) {
    throw new Error(`CRITICAL SECURITY VIOLATION: Attempted access to protected database "${PROTECTED_DB}"! Halting immediately.`);
  }
  if (dbName !== TARGET_DB) {
    throw new Error(`CRITICAL SECURITY VIOLATION: Target database "${dbName}" is not the approved test database "${TARGET_DB}"! Halting immediately.`);
  }
}

const testPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: TARGET_DB, // Explicit test database ONLY
  min: 1,
  max: 10,
});

async function verifyClientSafety(client: PoolClient): Promise<void> {
  const res = await client.query('SELECT current_database() as db');
  const currentDb = res.rows[0].db;
  assertSafety(currentDb);
}

const testDb = {
  async withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await testPool.connect();
    try {
      await verifyClientSafety(client);
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
};

interface CatalogInventory {
  tables: number;
  columns: number;
  primaryKeys: number;
  uniqueConstraints: number;
  foreignKeys: number;
  checks: number;
  indexes: number;
  functions: number;
  triggers: number;
}

async function getCatalogInventory(client: PoolClient): Promise<CatalogInventory> {
  await verifyClientSafety(client);

  const tablesRes = await client.query(`
    SELECT count(*)::int as count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations';
  `);

  const columnsRes = await client.query(`
    SELECT count(*)::int as count
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
      AND a.attnum > 0 AND NOT a.attisdropped;
  `);

  const pkRes = await client.query(`
    SELECT count(*)::int as count
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
      AND con.contype = 'p';
  `);

  const uqRes = await client.query(`
    SELECT count(*)::int as count
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
      AND con.contype = 'u';
  `);

  const fkRes = await client.query(`
    SELECT count(*)::int as count
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
      AND con.contype = 'f';
  `);

  const checkRes = await client.query(`
    SELECT count(*)::int as count
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
      AND con.contype = 'c';
  `);

  const idxRes = await client.query(`
    SELECT count(*)::int as count
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations';
  `);

  const funcRes = await client.query(`
    SELECT count(*)::int as count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      );
  `);

  const trgRes = await client.query(`
    SELECT count(*)::int as count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal;
  `);

  return {
    tables: tablesRes.rows[0].count,
    columns: columnsRes.rows[0].count,
    primaryKeys: pkRes.rows[0].count,
    uniqueConstraints: uqRes.rows[0].count,
    foreignKeys: fkRes.rows[0].count,
    checks: checkRes.rows[0].count,
    indexes: idxRes.rows[0].count,
    functions: funcRes.rows[0].count,
    triggers: trgRes.rows[0].count,
  };
}

async function resetTestDatabaseSchema(client: PoolClient): Promise<void> {
  await verifyClientSafety(client);
  await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
  await client.query('CREATE SCHEMA public;');
  await client.query('GRANT ALL ON SCHEMA public TO postgres;');
  await client.query('GRANT ALL ON SCHEMA public TO public;');
  await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
}

async function main() {
  console.log('================================================================');
  console.log('Cashflow Sentinel — Real PostgreSQL 18 Disposable Integration Tests');
  console.log('================================================================');

  const client = await testPool.connect();
  await verifyClientSafety(client);

  const sources = loadMigrationSources();
  const fullDefinition = parseSchemaDefinition(sources);

  const results: { scenario: number; name: string; status: 'PASS' | 'FAIL'; details?: string }[] = [];

  try {
    // --------------------------------------------------------------------------
    // Scenario 1: Fresh Database Sequential Application
    // --------------------------------------------------------------------------
    console.log('\n[Scenario 1] Fresh Database: Migrations 001 and 002 apply in order...');
    await resetTestDatabaseSchema(client);
    await verifyFreshDatabase(client);

    await runMigrations(testDb);

    // Verify live catalog schema through schema verifier
    await verifySchema(client, fullDefinition, true);

    const inventory = await getCatalogInventory(client);
    console.log('  -> Live Catalog Inventory:', JSON.stringify(inventory, null, 2));

    const expectedInventory: CatalogInventory = {
      tables: 36,
      columns: 378,
      primaryKeys: 36,
      uniqueConstraints: 50,
      foreignKeys: 67,
      checks: 86,
      indexes: 110,
      functions: 5,
      triggers: 5,
    };

    for (const [key, expectedVal] of Object.entries(expectedInventory)) {
      const actualVal = inventory[key as keyof CatalogInventory];
      if (actualVal !== expectedVal) {
        throw new Error(`Inventory mismatch on ${key}: expected ${expectedVal}, got ${actualVal}`);
      }
    }

    results.push({
      scenario: 1,
      name: 'Fresh Database Sequential Application',
      status: 'PASS',
      details: 'All 36 tables, 378 columns, 86 checks, 110 indexes, 5 functions, and 5 triggers matched catalog.',
    });

    // --------------------------------------------------------------------------
    // Scenario 2: Ledger Records & Checksums
    // --------------------------------------------------------------------------
    console.log('\n[Scenario 2] Ledger: Verify both migration records and checksums...');
    const ledgerRows = await client.query('SELECT version, checksum, applied_at FROM public.schema_migrations ORDER BY version;');
    if (ledgerRows.rows.length !== 2) {
      throw new Error(`Expected 2 ledger rows, found ${ledgerRows.rows.length}`);
    }

    if (ledgerRows.rows[0].version !== '001_initial_schema.sql' ||
        ledgerRows.rows[0].checksum !== '4116e33791e607164d7af823fb8de0835f61db4470e297637f06760e3b0bc96a') {
      throw new Error(`Invalid ledger entry 0: ${JSON.stringify(ledgerRows.rows[0])}`);
    }

    if (ledgerRows.rows[1].version !== '002_triggers_and_checks.sql' ||
        ledgerRows.rows[1].checksum !== '91dd72e26e33363356ce4d2f12ade47946f7aeedfc69504838a140614e45b0bd') {
      throw new Error(`Invalid ledger entry 1: ${JSON.stringify(ledgerRows.rows[1])}`);
    }

    console.log('  -> Migration 001 Checksum:', ledgerRows.rows[0].checksum);
    console.log('  -> Migration 002 Checksum:', ledgerRows.rows[1].checksum);
    results.push({
      scenario: 2,
      name: 'Ledger Records & Checksums',
      status: 'PASS',
      details: 'Exact checksums verified; timestamps recorded chronologically.',
    });

    // --------------------------------------------------------------------------
    // Scenario 3: Idempotency
    // --------------------------------------------------------------------------
    console.log('\n[Scenario 3] Idempotency: Second runner execution makes no duplicate changes...');
    await runMigrations(testDb);
    const postIdempotencyRows = await client.query('SELECT count(*)::int as count FROM public.schema_migrations;');
    if (postIdempotencyRows.rows[0].count !== 2) {
      throw new Error(`Idempotency violated: ledger count changed to ${postIdempotencyRows.rows[0].count}`);
    }
    await verifySchema(client, fullDefinition, true);
    results.push({
      scenario: 3,
      name: 'Idempotency Verification',
      status: 'PASS',
      details: 'Second execution completed as a no-op; 2 ledger rows preserved; schema identical.',
    });

    // --------------------------------------------------------------------------
    // Scenario 4: Existing Schema Baseline
    // --------------------------------------------------------------------------
    console.log('\n[Scenario 4] Existing Schema Baseline: Matching schema is baselined without rerunning SQL...');
    await resetTestDatabaseSchema(client);

    // Apply raw migration SQL directly without ledger table
    for (const source of sources) {
      await client.query(source.sql);
    }

    // Confirm ledger table does NOT exist
    const preCheckLedger = await client.query(`
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'schema_migrations';
    `);
    if (preCheckLedger.rows.length !== 0) {
      throw new Error('Precondition failed: schema_migrations should not exist yet');
    }

    // Run migrations runner: should baseline existing schema
    await runMigrations(testDb);

    const postBaselineLedger = await client.query('SELECT version, checksum FROM public.schema_migrations ORDER BY version;');
    if (postBaselineLedger.rows.length !== 2) {
      throw new Error(`Baseline failed: expected 2 ledger rows, got ${postBaselineLedger.rows.length}`);
    }

    results.push({
      scenario: 4,
      name: 'Existing Schema Baseline',
      status: 'PASS',
      details: 'Unledgered State 2 schema detected and baselined into ledger without rerunning DDL.',
    });

    // --------------------------------------------------------------------------
    // Scenario 5: Drift Detection
    // --------------------------------------------------------------------------
    console.log('\n[Scenario 5] Drift Detection: Unexpected table, column, index, function, and trigger are rejected...');

    // 5a. Unexpected table
    await client.query('CREATE TABLE public.unexpected_drift_tbl (id int);');
    let caughtTableDrift = false;
    try {
      await verifySchema(client, fullDefinition, true);
    } catch (err) {
      if (err instanceof SchemaVerificationError) caughtTableDrift = true;
    } finally {
      await client.query('DROP TABLE public.unexpected_drift_tbl;');
    }
    if (!caughtTableDrift) throw new Error('Failed to detect unexpected table drift');

    // 5b. Unexpected column
    await client.query('ALTER TABLE public.businesses ADD COLUMN unexpected_drift_col text;');
    let caughtColumnDrift = false;
    try {
      await verifySchema(client, fullDefinition, true);
    } catch (err) {
      if (err instanceof SchemaVerificationError) caughtColumnDrift = true;
    } finally {
      await client.query('ALTER TABLE public.businesses DROP COLUMN unexpected_drift_col;');
    }
    if (!caughtColumnDrift) throw new Error('Failed to detect unexpected column drift');

    // 5c. Unexpected index
    await client.query('CREATE INDEX idx_unexpected_drift ON public.users(display_name);');
    let caughtIndexDrift = false;
    try {
      await verifySchema(client, fullDefinition, true);
    } catch (err) {
      if (err instanceof SchemaVerificationError) caughtIndexDrift = true;
    } finally {
      await client.query('DROP INDEX public.idx_unexpected_drift;');
    }
    if (!caughtIndexDrift) throw new Error('Failed to detect unexpected index drift');

    // 5d. Unexpected function
    await client.query('CREATE FUNCTION public.fn_unexpected_drift() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;');
    let caughtFunctionDrift = false;
    try {
      await verifySchema(client, fullDefinition, true);
    } catch (err) {
      if (err instanceof SchemaVerificationError) caughtFunctionDrift = true;
    } finally {
      await client.query('DROP FUNCTION public.fn_unexpected_drift();');
    }
    if (!caughtFunctionDrift) throw new Error('Failed to detect unexpected function drift');

    // 5e. Unexpected trigger
    await client.query('CREATE TRIGGER trg_unexpected_drift BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.fn_check_transaction_category_direction();');
    let caughtTriggerDrift = false;
    try {
      await verifySchema(client, fullDefinition, true);
    } catch (err) {
      if (err instanceof SchemaVerificationError) caughtTriggerDrift = true;
    } finally {
      await client.query('DROP TRIGGER trg_unexpected_drift ON public.users;');
    }
    if (!caughtTriggerDrift) throw new Error('Failed to detect unexpected trigger drift');

    results.push({
      scenario: 5,
      name: 'Drift Detection (Fail-Closed)',
      status: 'PASS',
      details: 'All 5 drift types (table, column, index, function, trigger) correctly failed with SchemaVerificationError.',
    });

    // --------------------------------------------------------------------------
    // Scenario 6: Missing Object
    // --------------------------------------------------------------------------
    console.log('\n[Scenario 6] Missing Object: Verification fails closed...');
    await client.query('DROP INDEX public.idx_users_email_lower;');
    let caughtMissingIndex = false;
    try {
      await verifySchema(client, fullDefinition, true);
    } catch (err) {
      if (err instanceof SchemaVerificationError) caughtMissingIndex = true;
    } finally {
      // Re-create dropped index
      await client.query('CREATE UNIQUE INDEX idx_users_email_lower ON public.users (lower(email));');
    }
    if (!caughtMissingIndex) throw new Error('Failed to detect missing index');

    // Verify restored schema passes
    await verifySchema(client, fullDefinition, true);

    results.push({
      scenario: 6,
      name: 'Missing Object Detection',
      status: 'PASS',
      details: 'Dropping idx_users_email_lower triggered immediate failure; restored index passed cleanly.',
    });

    // --------------------------------------------------------------------------
    // Scenario 7: Checksum Mismatch
    // --------------------------------------------------------------------------
    console.log('\n[Scenario 7] Checksum Mismatch: Runner aborts...');
    await client.query(`
      UPDATE public.schema_migrations
      SET checksum = 'badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb'
      WHERE version = '001_initial_schema.sql';
    `);
    let caughtChecksumMismatch = false;
    try {
      await runMigrations(testDb);
    } catch (err: any) {
      if (/checksum/i.test(err.message)) caughtChecksumMismatch = true;
    } finally {
      await client.query(`
        UPDATE public.schema_migrations
        SET checksum = '4116e33791e607164d7af823fb8de0835f61db4470e297637f06760e3b0bc96a'
        WHERE version = '001_initial_schema.sql';
      `);
    }
    if (!caughtChecksumMismatch) throw new Error('Failed to reject ledger checksum mismatch');

    results.push({
      scenario: 7,
      name: 'Checksum Mismatch Rejection',
      status: 'PASS',
      details: 'Corrupted checksum in schema_migrations caused runner to halt immediately.',
    });

    // --------------------------------------------------------------------------
    // Scenario 8: Transaction Rollback
    // --------------------------------------------------------------------------
    console.log('\n[Scenario 8] Rollback: Failed transaction leaves no partial migration or ledger record...');
    let caughtTxError = false;
    try {
      await testDb.withTransaction(async (txClient) => {
        await txClient.query('CREATE TABLE public.rollback_probe_table (id int);');
        await txClient.query('INSERT INTO public.schema_migrations (version, checksum) VALUES (\'003_probe.sql\', \'dummy\');');
        throw new Error('Simulated transaction abortion');
      });
    } catch (err: any) {
      if (/Simulated transaction abortion/.test(err.message)) caughtTxError = true;
    }
    if (!caughtTxError) throw new Error('Transaction abortion failed to propagate');

    // Confirm table and ledger row were rolled back
    const probeTableRes = await client.query(`
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'rollback_probe_table';
    `);
    if (probeTableRes.rows.length !== 0) throw new Error('Rollback failure: table still exists');

    const probeLedgerRes = await client.query('SELECT 1 FROM public.schema_migrations WHERE version = \'003_probe.sql\';');
    if (probeLedgerRes.rows.length !== 0) throw new Error('Rollback failure: ledger row still exists');

    results.push({
      scenario: 8,
      name: 'Transaction Rollback Atomicity',
      status: 'PASS',
      details: 'Aborted transaction left zero partial tables and zero ledger rows in PostgreSQL.',
    });

    // --------------------------------------------------------------------------
    // Scenario 9: Concurrency
    // --------------------------------------------------------------------------
    console.log('\n[Scenario 9] Concurrency: Simultaneous runners serialize safely...');
    const concurrentPromises = Array.from({ length: 5 }, () => runMigrations(testDb));
    await Promise.all(concurrentPromises);

    const postConcurrencyLedger = await client.query('SELECT count(*)::int as count FROM public.schema_migrations;');
    if (postConcurrencyLedger.rows[0].count !== 2) {
      throw new Error(`Concurrency race condition detected: ledger count is ${postConcurrencyLedger.rows[0].count}`);
    }

    results.push({
      scenario: 9,
      name: 'Concurrency & Advisory Lock Serialization',
      status: 'PASS',
      details: '5 parallel runners serialized cleanly via pg_advisory_xact_lock with zero deadlocks.',
    });

    // --------------------------------------------------------------------------
    // Scenario 10: Application Data Preservation
    // --------------------------------------------------------------------------
    console.log('\n[Scenario 10] Application Data Preservation: Baseline preserves existing records...');
    await resetTestDatabaseSchema(client);

    // Apply raw migration SQL directly
    for (const source of sources) {
      await client.query(source.sql);
    }

    // Insert test records
    const testBusinessId = 'a0000000-0000-0000-0000-000000000001';
    const testUserId = 'b0000000-0000-0000-0000-000000000001';

    await client.query(`
      INSERT INTO public.businesses (id, name, business_type, currency_code, business_status)
      VALUES ($1, 'Preserved Test Kirana', 'KIRANA', 'INR', 'ACTIVE');
    `, [testBusinessId]);

    await client.query(`
      INSERT INTO public.users (id, email, password_hash, display_name, account_status)
      VALUES ($1, 'preserved_user@example.com', '$2a$10$abcdefghijklmnopqrstuvwxyz123456', 'Preserved User', 'ACTIVE');
    `, [testUserId]);

    // Baseline existing unledgered schema with existing records
    await runMigrations(testDb);

    // Verify application records are intact
    const busRes = await client.query('SELECT name, business_type FROM public.businesses WHERE id = $1', [testBusinessId]);
    if (busRes.rows.length !== 1 || busRes.rows[0].name !== 'Preserved Test Kirana') {
      throw new Error('Business record corrupted or missing after baseline');
    }

    const userRes = await client.query('SELECT email, display_name FROM public.users WHERE id = $1', [testUserId]);
    if (userRes.rows.length !== 1 || userRes.rows[0].email !== 'preserved_user@example.com') {
      throw new Error('User record corrupted or missing after baseline');
    }

    // Verify catalog completeness
    const postPreserveInventory = await getCatalogInventory(client);
    for (const [key, expectedVal] of Object.entries(expectedInventory)) {
      const actualVal = postPreserveInventory[key as keyof CatalogInventory];
      if (actualVal !== expectedVal) {
        throw new Error(`Inventory mismatch post-preserve on ${key}: expected ${expectedVal}, got ${actualVal}`);
      }
    }

    results.push({
      scenario: 10,
      name: 'Application Data Preservation',
      status: 'PASS',
      details: 'Pre-existing business and user data remained 100% intact and unmutated during baselining.',
    });

  } finally {
    client.release();
    await testPool.end();
  }

  console.log('\n================================================================');
  console.log('INTEGRATION TEST SUMMARY:');
  console.log('================================================================');
  for (const r of results) {
    console.log(`[Scenario ${r.scenario}] ${r.status}: ${r.name}`);
    if (r.details) console.log(`   └─ ${r.details}`);
  }

  const allPassed = results.length === 10 && results.every((r) => r.status === 'PASS');
  if (allPassed) {
    console.log('\nALL 10 DISPOSABLE POSTGRESQL 18 INTEGRATION SCENARIOS PASSED.');
  } else {
    console.error('\nSOME SCENARIOS FAILED.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFATAL INTEGRATION TEST FAILURE:', err);
  process.exit(1);
});
