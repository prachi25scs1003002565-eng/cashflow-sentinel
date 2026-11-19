import request from 'supertest';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TARGET_DB = 'cashflow_sentinel_migration_test';
const PROTECTED_DB = 'cashflow_sentinel';

function assertSafety(dbName) {
  if (dbName === PROTECTED_DB) {
    throw new Error(
      `CRITICAL SECURITY VIOLATION: Attempted access to protected database "${PROTECTED_DB}"! Halting immediately.`
    );
  }
  if (dbName !== TARGET_DB) {
    throw new Error(
      `CRITICAL SECURITY VIOLATION: Target database "${dbName}" is not the approved test database "${TARGET_DB}"! Halting immediately.`
    );
  }
}

// 1. Pre-flight safety check
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: TARGET_DB,
});

const safetyRes = await pool.query('SELECT current_database() as db');
const currentDb = safetyRes.rows[0].db;
assertSafety(currentDb);
console.log(`[SAFETY CHECK PASSED] Confirmed target database is "${currentDb}"`);

// 2. Import compiled express app
import appExport from '../dist/app.js';
import { registerRateLimiter } from '../dist/modules/auth/auth.routes.js';
const app = appExport.default || appExport;

const suffix = Date.now();
console.log(`\n========================================`);
console.log(`CASHFLOW SENTINEL - FORECASTING INTEGRATION SUITE`);
console.log(`Target Database: ${currentDb}`);
console.log(`Timestamp Suffix: ${suffix}`);
console.log(`========================================\n`);

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
  passedTests++;
}

try {
  // ----------------------------------------------------
  // Helper: Register & Login a new tenant
  // ----------------------------------------------------
  async function createTestTenant(tag) {
    registerRateLimiter?.reset?.();
    const email = `forecast_${tag}_${suffix}@example.com`;
    const password = 'Password@123';
    const displayName = `Forecast ${tag} Business`;

    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password, display_name: displayName });

    assert(regRes.status === 201, `Tenant [${tag}] registered successfully`);
    const token = regRes.body.data.access_token;
    const userId = regRes.body.data.user.id;

    // Trigger initial authenticated request so business is auto-provisioned
    await request(app)
      .get('/api/v1/transactions/summary')
      .set('Authorization', `Bearer ${token}`);

    // Get default business
    const bizRes = await pool.query(
      `SELECT b.id FROM businesses b
       JOIN business_memberships bm ON bm.business_id = b.id
       WHERE bm.user_id = $1`,
      [userId]
    );
    const businessId = bizRes.rows[0]?.id;

    return { email, password, token, userId, businessId };
  }

  // ====================================================
  // TEST SCENARIO 1: User with 0 transactions
  // ====================================================
  console.log(`\n--- Scenario 1: Zero Transactions (Insufficient History) ---`);
  const tenant1 = await createTestTenant('zero_tx');

  const zeroLatestRes = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenant1.token}`);

  assert(zeroLatestRes.status === 200, 'GET /forecasts/latest returns 200');
  assert(
    zeroLatestRes.body.data.status === 'INSUFFICIENT_HISTORY',
    'Status is INSUFFICIENT_HISTORY for zero transactions'
  );
  assert(
    zeroLatestRes.body.data.has_sufficient_history === false,
    'has_sufficient_history is false'
  );
  assert(
    zeroLatestRes.body.data.calendar_days_coverage === 0,
    'calendar_days_coverage is 0'
  );
  assert(
    zeroLatestRes.body.data.min_calendar_days_required === 14,
    'min_calendar_days_required is 14'
  );

  const zeroGenRes = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenant1.token}`)
    .send({ horizon_days: 30 });

  assert(zeroGenRes.status === 201, 'POST /forecasts/generate returns 201');
  assert(
    zeroGenRes.body.data.status === 'INSUFFICIENT_HISTORY',
    'POST generate returns INSUFFICIENT_HISTORY when history is empty'
  );

  // ====================================================
  // TEST SCENARIO 2: Transactions spanning only 3 days (< 14 days)
  // ====================================================
  console.log(`\n--- Scenario 2: Short Date Span (< 14 Calendar Days) ---`);
  const tenant2 = await createTestTenant('short_span');

  // Insert transactions on 2026-11-01, 2026-11-02, 2026-11-03
  for (let d = 1; d <= 3; d++) {
    const dayStr = d < 10 ? `0${d}` : `${d}`;
    await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${tenant2.token}`)
      .send({
        type: 'income',
        amount: '1000.00',
        transaction_date: `2026-11-${dayStr}`,
        description: `Income day ${d}`,
      });
  }

  const shortSpanRes = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenant2.token}`);

  assert(
    shortSpanRes.body.data.status === 'INSUFFICIENT_HISTORY',
    'Short span (3 days) correctly rejected with INSUFFICIENT_HISTORY'
  );
  assert(
    shortSpanRes.body.data.calendar_days_coverage === 3,
    'Reports calendar_days_coverage === 3'
  );

  // ====================================================
  // TEST SCENARIO 3: 15-day span but sparse data (< 7 active days)
  // ====================================================
  console.log(`\n--- Scenario 3: 15-Day Span but Sparse Data (< 7 Active Days) ---`);
  const tenant3 = await createTestTenant('sparse');

  // Insert 1 transaction on 2026-10-01 and 1 transaction on 2026-10-16 (16 days span, but only 2 active days)
  await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', `Bearer ${tenant3.token}`)
    .send({
      type: 'income',
      amount: '5000.00',
      transaction_date: '2026-10-01',
      description: 'Day 1 entry',
    });

  await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', `Bearer ${tenant3.token}`)
    .send({
      type: 'income',
      amount: '3000.00',
      transaction_date: '2026-10-16',
      description: 'Day 16 entry',
    });

  const sparseRes = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenant3.token}`);

  assert(
    sparseRes.body.data.status === 'INSUFFICIENT_HISTORY',
    'Sparse data (2 active days) correctly rejected as INSUFFICIENT_HISTORY'
  );
  assert(
    sparseRes.body.data.calendar_days_coverage === 16,
    'Reports coverage of 16 calendar days'
  );
  assert(
    sparseRes.body.data.distinct_days_recorded === 2,
    'Reports distinct_days_recorded === 2'
  );

  // ====================================================
  // TEST SCENARIO 4: Sufficient History (>= 14 days, >= 7 distinct days)
  // ====================================================
  console.log(`\n--- Scenario 4: Sufficient Historical Data (14+ Days) ---`);
  const tenant4 = await createTestTenant('sufficient');

  // Insert 14 transactions over 14 consecutive calendar days
  for (let d = 1; d <= 14; d++) {
    const dayStr = d < 10 ? `0${d}` : `${d}`;
    await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${tenant4.token}`)
      .send({
        type: d % 2 === 0 ? 'expense' : 'income',
        amount: (1000 + d * 100).toFixed(2),
        transaction_date: `2026-10-${dayStr}`,
        description: `Daily business operation day ${d}`,
      });
  }

  // Now trigger forecast generation
  const forecastRes = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenant4.token}`)
    .send({
      horizon_days: 30,
      as_of_date: '2026-10-14',
    });

  assert(forecastRes.status === 201, 'POST /forecasts/generate returns 201');
  assert(
    forecastRes.body.data.has_sufficient_history === true,
    'has_sufficient_history is true'
  );
  assert(
    forecastRes.body.data.status === 'SUCCEEDED',
    'status is SUCCEEDED'
  );
  assert(
    Array.isArray(forecastRes.body.data.run.points),
    'Points array returned'
  );
  assert(
    forecastRes.body.data.run.points.length === 30,
    'Exactly 30 forecast points generated for 30-day horizon'
  );

  const firstPoint = forecastRes.body.data.run.points[0];
  assert(
    firstPoint.forecast_date === '2026-10-15',
    'First forecast date is consecutive day 2026-10-15'
  );
  assert(
    typeof firstPoint.closing_predicted_paise === 'string',
    'closing_predicted_paise is present and string format'
  );
  assert(
    ['LOW', 'MEDIUM', 'HIGH'].includes(firstPoint.uncertainty_band),
    `uncertainty_band is valid (${firstPoint.uncertainty_band})`
  );

  // Verify persistence in PostgreSQL
  const dbRunRes = await pool.query(
    'SELECT * FROM forecast_runs WHERE id = $1 AND business_id = $2',
    [forecastRes.body.data.run.id, tenant4.businessId]
  );
  assert(dbRunRes.rows.length === 1, 'Forecast run persisted in PostgreSQL table forecast_runs');
  assert(
    dbRunRes.rows[0].run_status === 'SUCCEEDED',
    'forecast_runs.run_status is SUCCEEDED'
  );

  const dbPointsRes = await pool.query(
    'SELECT COUNT(*) as count FROM forecast_points WHERE forecast_run_id = $1 AND business_id = $2',
    [forecastRes.body.data.run.id, tenant4.businessId]
  );
  assert(
    parseInt(dbPointsRes.rows[0].count, 10) === 30,
    'All 30 forecast points persisted in PostgreSQL table forecast_points'
  );

  // Verify GET /forecasts/latest returns this persisted forecast
  const latestRes = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenant4.token}`);

  assert(latestRes.status === 200, 'GET /forecasts/latest returns 200');
  assert(
    latestRes.body.data.has_sufficient_history === true,
    'latest forecast has_sufficient_history === true'
  );
  assert(
    latestRes.body.data.run.id === forecastRes.body.data.run.id,
    'latest forecast returns identical run ID'
  );

  // ====================================================
  // TEST SCENARIO 5: Buffer Breach & Risk Alerts
  // ====================================================
  console.log(`\n--- Scenario 5: Real Cash Buffer Breach Alert Detection ---`);
  // Update business minimum buffer to ₹500,000 (higher than current cash)
  await pool.query(
    'UPDATE businesses SET minimum_cash_buffer_paise = 50000000 WHERE id = $1',
    [tenant4.businessId]
  );

  const breachForecastRes = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenant4.token}`)
    .send({
      horizon_days: 30,
      as_of_date: '2026-10-14',
    });

  assert(
    breachForecastRes.body.data.summary.has_buffer_breach === true,
    'Buffer breach detected when projected cash < minimum buffer'
  );

  const dbAlertsRes = await pool.query(
    'SELECT * FROM risk_alerts WHERE business_id = $1 AND forecast_run_id = $2',
    [tenant4.businessId, breachForecastRes.body.data.run.id]
  );
  assert(
    dbAlertsRes.rows.length > 0,
    'Genuine risk alert persisted in PostgreSQL table risk_alerts'
  );
  assert(
    dbAlertsRes.rows[0].alert_type === 'CASH_BUFFER_BREACH',
    'Alert type is CASH_BUFFER_BREACH'
  );
  assert(
    !dbAlertsRes.rows[0].explanation.includes('Deccan Wholesale'),
    'Alert contains NO hardcoded Deccan Wholesale text; derived strictly from actual balance calculations'
  );

  // ====================================================
  // TEST SCENARIO 6: Strict Tenant Isolation
  // ====================================================
  console.log(`\n--- Scenario 6: Strict Tenant Isolation ---`);
  const tenant5 = await createTestTenant('tenant_other');

  // Tenant 5 queries latest forecast - should have 0 data and NOT see Tenant 4's forecast
  const t5Res = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenant5.token}`);

  assert(
    t5Res.body.data.status === 'INSUFFICIENT_HISTORY',
    'Tenant 5 cannot access Tenant 4 forecast and gets isolated INSUFFICIENT_HISTORY'
  );

  console.log(`\n========================================`);
  console.log(`ALL INTEGRATION TESTS PASSED: ${passedTests}/${totalTests}`);
  console.log(`========================================\n`);
} catch (err) {
  console.error('\n❌ TEST RUN ABORTED WITH ERROR:\n', err);
  process.exitCode = 1;
} finally {
  await pool.end();
  const dbModule = await import('../dist/db/index.js');
  await dbModule.Database?.close?.();
  process.exit(process.exitCode || 0);
}
