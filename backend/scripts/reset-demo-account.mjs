import dotenv from 'dotenv';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEMO_IDS, DEMO_CREDENTIALS } from './seed-demo-account.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DEFAULT_TARGET_DB = 'cashflow_sentinel_migration_test';
const PROTECTED_DB = 'cashflow_sentinel';

if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'CRITICAL SECURITY VIOLATION: Demo data operations are forbidden in production (NODE_ENV=production)!'
  );
}

// Allow target database to be configured via DEMO_TARGET_DB ONLY IF ALLOW_DEMO_SEED=true
let TARGET_DB = DEFAULT_TARGET_DB;
if (process.env.DEMO_TARGET_DB) {
  if (process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      'CRITICAL SECURITY VIOLATION: DEMO_TARGET_DB is set but ALLOW_DEMO_SEED is not "true". Demo reset blocked.'
    );
  }
  TARGET_DB = process.env.DEMO_TARGET_DB;
}

function assertSafety(dbName) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CRITICAL SECURITY VIOLATION: Demo data operations are forbidden in production (NODE_ENV=production)!'
    );
  }
  if (dbName.toLowerCase().includes('prod')) {
    throw new Error(
      `CRITICAL SECURITY VIOLATION: Target database "${dbName}" contains "prod" or "production"! Demo operations are forbidden.`
    );
  }
  if (dbName === PROTECTED_DB) {
    throw new Error(
      `CRITICAL SECURITY VIOLATION: Attempted access to protected database "${PROTECTED_DB}"! Halting immediately.`
    );
  }
  if (dbName !== TARGET_DB) {
    throw new Error(
      `CRITICAL SECURITY VIOLATION: Target database "${dbName}" is not the approved target database "${TARGET_DB}"! Halting immediately.`
    );
  }
}

export async function resetDemoAccount(targetPool = null) {
  const pool =
    targetPool ||
    new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: TARGET_DB,
    });

  const safetyRes = await pool.query('SELECT current_database() as db');
  const currentDb = safetyRes.rows[0].db;
  assertSafety(currentDb);
  console.log(`[SAFETY CHECK PASSED] Resetting demo account in "${currentDb}"`);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Delete transactions belonging strictly to demo business
    const txDel = await client.query(
      `DELETE FROM transactions WHERE business_id = $1`,
      [DEMO_IDS.BUSINESS_ID]
    );
    console.log(`- Removed ${txDel.rowCount} demo transactions`);

    // 2. Delete forecast points and runs for demo business
    await client.query(`DELETE FROM forecast_points WHERE business_id = $1`, [DEMO_IDS.BUSINESS_ID]);
    await client.query(`DELETE FROM risk_alerts WHERE business_id = $1`, [DEMO_IDS.BUSINESS_ID]);
    const runsDel = await client.query(`DELETE FROM forecast_runs WHERE business_id = $1`, [DEMO_IDS.BUSINESS_ID]);
    console.log(`- Removed ${runsDel.rowCount} demo forecast runs`);

    // 3. Delete categories, accounts, data sources
    await client.query(`DELETE FROM transaction_categories WHERE business_id = $1`, [DEMO_IDS.BUSINESS_ID]);
    await client.query(`DELETE FROM accounts WHERE business_id = $1`, [DEMO_IDS.BUSINESS_ID]);
    await client.query(`DELETE FROM data_sources WHERE business_id = $1`, [DEMO_IDS.BUSINESS_ID]);

    // 4. Delete memberships and business
    await client.query(`DELETE FROM business_memberships WHERE business_id = $1`, [DEMO_IDS.BUSINESS_ID]);
    await client.query(`DELETE FROM businesses WHERE id = $1`, [DEMO_IDS.BUSINESS_ID]);

    // 5. Delete demo user
    await client.query(
      `DELETE FROM users WHERE id = $1 OR lower(email) = lower($2)`,
      [DEMO_IDS.USER_ID, DEMO_CREDENTIALS.email]
    );
    console.log(`- Removed demo user ${DEMO_CREDENTIALS.email}`);

    await client.query('COMMIT');
    console.log(`[SUCCESS] Demo account safely purged. All real user and tenant records remain untouched.`);
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[RESET FAILED]:', err);
    throw err;
  } finally {
    client.release();
    if (!targetPool) {
      await pool.end();
    }
  }
}

// Allow direct execution from CLI
if (process.argv[1] && process.argv[1].endsWith('reset-demo-account.mjs')) {
  resetDemoAccount()
    .then(() => {
      console.log('Demo account reset completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Reset execution failed:', err);
      process.exit(1);
    });
}
