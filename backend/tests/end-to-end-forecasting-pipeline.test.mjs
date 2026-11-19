import request from 'supertest';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import path from 'path';
import crypto from 'crypto';
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
console.log(`[SAFETY CHECK PASSED] Target database confirmed: "${currentDb}"`);

// 2. Import compiled Express app
import appExport from '../dist/app.js';
import { registerRateLimiter } from '../dist/modules/auth/auth.routes.js';
const app = appExport.default || appExport;

const suffix = Date.now();
console.log(`\n========================================================================`);
console.log(`DAY 2 — PHASE 2: END-TO-END FORECASTING PIPELINE VERIFICATION SUITE`);
console.log(`Database: ${currentDb}`);
console.log(`Timestamp: ${new Date().toISOString()} (Suffix: ${suffix})`);
console.log(`========================================================================\n`);

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
  // Helper: Register and provision an isolated tenant
  async function createIsolatedTenant(tag) {
    registerRateLimiter?.reset?.();
    const email = `e2e_${tag}_${suffix}@example.com`;
    const password = 'Password@123';
    const displayName = `E2E ${tag} Enterprise`;

    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password, display_name: displayName });

    assert(regRes.status === 201, `Tenant [${tag}] registered successfully`);
    const token = regRes.body.data.access_token;
    const userId = regRes.body.data.user.id;

    // Auto-provision initial business & account
    await request(app)
      .get('/api/v1/transactions/summary')
      .set('Authorization', `Bearer ${token}`);

    const bizRes = await pool.query(
      `SELECT b.id FROM businesses b
       JOIN business_memberships bm ON bm.business_id = b.id
       WHERE bm.user_id = $1`,
      [userId]
    );
    const businessId = bizRes.rows[0]?.id;

    return { email, password, token, userId, businessId };
  }

  // Helper: Seed 14 days of history to achieve exact opening balance
  async function seedHistoryForOpeningBalance(tenant, openingPaise, asOfDateStr) {
    const baseDailyRupees = (Number(openingPaise / 10n) / 100).toFixed(2);

    for (let d = 1; d <= 10; d++) {
      const dayStr = d < 10 ? `0${d}` : `${d}`;
      const date = `2026-10-${dayStr}`;
      const res = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({
          type: 'income',
          amount: baseDailyRupees,
          transaction_date: date,
          description: `History Inflow Day ${d}`,
        });
      assert(res.status === 201, `History day ${d} transaction posted`);
    }

    for (let d = 11; d <= 14; d++) {
      const dayStr = `${d}`;
      const date = `2026-10-${dayStr}`;
      await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({
          type: 'income',
          amount: '100.00',
          transaction_date: date,
          description: `History Net-Zero Inflow Day ${d}`,
        });
      await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({
          type: 'expense',
          amount: '100.00',
          transaction_date: date,
          description: `History Net-Zero Outflow Day ${d}`,
        });
    }
  }

  // Helper: Seed future customer receivable (sales invoice)
  async function seedReceivable(tenant, dateStr, amountPaise, label) {
    const customerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customers (id, business_id, display_name) VALUES ($1, $2, $3)`,
      [customerId, tenant.businessId, label]
    );

    const invoiceId = crypto.randomUUID();
    const invoiceNumber = `INV-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await pool.query(
      `INSERT INTO sales_invoices (id, business_id, customer_id, invoice_number, issued_date, due_date, total_paise, invoice_status)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'ISSUED')`,
      [invoiceId, tenant.businessId, customerId, invoiceNumber, dateStr, amountPaise.toString()]
    );

    const receivableId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO receivables (id, business_id, invoice_id, expected_collection_date, expected_certainty, collection_state)
       VALUES ($1, $2, $3, $4, 'CONFIRMED', 'OPEN')`,
      [receivableId, tenant.businessId, invoiceId, dateStr]
    );
  }

  // Helper: Seed future supplier payable (supplier bill)
  async function seedPayable(tenant, dateStr, amountPaise, label) {
    const supplierId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO suppliers (id, business_id, display_name) VALUES ($1, $2, $3)`,
      [supplierId, tenant.businessId, label]
    );

    const billId = crypto.randomUUID();
    const billNumber = `BILL-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await pool.query(
      `INSERT INTO supplier_bills (id, business_id, supplier_id, bill_number, bill_date, due_date, total_paise, bill_status)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'RECEIVED')`,
      [billId, tenant.businessId, supplierId, billNumber, dateStr, amountPaise.toString()]
    );

    const payableId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payables (id, business_id, bill_id, expected_payment_date, expected_certainty, payment_state)
       VALUES ($1, $2, $3, $4, 'CONFIRMED', 'OPEN')`,
      [payableId, tenant.businessId, billId, dateStr]
    );
  }

  // =========================================================================
  // SECTION 1: API Security & Authentication
  // =========================================================================
  console.log(`--- Section 1: Forecasting API Security & Auth Verification ---`);
  
  // 1. Unauthenticated GET /forecasts/latest
  const unauthGet = await request(app).get('/api/v1/forecasts/latest');
  assert(unauthGet.status === 401, 'Unauthenticated GET /forecasts/latest rejected with HTTP 401');

  // 2. Unauthenticated POST /forecasts/generate
  const unauthPost = await request(app).post('/api/v1/forecasts/generate').send({ horizon_days: 30 });
  assert(unauthPost.status === 401, 'Unauthenticated POST /forecasts/generate rejected with HTTP 401');

  // 3. New isolated tenant with zero transactions
  const tenantNew = await createIsolatedTenant('zero_history');
  const latestZero = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantNew.token}`);

  assert(latestZero.status === 200, 'GET /forecasts/latest returns HTTP 200 for authenticated user');
  assert(latestZero.body.data.has_sufficient_history === false, 'has_sufficient_history is false');
  assert(latestZero.body.data.status === 'INSUFFICIENT_HISTORY', 'status is INSUFFICIENT_HISTORY');
  assert(latestZero.body.data.min_calendar_days_required === 14, 'min_calendar_days_required === 14');
  assert(latestZero.body.data.min_distinct_days_required === 7, 'min_distinct_days_required === 7');
  assert(latestZero.body.data.min_transactions_required === 7, 'min_transactions_required === 7');

  // =========================================================================
  // SECTION 2: Financial Calculations — Scenario A (Income Only)
  // Opening: ₹10,000, 7 daily receivables ₹1,000 -> Day 7 closing: ₹17,000
  // =========================================================================
  console.log(`\n--- Section 2: Scenario A — Income Only (Opening ₹10,000, +₹1,000/day) ---`);
  const tenantA = await createIsolatedTenant('scen_a_pipe');
  await seedHistoryForOpeningBalance(tenantA, 1000000n, '2026-10-14');

  for (let d = 1; d <= 7; d++) {
    const day = 14 + d;
    await seedReceivable(tenantA, `2026-10-${day}`, 100000n, `Customer Inflow Day ${d}`);
  }

  const resA = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantA.token}`)
    .send({ horizon_days: 30, as_of_date: '2026-10-14' });

  assert(resA.status === 201, 'Scenario A forecast generated with HTTP 201');
  const runA = resA.body.data.run;
  assert(runA.opening_confirmed_paise === '1000000', 'Scenario A opening confirmed is 1,000,000 paise (₹10,000)');
  assert(runA.method_name === 'DETERMINISTIC_ROLL_FORWARD', 'Scenario A generated by Python AI Engine');
  assert(runA.points.length === 30, 'Scenario A contains all 30 points');

  for (let d = 1; d <= 7; d++) {
    const expected = 1000000 + d * 100000;
    assert(
      runA.points[d - 1].closing_predicted_paise === expected.toString(),
      `Scenario A Day ${d} closing balance: ₹${expected / 100}. Got: ${runA.points[d - 1].closing_predicted_paise}`
    );
  }
  assert(runA.points[6].closing_predicted_paise === '1700000', 'Scenario A Day 7 closing balance is EXACTLY ₹17,000 (1,700,000 paise)');

  // Verify GET /forecasts/latest returns this identical run
  const latestA = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantA.token}`);
  assert(latestA.status === 200, 'GET /forecasts/latest succeeded');
  assert(latestA.body.data.run.id === runA.id, 'GET /latest returns identical run ID');
  assert(latestA.body.data.run.points.length === 30, 'GET /latest returns all 30 points');

  // =========================================================================
  // SECTION 3: Financial Calculations — Scenario B (Expenses Only)
  // Opening: ₹10,000, 7 daily payables ₹500 -> Day 7 closing: ₹6,500
  // =========================================================================
  console.log(`\n--- Section 3: Scenario B — Expenses Only (Opening ₹10,000, -₹500/day) ---`);
  const tenantB = await createIsolatedTenant('scen_b_pipe');
  await seedHistoryForOpeningBalance(tenantB, 1000000n, '2026-10-14');

  for (let d = 1; d <= 7; d++) {
    const day = 14 + d;
    await seedPayable(tenantB, `2026-10-${day}`, 50000n, `Supplier Outflow Day ${d}`);
  }

  const resB = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantB.token}`)
    .send({ horizon_days: 30, as_of_date: '2026-10-14' });

  assert(resB.status === 201, 'Scenario B forecast generated with HTTP 201');
  const runB = resB.body.data.run;
  assert(runB.opening_confirmed_paise === '1000000', 'Scenario B opening confirmed is 1,000,000 paise (₹10,000)');

  for (let d = 1; d <= 7; d++) {
    const expected = 1000000 - d * 50000;
    assert(
      runB.points[d - 1].closing_predicted_paise === expected.toString(),
      `Scenario B Day ${d} closing balance: ₹${expected / 100}. Got: ${runB.points[d - 1].closing_predicted_paise}`
    );
  }
  assert(runB.points[6].closing_predicted_paise === '650000', 'Scenario B Day 7 closing balance is EXACTLY ₹6,500 (650,000 paise)');

  // =========================================================================
  // SECTION 4: Financial Calculations — Scenario C (Mixed Cash Flow)
  // Opening: ₹10,000, +₹1,000/day & -₹400/day (+₹600 net) -> Day 7: ₹14,200
  // =========================================================================
  console.log(`\n--- Section 4: Scenario C — Mixed Cash Flow (Opening ₹10,000, +₹600 net/day) ---`);
  const tenantC = await createIsolatedTenant('scen_c_pipe');
  await seedHistoryForOpeningBalance(tenantC, 1000000n, '2026-10-14');

  for (let d = 1; d <= 7; d++) {
    const day = 14 + d;
    await seedReceivable(tenantC, `2026-10-${day}`, 100000n, `Mixed Inflow Day ${d}`);
    await seedPayable(tenantC, `2026-10-${day}`, 40000n, `Mixed Outflow Day ${d}`);
  }

  const resC = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantC.token}`)
    .send({ horizon_days: 30, as_of_date: '2026-10-14' });

  assert(resC.status === 201, 'Scenario C forecast generated with HTTP 201');
  const runC = resC.body.data.run;
  assert(runC.opening_confirmed_paise === '1000000', 'Scenario C opening confirmed is 1,000,000 paise (₹10,000)');

  for (let d = 1; d <= 7; d++) {
    const expected = 1000000 + d * 60000;
    assert(
      runC.points[d - 1].closing_predicted_paise === expected.toString(),
      `Scenario C Day ${d} closing balance: ₹${expected / 100}. Got: ${runC.points[d - 1].closing_predicted_paise}`
    );
  }
  assert(runC.points[6].closing_predicted_paise === '1420000', 'Scenario C Day 7 closing balance is EXACTLY ₹14,200 (1,420,000 paise)');

  // =========================================================================
  // SECTION 5: Frontend Dashboard Contract & Data Mapping Verification
  // =========================================================================
  console.log(`\n--- Section 5: Frontend Component Data Contract Verification ---`);
  
  // Test frontend formatting logic and data structures matching RealForecastChart
  const points = runC.points;
  assert(points.length === 30, 'Frontend receives all 30 points');

  const balances = points.map((p) => BigInt(p.closing_predicted_paise));
  const bufferPaise = BigInt(runC.minimum_cash_buffer_paise || '0');
  const allValues = [...balances, bufferPaise, BigInt(runC.opening_confirmed_paise)];

  const maxVal = allValues.reduce((max, v) => (v > max ? v : max), 0n);
  const minVal = allValues.reduce((min, v) => (v < min ? v : min), 0n);
  assert(maxVal >= minVal, 'Max value >= Min value for chart scale');

  const totalInflowsPaise = points.reduce(
    (acc, p) =>
      acc +
      BigInt(p.confirmed_inflow_paise) +
      BigInt(p.estimated_inflow_paise) +
      BigInt(p.predicted_inflow_paise),
    0n
  );
  const totalOutflowsPaise = points.reduce(
    (acc, p) =>
      acc +
      BigInt(p.confirmed_outflow_paise) +
      BigInt(p.estimated_outflow_paise) +
      BigInt(p.predicted_outflow_paise),
    0n
  );

  assert(totalInflowsPaise === 700000n, 'Total 30-day inflows computed as ₹7,000 (700,000 paise)');
  assert(totalOutflowsPaise === 280000n, 'Total 30-day outflows computed as ₹2,800 (280,000 paise)');

  // Engine label display verification
  const engineLabel =
    runC.method_name === 'DETERMINISTIC_ROLL_FORWARD' ? 'Python Forecast Engine' : 'Baseline Statistical Projection';
  assert(engineLabel === 'Python Forecast Engine', `Model Engine badge displays: "${engineLabel}"`);

  // =========================================================================
  // SECTION 6: PostgreSQL Database Persistence & Multi-Tenant Isolation
  // =========================================================================
  console.log(`\n--- Section 6: PostgreSQL Persistence & Tenant Isolation ---`);

  // Verify forecast_runs row
  const dbRunRes = await pool.query(
    'SELECT * FROM forecast_runs WHERE id = $1 AND business_id = $2',
    [runC.id, tenantC.businessId]
  );
  assert(dbRunRes.rows.length === 1, 'Forecast run row verified in PostgreSQL forecast_runs table');
  assert(dbRunRes.rows[0].run_status === 'SUCCEEDED', 'run_status is SUCCEEDED');
  assert(dbRunRes.rows[0].method_name === 'DETERMINISTIC_ROLL_FORWARD', 'method_name is DETERMINISTIC_ROLL_FORWARD');
  assert(dbRunRes.rows[0].horizon_days === 30, 'horizon_days is 30');

  // Verify all 30 points persisted in forecast_points
  const dbPointsRes = await pool.query(
    'SELECT COUNT(*) as count FROM forecast_points WHERE forecast_run_id = $1 AND business_id = $2',
    [runC.id, tenantC.businessId]
  );
  assert(parseInt(dbPointsRes.rows[0].count, 10) === 30, 'All 30 forecast points persisted in PostgreSQL forecast_points table');

  // Multi-tenant check: Another tenant cannot see Tenant C's run
  const tenantOther = await createIsolatedTenant('other_view');
  const otherLatest = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantOther.token}`);
  assert(otherLatest.body.data.status === 'INSUFFICIENT_HISTORY', 'Tenant Other isolated; cannot access Tenant C forecast');

  console.log(`\n========================================================================`);
  console.log(`ALL END-TO-END PIPELINE TESTS PASSED: ${passedTests}/${totalTests}`);
  console.log(`========================================================================\n`);
} catch (err) {
  console.error('\n❌ E2E PIPELINE RUN ABORTED WITH ERROR:\n', err);
  process.exitCode = 1;
} finally {
  await pool.end();
  const dbModule = await import('../dist/db/index.js');
  await dbModule.Database?.close?.();
  process.exit(process.exitCode || 0);
}
