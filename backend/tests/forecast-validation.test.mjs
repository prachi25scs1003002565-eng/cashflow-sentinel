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
console.log(`[SAFETY CHECK PASSED] Confirmed target database is "${currentDb}"`);

// 2. Import compiled express app
import appExport from '../dist/app.js';
const app = appExport.default || appExport;

const suffix = Date.now();
console.log(`\n======================================================`);
console.log(`CASHFLOW SENTINEL — REAL FORECAST VALIDATION TEST SUITE`);
console.log(`Target Database: ${currentDb}`);
console.log(`Run Timestamp: ${new Date().toISOString()} (Suffix: ${suffix})`);
console.log(`======================================================\n`);

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
  // Helper: Create a dedicated test tenant
  async function createTestTenant(tag) {
    const email = `val_${tag}_${suffix}@example.com`;
    const password = 'Password@123';
    const displayName = `Val ${tag} Enterprise`;

    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password, display_name: displayName });

    assert(regRes.status === 201, `Tenant [${tag}] registered successfully`);
    const token = regRes.body.data.access_token;
    const userId = regRes.body.data.user.id;

    // Trigger auto-provisioning
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

    // Get primary cash account
    const accRes = await pool.query(
      `SELECT id FROM accounts WHERE business_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [businessId]
    );
    const accountId = accRes.rows[0]?.id;

    return { email, password, token, userId, businessId, accountId };
  }

  // Helper: Seed 14 days of historical transactions netting out to exact opening balance
  async function seedHistoryForOpeningBalance(tenant, openingPaise, asOfDateStr) {
    // We create 14 days of history: 2026-10-01 to 2026-10-14 (14 calendar days)
    // Days 1-10: 10 daily income entries of (openingPaise / 10)
    // Days 11-14: 4 daily paired entries of ₹100 income and ₹100 expense (net zero)
    // Total net: openingPaise. Calendar coverage: 14 days. Active days: 14 days. Total tx: 18.
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
          description: `History Day ${d}`,
        });
      if (res.status !== 201) {
        throw new Error(`Failed to seed transaction: ${JSON.stringify(res.body)}`);
      }
    }

    for (let d = 11; d <= 14; d++) {
      const dayStr = `${d}`;
      const date = `2026-10-${dayStr}`;
      // Inflow ₹100.00
      await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({
          type: 'income',
          amount: '100.00',
          transaction_date: date,
          description: `History Offset Inflow Day ${d}`,
        });
      // Outflow ₹100.00
      await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${tenant.token}`)
        .send({
          type: 'expense',
          amount: '100.00',
          transaction_date: date,
          description: `History Offset Outflow Day ${d}`,
        });
    }
  }

  // Helper: Seed future receivable (sales invoice)
  async function seedReceivable(tenant, dateStr, amountPaise, label) {
    const customerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customers (id, business_id, display_name) VALUES ($1, $2, $3)`,
      [customerId, tenant.businessId, label]
    );

    const invoiceId = crypto.randomUUID();
    const invoiceNumber = `INV-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
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

  // Helper: Seed future payable (supplier bill)
  async function seedPayable(tenant, dateStr, amountPaise, label) {
    const supplierId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO suppliers (id, business_id, display_name) VALUES ($1, $2, $3)`,
      [supplierId, tenant.businessId, label]
    );

    const billId = crypto.randomUUID();
    const billNumber = `BILL-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
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
  // PILLAR 1: Historical Data Validation & Opening Balance Correctness
  // =========================================================================
  console.log(`\n--- Pillar 1: Historical Data & Opening Balance Integrity ---`);
  const tenantHist = await createTestTenant('hist_audit');
  
  // Seed 14 days of history with ₹10,000 opening (1,000,000 paise)
  await seedHistoryForOpeningBalance(tenantHist, 1000000n, '2026-10-14');

  // Get data_source_id for raw transaction check
  const dsRes = await pool.query(
    'SELECT id FROM data_sources WHERE business_id = $1 LIMIT 1',
    [tenantHist.businessId]
  );
  const dataSourceId = dsRes.rows[0].id;

  // 1. Insert a REVERSED transaction (status = 'REVERSED') to verify non-POSTED transactions are EXCLUDED
  await pool.query(
    `INSERT INTO transactions (
      business_id, account_id, data_source_id, transaction_date, transaction_type, cash_direction, amount_paise,
      record_status, description, created_by_user_id
    ) VALUES 
      ($1, $2, $3, '2026-10-05', 'INFLOW', 'INFLOW', 500000, 'REVERSED', 'Ignored Reversed Tx', $4)`,
    [tenantHist.businessId, tenantHist.accountId, dataSourceId, tenantHist.userId]
  );

  // 2. Insert a future POSTED transaction on 2026-10-15 to verify cutoff excludes transactions after as_of_date
  await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', `Bearer ${tenantHist.token}`)
    .send({
      type: 'income',
      amount: '5000.00',
      transaction_date: '2026-10-15',
      description: 'Future transaction after as_of_date',
    });

  // Trigger forecast generation as of 2026-10-14
  const histForecastRes = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantHist.token}`)
    .send({ horizon_days: 30, as_of_date: '2026-10-14' });

  assert(histForecastRes.status === 201, 'Forecast generated successfully for history audit');
  assert(
    histForecastRes.body.data.run.opening_confirmed_paise === '1000000',
    `Opening balance is exactly 1,000,000 paise (₹10,000). Got: ${histForecastRes.body.data.run.opening_confirmed_paise}`
  );
  assert(
    histForecastRes.body.data.has_sufficient_history === true,
    'Data sufficiency verified (14 calendar days, 14 active days)'
  );

  // =========================================================================
  // PILLAR 2: Scenario A — Income Only (₹10,000 opening, ₹1,000/day inflow)
  // Expected closing after 7 days: ₹17,000 (1,700,000 paise)
  // =========================================================================
  console.log(`\n--- Pillar 2: Scenario A — Income Only (+₹1,000/day) ---`);
  const tenantA = await createTestTenant('scen_a');
  await seedHistoryForOpeningBalance(tenantA, 1000000n, '2026-10-14');

  // Seed 7 daily receivables of ₹1,000 (100,000 paise) from Day 1 to Day 7 (2026-10-15 to 2026-10-21)
  for (let d = 1; d <= 7; d++) {
    const day = 14 + d;
    const dateStr = `2026-10-${day}`;
    await seedReceivable(tenantA, dateStr, 100000n, `Customer Inflow Day ${d}`);
  }

  const resA = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantA.token}`)
    .send({ horizon_days: 30, as_of_date: '2026-10-14' });

  assert(resA.status === 201, 'Scenario A forecast generated');
  const pointsA = resA.body.data.run.points;
  assert(pointsA.length === 30, '30 forecast points returned');

  // Validate Day 1 to Day 7 balances
  for (let d = 1; d <= 7; d++) {
    const expectedClosing = 1000000 + d * 100000;
    const pt = pointsA[d - 1];
    assert(
      pt.closing_predicted_paise === expectedClosing.toString(),
      `Scenario A Day ${d} closing balance: ₹${expectedClosing / 100} (paise: ${expectedClosing}). Got: ${pt.closing_predicted_paise}`
    );
  }

  const day7PointA = pointsA[6];
  assert(
    day7PointA.closing_predicted_paise === '1700000',
    `Scenario A Day 7 closing balance is EXACTLY ₹17,000 (1,700,000 paise). Verified.`
  );

  // =========================================================================
  // PILLAR 3: Scenario B — Expenses Only (₹10,000 opening, ₹500/day outflow)
  // Expected closing after 7 days: ₹6,500 (650,000 paise)
  // =========================================================================
  console.log(`\n--- Pillar 3: Scenario B — Expenses Only (-₹500/day) ---`);
  const tenantB = await createTestTenant('scen_b');
  await seedHistoryForOpeningBalance(tenantB, 1000000n, '2026-10-14');

  // Seed 7 daily payables of ₹500 (50,000 paise) from Day 1 to Day 7 (2026-10-15 to 2026-10-21)
  for (let d = 1; d <= 7; d++) {
    const day = 14 + d;
    const dateStr = `2026-10-${day}`;
    await seedPayable(tenantB, dateStr, 50000n, `Supplier Outflow Day ${d}`);
  }

  const resB = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantB.token}`)
    .send({ horizon_days: 30, as_of_date: '2026-10-14' });

  assert(resB.status === 201, 'Scenario B forecast generated');
  const pointsB = resB.body.data.run.points;

  // Validate Day 1 to Day 7 balances
  for (let d = 1; d <= 7; d++) {
    const expectedClosing = 1000000 - d * 50000;
    const pt = pointsB[d - 1];
    assert(
      pt.closing_predicted_paise === expectedClosing.toString(),
      `Scenario B Day ${d} closing balance: ₹${expectedClosing / 100} (paise: ${expectedClosing}). Got: ${pt.closing_predicted_paise}`
    );
  }

  const day7PointB = pointsB[6];
  assert(
    day7PointB.closing_predicted_paise === '650000',
    `Scenario B Day 7 closing balance is EXACTLY ₹6,500 (650,000 paise). Verified.`
  );

  // =========================================================================
  // PILLAR 4: Scenario C — Mixed Cash Flow (₹10,000 opening, +₹1,000, -₹400/day)
  // Expected closing after 7 days: ₹14,200 (1,420,000 paise)
  // =========================================================================
  console.log(`\n--- Pillar 4: Scenario C — Mixed Cash Flow (+₹1,000, -₹400/day) ---`);
  const tenantC = await createTestTenant('scen_c');
  await seedHistoryForOpeningBalance(tenantC, 1000000n, '2026-10-14');

  // Seed 7 daily receivables of ₹1,000 (100,000 paise) and 7 payables of ₹400 (40,000 paise)
  for (let d = 1; d <= 7; d++) {
    const day = 14 + d;
    const dateStr = `2026-10-${day}`;
    await seedReceivable(tenantC, dateStr, 100000n, `Mixed Inflow Day ${d}`);
    await seedPayable(tenantC, dateStr, 40000n, `Mixed Outflow Day ${d}`);
  }

  const resC = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantC.token}`)
    .send({ horizon_days: 30, as_of_date: '2026-10-14' });

  assert(resC.status === 201, 'Scenario C forecast generated');
  const pointsC = resC.body.data.run.points;

  // Validate Day 1 to Day 7 balances (net +₹600 / +60,000 paise daily)
  for (let d = 1; d <= 7; d++) {
    const expectedClosing = 1000000 + d * 60000;
    const pt = pointsC[d - 1];
    assert(
      pt.closing_predicted_paise === expectedClosing.toString(),
      `Scenario C Day ${d} closing balance: ₹${expectedClosing / 100} (paise: ${expectedClosing}). Got: ${pt.closing_predicted_paise}`
    );
  }

  const day7PointC = pointsC[6];
  assert(
    day7PointC.closing_predicted_paise === '1420000',
    `Scenario C Day 7 closing balance is EXACTLY ₹14,200 (1,420,000 paise). Verified.`
  );

  // =========================================================================
  // PILLAR 5: Scenario D — Buffer Breach & Risk Alert Accuracy
  // Opening: ₹10,000, Buffer: ₹8,000, Outflow: ₹500/day
  // First breach date: Day 5 (2026-10-19), Closing ₹7,500 < ₹8,000
  // =========================================================================
  console.log(`\n--- Pillar 5: Scenario D — Buffer Breach Detection (Buffer ₹8,000) ---`);
  const tenantD = await createTestTenant('scen_d');
  await seedHistoryForOpeningBalance(tenantD, 1000000n, '2026-10-14');

  // Set business minimum buffer to ₹8,000 (800,000 paise)
  await pool.query(
    'UPDATE businesses SET minimum_cash_buffer_paise = 800000 WHERE id = $1',
    [tenantD.businessId]
  );

  // Seed 7 daily payables of ₹500 (50,000 paise)
  for (let d = 1; d <= 7; d++) {
    const day = 14 + d;
    const dateStr = `2026-10-${day}`;
    await seedPayable(tenantD, dateStr, 50000n, `Outflow Day ${d}`);
  }

  const resD = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantD.token}`)
    .send({ horizon_days: 30, as_of_date: '2026-10-14' });

  assert(resD.status === 201, 'Scenario D forecast generated');
  const pointsD = resD.body.data.run.points;

  // Day 1: 950000 (> 800000)
  // Day 2: 900000 (> 800000)
  // Day 3: 850000 (> 800000)
  // Day 4: 800000 (= 800000 - safe)
  // Day 5: 750000 (< 800000 - BREACH!)
  assert(pointsD[3].closing_predicted_paise === '800000', 'Day 4 balance is ₹8,000 (at buffer, not yet below)');
  assert(pointsD[4].closing_predicted_paise === '750000', 'Day 5 balance is ₹7,500 (breaches ₹8,000 buffer)');

  const alertsD = resD.body.data.run.alerts;
  assert(alertsD.length > 0, `Risk alerts generated (count: ${alertsD.length})`);

  const firstAlert = alertsD[0];
  assert(firstAlert.alert_type === 'CASH_BUFFER_BREACH', 'First alert is CASH_BUFFER_BREACH');
  assert(
    firstAlert.projected_date === '2026-10-19',
    `First breach date is EXACTLY Day 5 (2026-10-19). Got: ${firstAlert.projected_date}`
  );
  assert(
    firstAlert.threshold_paise === '800000',
    `Threshold is recorded as 800,000 paise (₹8,000). Got: ${firstAlert.threshold_paise}`
  );
  assert(
    firstAlert.projected_balance_paise === '750000',
    `Projected balance at breach is recorded as 750,000 paise (₹7,500). Got: ${firstAlert.projected_balance_paise}`
  );
  assert(
    firstAlert.severity === 'WARNING',
    `Severity is WARNING (projected balance > 0). Got: ${firstAlert.severity}`
  );

  // Check persistence in risk_alerts table
  const dbAlertsD = await pool.query(
    'SELECT * FROM risk_alerts WHERE business_id = $1 AND forecast_run_id = $2 ORDER BY projected_date ASC',
    [tenantD.businessId, resD.body.data.run.id]
  );
  assert(dbAlertsD.rows.length === alertsD.length, 'All alerts successfully persisted in PostgreSQL risk_alerts table');

  // =========================================================================
  // PILLAR 6: Multi-Tenant Data Isolation
  // =========================================================================
  console.log(`\n--- Pillar 6: Multi-Tenant Isolation ---`);
  const tenantSpy = await createTestTenant('spy');
  
  // Tenant Spy queries latest forecast
  const spyLatest = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantSpy.token}`);

  assert(spyLatest.status === 200, 'Spy queries latest forecast');
  assert(
    spyLatest.body.data.status === 'INSUFFICIENT_HISTORY',
    'Spy cannot see Tenant D or any other tenant forecast data'
  );

  // Verify direct database query isolation
  const spyDbRuns = await pool.query(
    'SELECT * FROM forecast_runs WHERE business_id = $1',
    [tenantSpy.businessId]
  );
  assert(spyDbRuns.rows.length === 0, 'No forecast runs exist for Tenant Spy in database');

  const spyDbAlerts = await pool.query(
    'SELECT * FROM risk_alerts WHERE business_id = $1',
    [tenantSpy.businessId]
  );
  assert(spyDbAlerts.rows.length === 0, 'No risk alerts exist for Tenant Spy in database');

  // =========================================================================
  // PILLAR 7: Integer Precision (No Floating-Point Errors)
  // =========================================================================
  console.log(`\n--- Pillar 7: Integer Paise Precision Test ---`);
  const tenantPrec = await createTestTenant('prec');
  await seedHistoryForOpeningBalance(tenantPrec, 1000000n, '2026-10-14');

  // Add odd paise amounts (e.g. ₹0.33, ₹0.67) to test integer rounding
  await seedReceivable(tenantPrec, '2026-10-15', 33n, 'Fractional test 1 (33 paise)');
  await seedReceivable(tenantPrec, '2026-10-15', 67n, 'Fractional test 2 (67 paise)');

  const resPrec = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantPrec.token}`)
    .send({ horizon_days: 30, as_of_date: '2026-10-14' });

  assert(resPrec.status === 201, 'Precision test forecast generated');
  const day1Prec = resPrec.body.data.run.points[0];
  // 1,000,000 + 33 + 67 = 1,000,100 exactly
  assert(
    day1Prec.closing_predicted_paise === '1000100',
    `Integer paise arithmetic is exact: 1000000 + 33 + 67 = 1,000,100. Got: ${day1Prec.closing_predicted_paise}`
  );

  console.log(`\n======================================================`);
  console.log(`ALL VALIDATION AUDIT TESTS PASSED: ${passedTests}/${totalTests}`);
  console.log(`======================================================\n`);
} catch (err) {
  console.error('\n❌ VALIDATION TEST RUN ABORTED WITH ERROR:\n', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
