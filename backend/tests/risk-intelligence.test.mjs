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
const AS_OF_DATE = '2026-10-14';

console.log(`\n========================================================================`);
console.log(`DAY 2 — PHASE 3: RISK INTELLIGENCE & BUFFER BREACH TEST SUITE`);
console.log(`Database: ${currentDb}`);
console.log(`As-Of-Date: ${AS_OF_DATE}`);
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
    const email = `risk_${tag}_${suffix}@example.com`;
    const password = 'Password@123';
    const displayName = `Risk ${tag} Enterprise`;

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
  async function seedHistoryForOpeningBalance(tenant, openingPaise) {
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

  // Helper: Set business minimum cash buffer
  async function setBusinessBuffer(tenant, bufferPaise) {
    await pool.query(
      `UPDATE businesses SET minimum_cash_buffer_paise = $1 WHERE id = $2`,
      [bufferPaise.toString(), tenant.businessId]
    );
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
  // SCENARIO A: Cash remains above buffer: no alert
  // =========================================================================
  console.log(`\n--- Scenario A: Cash Remains Above Buffer -> No Alert ---`);
  const tenantA = await createIsolatedTenant('scen_a');
  // Opening: ₹100,000.00 (10,000,000 paise). Buffer: ₹50,000.00 (5,000,000 paise).
  await seedHistoryForOpeningBalance(tenantA, 10000000n);
  await setBusinessBuffer(tenantA, 5000000n);

  const genA = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantA.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(genA.status === 201, 'Scenario A forecast generated with HTTP 201');
  assert(genA.body.data.summary.has_buffer_breach === false, 'Scenario A summary: has_buffer_breach is false');
  assert(genA.body.data.summary.earliest_breach_date === null, 'Scenario A summary: earliest_breach_date is null');
  assert(Array.isArray(genA.body.data.run.alerts), 'Scenario A: alerts is an array');
  assert(genA.body.data.run.alerts.length === 0, 'Scenario A: 0 alerts created when cash remains above buffer');

  // Verify PostgreSQL risk_alerts table directly
  const dbAlertsA = await pool.query(
    `SELECT * FROM risk_alerts WHERE business_id = $1 AND forecast_run_id = $2`,
    [tenantA.businessId, genA.body.data.run.id]
  );
  assert(dbAlertsA.rows.length === 0, 'Scenario A: zero risk_alerts persisted in PostgreSQL');

  // =========================================================================
  // SCENARIO B: Cash equals buffer exactly: no breach alert
  // =========================================================================
  console.log(`\n--- Scenario B: Cash Equals Buffer Exactly -> No Breach Alert ---`);
  const tenantB = await createIsolatedTenant('scen_b');
  // Opening: ₹100,000.00 (10,000,000 paise). Buffer: ₹80,000.00 (8,000,000 paise).
  await seedHistoryForOpeningBalance(tenantB, 10000000n);
  await setBusinessBuffer(tenantB, 8000000n);

  // Payable on Day 5 (2026-10-19): ₹20,000.00 (2,000,000 paise) -> Closing on Day 5 = exactly ₹80,000.00 (8,000,000 paise)
  const day5DateB = '2026-10-19';
  await seedPayable(tenantB, day5DateB, 2000000n, 'Supplier Exact Drop');

  const genB = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantB.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(genB.status === 201, 'Scenario B forecast generated with HTTP 201');
  const day5PointB = genB.body.data.run.points.find((p) => p.forecast_date === day5DateB);
  assert(day5PointB !== undefined, 'Scenario B Day 5 point exists');
  assert(
    day5PointB.closing_with_estimates_paise === '8000000',
    `Scenario B Day 5 closing is exactly 8000000 paise (equal to buffer)`
  );
  assert(genB.body.data.summary.has_buffer_breach === false, 'Scenario B: has_buffer_breach is false when balance equals buffer');
  assert(genB.body.data.run.alerts.length === 0, 'Scenario B: no breach alert created when cash equals buffer exactly');

  const dbAlertsB = await pool.query(
    `SELECT * FROM risk_alerts WHERE business_id = $1 AND forecast_run_id = $2`,
    [tenantB.businessId, genB.body.data.run.id]
  );
  assert(dbAlertsB.rows.length === 0, 'Scenario B: zero risk_alerts in database when balance equals buffer');

  // =========================================================================
  // SCENARIO C: Cash falls below buffer: alert generated with breach date,
  // projected balance, buffer, shortfall, severity
  // =========================================================================
  console.log(`\n--- Scenario C: Cash Falls Below Buffer -> Comprehensive Alert ---`);
  
  // C1: Warning severity (projected balance >= 0 but < buffer)
  const tenantC1 = await createIsolatedTenant('scen_c1');
  // Opening: ₹100,000.00 (10,000,000 paise). Buffer: ₹80,000.00 (8,000,000 paise).
  await seedHistoryForOpeningBalance(tenantC1, 10000000n);
  await setBusinessBuffer(tenantC1, 8000000n);

  // Payable on Day 5 (2026-10-19): ₹40,000.00 (4,000,000 paise) -> Closing on Day 5 = ₹60,000.00 (6,000,000 paise)
  // Shortfall = 80,000 - 60,000 = ₹20,000.00 (2,000,000 paise)
  const day5DateC1 = '2026-10-19';
  await seedPayable(tenantC1, day5DateC1, 4000000n, 'Raw Materials Invoice');

  const genC1 = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantC1.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(genC1.status === 201, 'Scenario C1 forecast generated with HTTP 201');
  assert(genC1.body.data.summary.has_buffer_breach === true, 'Scenario C1: has_buffer_breach is true');
  assert(genC1.body.data.summary.earliest_breach_date === day5DateC1, `Scenario C1 earliest_breach_date matches ${day5DateC1}`);
  assert(genC1.body.data.run.alerts.length === 1, 'Scenario C1: exactly 1 alert returned');

  const alertC1 = genC1.body.data.run.alerts[0];
  assert(alertC1.projected_date === day5DateC1, `Scenario C1 alert expected breach date is ${day5DateC1}`);
  assert(alertC1.threshold_paise === '8000000', 'Scenario C1 minimum buffer is 8000000 paise');
  assert(alertC1.projected_balance_paise === '6000000', 'Scenario C1 projected balance is 6000000 paise');
  assert(alertC1.severity === 'WARNING', 'Scenario C1 severity is WARNING (balance >= 0)');

  const shortfallC1 = BigInt(alertC1.threshold_paise) - BigInt(alertC1.projected_balance_paise);
  assert(shortfallC1 === 2000000n, `Scenario C1 shortfall is exactly 2000000 paise (₹20,000.00)`);
  assert(alertC1.explanation.includes('60,000.00'), 'Scenario C1 explanation includes projected balance ₹60,000.00');
  assert(alertC1.explanation.includes('20,000.00'), 'Scenario C1 explanation includes shortfall ₹20,000.00');
  assert(alertC1.explanation.includes('80,000.00'), 'Scenario C1 explanation includes buffer ₹80,000.00');

  // Verify DB persistence of Scenario C1 alert
  const dbAlertsC1 = await pool.query(
    `SELECT * FROM risk_alerts WHERE business_id = $1 AND forecast_run_id = $2`,
    [tenantC1.businessId, genC1.body.data.run.id]
  );
  assert(dbAlertsC1.rows.length === 1, 'Scenario C1: exactly 1 risk_alert persisted in PostgreSQL');
  assert(dbAlertsC1.rows[0].alert_type === 'CASH_BUFFER_BREACH', 'Scenario C1 DB alert_type is CASH_BUFFER_BREACH');
  assert(dbAlertsC1.rows[0].severity === 'WARNING', 'Scenario C1 DB severity is WARNING');
  assert(dbAlertsC1.rows[0].status === 'OPEN', 'Scenario C1 DB status is OPEN');

  // C2: Critical severity (projected balance < 0)
  const tenantC2 = await createIsolatedTenant('scen_c2');
  // Opening: ₹50,000.00 (5,000,000 paise). Buffer: ₹20,000.00 (2,000,000 paise).
  await seedHistoryForOpeningBalance(tenantC2, 5000000n);
  await setBusinessBuffer(tenantC2, 2000000n);

  // Payable on Day 7 (2026-10-21): ₹70,000.00 (7,000,000 paise) -> Closing on Day 7 = -₹20,000.00 (-2,000,000 paise)
  // Shortfall = 20,000 - (-20,000) = ₹40,000.00 (4,000,000 paise)
  const day7DateC2 = '2026-10-21';
  await seedPayable(tenantC2, day7DateC2, 7000000n, 'Massive Machinery Lease');

  const genC2 = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantC2.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(genC2.status === 201, 'Scenario C2 forecast generated with HTTP 201');
  const alertC2 = genC2.body.data.run.alerts[0];
  assert(alertC2 !== undefined, 'Scenario C2 alert exists');
  assert(alertC2.severity === 'CRITICAL', 'Scenario C2 severity is CRITICAL (projected balance < 0)');
  assert(alertC2.projected_balance_paise === '-2000000', 'Scenario C2 projected balance is -2000000 paise');
  const shortfallC2 = BigInt(alertC2.threshold_paise) - BigInt(alertC2.projected_balance_paise);
  assert(shortfallC2 === 4000000n, 'Scenario C2 shortfall is 4000000 paise (₹40,000.00)');

  // =========================================================================
  // SCENARIO D: Cash falls below buffer multiple times:
  // correctly identify first breach and avoid duplicate alerts
  // =========================================================================
  console.log(`\n--- Scenario D: Multiple Breaches -> First Breach Only & No Duplicates ---`);
  const tenantD = await createIsolatedTenant('scen_d');
  // Opening: ₹100,000.00 (10,000,000 paise). Buffer: ₹80,000.00 (8,000,000 paise).
  await seedHistoryForOpeningBalance(tenantD, 10000000n);
  await setBusinessBuffer(tenantD, 8000000n);

  // Day 4 (2026-10-18): Payable ₹30,000 -> Closing ₹70,000 (< 80,000 buffer) [BREACH 1 - EARLIEST]
  const day4DateD = '2026-10-18';
  await seedPayable(tenantD, day4DateD, 3000000n, 'Bill 1');

  // Day 8 (2026-10-22): Payable ₹20,000 -> Closing ₹50,000 (< 80,000 buffer) [BREACH 2]
  const day8DateD = '2026-10-22';
  await seedPayable(tenantD, day8DateD, 2000000n, 'Bill 2');

  // Day 12 (2026-10-26): Payable ₹30,000 -> Closing ₹20,000 (< 80,000 buffer) [BREACH 3]
  const day12DateD = '2026-10-26';
  await seedPayable(tenantD, day12DateD, 3000000n, 'Bill 3');

  const genD = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantD.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(genD.status === 201, 'Scenario D forecast generated with HTTP 201');
  assert(genD.body.data.run.alerts.length === 1, 'Scenario D: exactly 1 alert generated despite multiple breach days');
  assert(genD.body.data.summary.earliest_breach_date === day4DateD, `Scenario D earliest_breach_date is Day 4 (${day4DateD})`);
  assert(genD.body.data.run.alerts[0].projected_date === day4DateD, `Scenario D alert projected_date is Day 4 (${day4DateD})`);
  assert(genD.body.data.run.alerts[0].projected_balance_paise === '7000000', 'Scenario D projected balance matches first breach day (7000000 paise)');

  // DB check: Ensure PostgreSQL table has exactly 1 row
  const dbAlertsD = await pool.query(
    `SELECT COUNT(*) as count FROM risk_alerts WHERE business_id = $1 AND forecast_run_id = $2`,
    [tenantD.businessId, genD.body.data.run.id]
  );
  assert(Number(dbAlertsD.rows[0].count) === 1, 'Scenario D: exactly 1 row in risk_alerts table, zero duplicate rows');

  // =========================================================================
  // SCENARIO E: Different tenants have different minimum buffers:
  // no cross-tenant leakage
  // =========================================================================
  console.log(`\n--- Scenario E: Multi-Tenant Buffer Isolation -> Zero Cross-Tenant Leakage ---`);
  const tenantE1 = await createIsolatedTenant('scen_e1');
  const tenantE2 = await createIsolatedTenant('scen_e2');

  // Both have Opening: ₹60,000.00 (6,000,000 paise)
  await seedHistoryForOpeningBalance(tenantE1, 6000000n);
  await seedHistoryForOpeningBalance(tenantE2, 6000000n);

  // Tenant E1 sets High Buffer: ₹90,000.00 (9,000,000 paise) -> Current cash ₹60,000 is BELOW buffer -> BREACH!
  await setBusinessBuffer(tenantE1, 9000000n);

  // Tenant E2 sets Low Buffer: ₹40,000.00 (4,000,000 paise) -> Current cash ₹60,000 is ABOVE buffer -> SAFE!
  await setBusinessBuffer(tenantE2, 4000000n);

  const genE1 = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantE1.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  const genE2 = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantE2.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(genE1.status === 201, 'Tenant E1 forecast generated with HTTP 201');
  assert(genE2.status === 201, 'Tenant E2 forecast generated with HTTP 201');

  assert(genE1.body.data.summary.has_buffer_breach === true, 'Tenant E1 with ₹90k buffer reports breach');
  assert(genE1.body.data.run.alerts.length === 1, 'Tenant E1 receives 1 alert');
  assert(genE1.body.data.run.alerts[0].threshold_paise === '9000000', 'Tenant E1 alert threshold is 9000000 paise');

  assert(genE2.body.data.summary.has_buffer_breach === false, 'Tenant E2 with ₹40k buffer reports safe status');
  assert(genE2.body.data.run.alerts.length === 0, 'Tenant E2 receives 0 alerts');

  // Tenant E2 querying /latest MUST NOT see Tenant E1's alert
  const latestE2 = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantE2.token}`);

  assert(latestE2.status === 200, 'Tenant E2 /forecasts/latest returns 200');
  assert(latestE2.body.data.summary.has_buffer_breach === false, 'Tenant E2 /latest reports no buffer breach');
  assert(latestE2.body.data.run.alerts.length === 0, 'Tenant E2 /latest contains 0 alerts (no leakage from E1)');

  // DB verification: E1 alert exists, E2 alert does not
  const dbAlertsE1 = await pool.query(
    `SELECT * FROM risk_alerts WHERE business_id = $1`,
    [tenantE1.businessId]
  );
  const dbAlertsE2 = await pool.query(
    `SELECT * FROM risk_alerts WHERE business_id = $1`,
    [tenantE2.businessId]
  );
  assert(dbAlertsE1.rows.length === 1, 'Tenant E1 has exactly 1 DB alert');
  assert(dbAlertsE2.rows.length === 0, 'Tenant E2 has exactly 0 DB alerts');

  // =========================================================================
  // SCENARIO F: Forecast regenerated with changed movements:
  // old and new forecast alerts handled consistently
  // =========================================================================
  console.log(`\n--- Scenario F: Forecast Regeneration & Alert Transition ---`);
  const tenantF = await createIsolatedTenant('scen_f');
  // Opening: ₹60,000.00 (6,000,000 paise). Buffer: ₹50,000.00 (5,000,000 paise).
  await seedHistoryForOpeningBalance(tenantF, 6000000n);
  await setBusinessBuffer(tenantF, 5000000n);

  // Step F1: Payable on Day 5 (2026-10-19): ₹20,000.00 -> Cash drops to ₹40,000 (< ₹50,000 buffer) -> Alert
  const day5DateF = '2026-10-19';
  await seedPayable(tenantF, day5DateF, 2000000n, 'Bill causing breach');

  const run1 = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantF.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(run1.status === 201, 'Run 1 generated with HTTP 201');
  assert(run1.body.data.summary.has_buffer_breach === true, 'Run 1 has buffer breach');
  assert(run1.body.data.summary.earliest_breach_date === day5DateF, 'Run 1 earliest breach date is Day 5');
  assert(run1.body.data.run.alerts.length === 1, 'Run 1 returned 1 alert');

  // Step F2: New receivable arrives on Day 3 (2026-10-17): ₹50,000.00 -> Day 5 cash becomes 60k + 50k - 20k = 90k (> 50k buffer)
  const day3DateF = '2026-10-17';
  await seedReceivable(tenantF, day3DateF, 5000000n, 'Customer payment resolving breach');

  const run2 = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantF.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(run2.status === 201, 'Run 2 generated with HTTP 201');
  assert(run2.body.data.summary.has_buffer_breach === false, 'Run 2 has no buffer breach after customer payment');
  assert(run2.body.data.summary.earliest_breach_date === null, 'Run 2 earliest_breach_date is null');
  assert(run2.body.data.run.alerts.length === 0, 'Run 2 returned 0 alerts');

  // Verify GET /latest returns Run 2 with 0 alerts
  const latestAfterRun2 = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantF.token}`);

  assert(latestAfterRun2.body.data.run.id === run2.body.data.run.id, 'GET /latest returns Run 2 ID');
  assert(latestAfterRun2.body.data.summary.has_buffer_breach === false, 'GET /latest shows buffer protected (no breach)');
  assert(latestAfterRun2.body.data.run.alerts.length === 0, 'GET /latest contains 0 active alerts for Run 2');

  // DB verification: Run 1 alert is still archived under Run 1's run_id, Run 2 has 0 alerts
  const dbAlertsRun1 = await pool.query(
    `SELECT * FROM risk_alerts WHERE forecast_run_id = $1`,
    [run1.body.data.run.id]
  );
  const dbAlertsRun2 = await pool.query(
    `SELECT * FROM risk_alerts WHERE forecast_run_id = $1`,
    [run2.body.data.run.id]
  );
  assert(dbAlertsRun1.rows.length === 1, 'Run 1 alert is preserved in DB audit trail');
  assert(dbAlertsRun2.rows.length === 0, 'Run 2 has 0 alerts in DB');

  // Step F3: Large payable added on Day 10 (2026-10-24): ₹150,000 -> Cash on Day 10 drops to negative (< 0, CRITICAL breach)
  const day10DateF = '2026-10-24';
  await seedPayable(tenantF, day10DateF, 15000000n, 'Heavy machinery purchase');

  const run3 = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantF.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(run3.status === 201, 'Run 3 generated with HTTP 201');
  assert(run3.body.data.summary.has_buffer_breach === true, 'Run 3 has buffer breach');
  assert(run3.body.data.summary.earliest_breach_date === day10DateF, 'Run 3 earliest breach date updated to Day 10');
  assert(run3.body.data.run.alerts.length === 1, 'Run 3 has 1 alert');
  assert(run3.body.data.run.alerts[0].projected_date === day10DateF, 'Run 3 alert projected date is Day 10');
  assert(run3.body.data.run.alerts[0].severity === 'CRITICAL', 'Run 3 alert severity is CRITICAL (cash drops negative)');

  const latestAfterRun3 = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantF.token}`);

  assert(latestAfterRun3.body.data.run.id === run3.body.data.run.id, 'GET /latest returns Run 3 ID');
  assert(latestAfterRun3.body.data.summary.has_buffer_breach === true, 'GET /latest shows updated buffer breach');
  assert(latestAfterRun3.body.data.run.alerts.length === 1, 'GET /latest displays 1 alert for Run 3');

  console.log(`\n========================================================================`);
  console.log(`🎉 ALL RISK INTELLIGENCE SCENARIOS PASSED: ${passedTests}/${totalTests} assertions`);
  console.log(`========================================================================\n`);

} catch (err) {
  console.error('\n❌ TEST SUITE ENCOUNTERED AN ERROR:', err);
  process.exit(1);
} finally {
  await pool.end();
  const dbModule = await import('../dist/db/index.js');
  await dbModule.Database?.close?.();
  process.exit(process.exitCode || 0);
}
