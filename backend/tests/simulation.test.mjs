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

// 1. Pre-flight database safety check
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

// 2. Import compiled Express application
import appExport from '../dist/app.js';
const app = appExport.default || appExport;

const suffix = Date.now();
console.log(`\n========================================`);
console.log(`CASHFLOW SENTINEL - WHAT-IF SIMULATION SUITE`);
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

// ----------------------------------------------------
// Step 0: Provisioning Test Tenants
// ----------------------------------------------------
console.log(`--- Step 0: Provisioning Test Tenants ---`);
async function createTestTenant(tag) {
  const email = `sim_${tag}_${suffix}@example.com`;
  const password = 'Password@123';
  const displayName = `Simulation Merchant ${tag}`;

  const regRes = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, display_name: displayName });

  assert(regRes.status === 201, `Tenant ${tag} registered with HTTP 201`);
  const token = regRes.body.data.access_token;
  const userId = regRes.body.data.user.id;

  // Make initial request to ensure tenant context is established
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

const tenantA = await createTestTenant('Alpha');
const tokenA = tenantA.token;
const businessIdA = tenantA.businessId;

const tenantB = await createTestTenant('Beta');
const tokenB = tenantB.token;
const businessIdB = tenantB.businessId;

assert(businessIdA !== businessIdB, 'Tenant Alpha and Beta belong to distinct businesses');

// Set operating buffer of ₹20,000 for Tenant Alpha
await pool.query(
  `UPDATE businesses SET minimum_cash_buffer_paise = 2000000 WHERE id = $1`,
  [businessIdA]
);

// Fetch categories for seeding
const catRes = await request(app)
  .get('/api/v1/transactions/categories')
  .set('Authorization', `Bearer ${tokenA}`);
assert(catRes.status === 200, 'Categories endpoint returned HTTP 200');
const catSales = catRes.body.data.find(
  (c) => c.allowed_direction === 'INFLOW' || c.allowed_direction === 'BOTH'
);
const catRent = catRes.body.data.find(
  (c) => c.allowed_direction === 'OUTFLOW' || c.allowed_direction === 'BOTH'
);

// ----------------------------------------------------
// Step 1: Seed History & Generate Baseline Forecast
// ----------------------------------------------------
console.log(`\n--- Step 1: Seeding 15 Days of History for Baseline Forecast ---`);

const dates = [
  '2026-11-01',
  '2026-11-03',
  '2026-11-05',
  '2026-11-07',
  '2026-11-09',
  '2026-11-11',
  '2026-11-13',
  '2026-11-15',
];

for (let i = 0; i < dates.length; i++) {
  const d = dates[i];
  const txRes = await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      amount: '5000.00',
      cash_direction: 'INFLOW',
      category_id: catSales.id,
      description: `Sales revenue installment #${i + 1}`,
      transaction_date: d,
    });
  assert(txRes.status === 201, `Seeded income transaction for ${d}`);
}

// Generate baseline 30-day forecast
const genRes = await request(app)
  .post('/api/v1/forecasts/generate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({ horizon_days: 30, as_of_date: '2026-11-16' });

assert(genRes.status === 201, 'Baseline forecast generated with HTTP 201');
assert(genRes.body.data.has_sufficient_history === true, 'Baseline forecast has sufficient history');
const baselineForecastId = genRes.body.data.run.id;
assert(typeof baselineForecastId === 'string', 'Received baseline forecast UUID');
assert(genRes.body.data.run.points.length === 30, 'Baseline forecast has exactly 30 daily points');

// ----------------------------------------------------
// Step 2: Scenario 1 — DELAYED_RECEIPT
// ----------------------------------------------------
console.log(`\n--- Step 2: Scenario 1 — DELAYED_RECEIPT ---`);
const delayRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'DELAYED_RECEIPT',
    amount: 10000,
    original_date: '2026-11-20',
    delay_days: 5,
  });

assert(delayRes.status === 200, 'Delayed receipt simulation returned HTTP 200');
const delayData = delayRes.body.data;
assert(delayData.baseline_forecast_id === baselineForecastId, 'Response links to correct baseline ID');
assert(delayData.scenario_type === 'DELAYED_RECEIPT', 'Response reports scenario_type DELAYED_RECEIPT');
assert(delayData.scenario_summary.includes('10,000.00'), 'Summary mentions formatted amount ₹10,000.00');
assert(delayData.scenario_summary.includes('5 day(s)'), 'Summary mentions 5 day(s)');
assert(delayData.baseline_points.length === 30, 'Baseline points count is 30');
assert(delayData.simulated_points.length === 30, 'Simulated points count is 30');

// Verify delta math: Between 2026-11-20 and 2026-11-24, cash is lower by 10,000 rupees (1,000,000 paise)
const pNov20 = delayData.simulated_points.find((p) => p.forecast_date === '2026-11-20');
assert(pNov20 !== undefined, 'Found point for 2026-11-20');
assert(pNov20.difference_paise === '-1000000', 'Nov 20 cash is lower by 1,000,000 paise (-₹10,000)');
assert(pNov20.difference_rupees === -10000, 'Nov 20 difference_rupees is -10000');

// Once delayed cash arrives on 2026-11-25, difference returns to 0
const pNov25 = delayData.simulated_points.find((p) => p.forecast_date === '2026-11-25');
assert(pNov25 !== undefined, 'Found point for 2026-11-25');
assert(pNov25.difference_paise === '0', 'Nov 25 cash difference returns to 0');
assert(delayData.closing_balance_difference_paise === '0', 'Final day closing balance difference is 0');

// ----------------------------------------------------
// Step 3: Scenario 2 — EARLIER_RECEIPT
// ----------------------------------------------------
console.log(`\n--- Step 3: Scenario 2 — EARLIER_RECEIPT ---`);
const earlierRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'EARLIER_RECEIPT',
    amount: 15000,
    original_date: '2026-11-28',
    new_date: '2026-11-22',
  });

assert(earlierRes.status === 200, 'Earlier receipt simulation returned HTTP 200');
const earlierData = earlierRes.body.data;
assert(earlierData.scenario_type === 'EARLIER_RECEIPT', 'Response reports scenario_type EARLIER_RECEIPT');

// Verify cash is higher between 2026-11-22 and 2026-11-27
const pNov22 = earlierData.simulated_points.find((p) => p.forecast_date === '2026-11-22');
assert(pNov22.difference_paise === '1500000', 'Nov 22 cash is higher by 1,500,000 paise (+₹15,000)');
assert(pNov22.difference_rupees === 15000, 'Nov 22 difference_rupees is 15000');

const pNov28 = earlierData.simulated_points.find((p) => p.forecast_date === '2026-11-28');
assert(pNov28.difference_paise === '0', 'Nov 28 cash difference returns to 0');

// ----------------------------------------------------
// Step 4: Scenario 3 — NEW_PURCHASE
// ----------------------------------------------------
console.log(`\n--- Step 4: Scenario 3 — NEW_PURCHASE ---`);
const purchaseRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'NEW_PURCHASE',
    amount: 8000,
    date: '2026-11-22',
    description: 'New inventory storage racks',
  });

assert(purchaseRes.status === 200, 'New purchase simulation returned HTTP 200');
const purchaseData = purchaseRes.body.data;
assert(purchaseData.scenario_type === 'NEW_PURCHASE', 'Response reports scenario_type NEW_PURCHASE');
assert(purchaseData.scenario_summary.includes('8,000.00'), 'Summary mentions ₹8,000.00');

// Before Nov 22: delta = 0
const pNov21Purchase = purchaseData.simulated_points.find((p) => p.forecast_date === '2026-11-21');
assert(pNov21Purchase.difference_paise === '0', 'Pre-purchase date diff is 0');

// From Nov 22 onwards: delta = -800000 paise (-₹8,000)
const pNov22Purchase = purchaseData.simulated_points.find((p) => p.forecast_date === '2026-11-22');
assert(pNov22Purchase.difference_paise === '-800000', 'Purchase date diff is -800,000 paise');

const pFinalPurchase = purchaseData.simulated_points[purchaseData.simulated_points.length - 1];
assert(pFinalPurchase.difference_paise === '-800000', 'Final day diff reflects purchase cost: -800,000 paise');
assert(purchaseData.closing_balance_difference_paise === '-800000', 'closing_balance_difference_paise === -800000');
assert(purchaseData.closing_balance_difference_rupees === -8000, 'closing_balance_difference_rupees === -8000');

// ----------------------------------------------------
// Step 4b: Scenario 4 — EXPENSE_CHANGE
// ----------------------------------------------------
console.log(`\n--- Step 4b: Scenario 4 — EXPENSE_CHANGE ---`);
const expenseRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'EXPENSE_CHANGE',
    amount: 3000,
    date: '2026-11-20',
    description: 'Utility bill rate increase',
  });

assert(expenseRes.status === 200, 'Expense change simulation returned HTTP 200');
const expenseData = expenseRes.body.data;
assert(expenseData.scenario_type === 'EXPENSE_CHANGE', 'Response reports scenario_type EXPENSE_CHANGE');
assert(expenseData.scenario_summary.includes('3,000.00'), 'Summary mentions ₹3,000.00');

// From Nov 20 onwards: delta = -300000 paise (-₹3,000)
const pNov20Expense = expenseData.simulated_points.find((p) => p.forecast_date === '2026-11-20');
assert(pNov20Expense.difference_paise === '-300000', 'Expense date diff is -300,000 paise');
assert(expenseData.closing_balance_difference_paise === '-300000', 'closing balance difference is -300000 paise');

// ----------------------------------------------------
// Step 4c: Scenario 5 — MANUAL_CASH_MOVEMENT
// ----------------------------------------------------
console.log(`\n--- Step 4c: Scenario 5 — MANUAL_CASH_MOVEMENT ---`);
const movementRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'MANUAL_CASH_MOVEMENT',
    direction: 'INFLOW',
    amount: 5000,
    date: '2026-11-21',
    description: 'Owner equity injection',
  });

assert(movementRes.status === 200, 'Manual cash movement simulation returned HTTP 200');
const movementData = movementRes.body.data;
assert(movementData.scenario_type === 'MANUAL_CASH_MOVEMENT', 'Response reports scenario_type MANUAL_CASH_MOVEMENT');
assert(movementData.scenario_summary.includes('5,000.00'), 'Summary mentions ₹5,000.00');

const pNov21Movement = movementData.simulated_points.find((p) => p.forecast_date === '2026-11-21');
assert(pNov21Movement.difference_paise === '500000', 'Movement date diff is +500,000 paise');
assert(movementData.closing_balance_difference_paise === '500000', 'closing balance difference is +500000 paise');

// ----------------------------------------------------
// Step 5: Cash-Buffer Breach Detection
// ----------------------------------------------------
console.log(`\n--- Step 5: Cash-Buffer Breach Detection ---`);
// Baseline balance is ₹40,000 (4,000,000 paise), buffer is ₹20,000 (2,000,000 paise).
// A large purchase of ₹25,000 drops closing balance to ₹15,000 (< ₹20,000 buffer), triggering AT_RISK.
const breachRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'NEW_PURCHASE',
    amount: 25000,
    date: '2026-11-20',
  });

assert(breachRes.status === 200, 'Breach simulation returned HTTP 200');
const breachData = breachRes.body.data;
assert(breachData.baseline_risk_status === 'PROTECTED', 'Baseline risk status is PROTECTED');
assert(breachData.simulated_risk_status === 'AT_RISK', 'Simulated risk status updated to AT_RISK');

const breachedPoints = breachData.simulated_points.filter((p) => p.buffer_breached);
assert(breachedPoints.length > 0, `Detected ${breachedPoints.length} points with buffer_breached === true`);
assert(breachedPoints[0].forecast_date === '2026-11-20', 'Earliest buffer breach occurs on purchase date 2026-11-20');

// A massive purchase of ₹50,000 drops closing balance to -₹10,000 (< 0), triggering CRITICAL.
const criticalRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'NEW_PURCHASE',
    amount: 50000,
    date: '2026-11-20',
  });

assert(criticalRes.status === 200, 'Critical breach simulation returned HTTP 200');
assert(criticalRes.body.data.simulated_risk_status === 'CRITICAL', 'Simulated risk status is CRITICAL when balance dips below 0');

// ----------------------------------------------------
// Step 6: Omission of baseline_forecast_id (Auto-resolves Latest)
// ----------------------------------------------------
console.log(`\n--- Step 6: Omission of baseline_forecast_id (Auto-resolves Latest) ---`);
const autoRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    scenario_type: 'NEW_PURCHASE',
    amount: 1000,
    date: '2026-11-20',
  });

assert(autoRes.status === 200, 'Simulate without explicit baseline_forecast_id returns HTTP 200');
assert(autoRes.body.data.baseline_forecast_id === baselineForecastId, 'Auto-resolved latest baseline forecast');

// ----------------------------------------------------
// Step 7: Input Validation Errors
// ----------------------------------------------------
console.log(`\n--- Step 7: Input Validation Errors ---`);

// 1. Invalid scenario type
const badScenario = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'INVALID_SCENARIO_TYPE',
    amount: 5000,
    date: '2026-11-20',
  });
assert(badScenario.status === 422, 'Invalid scenario_type rejected with HTTP 422');
assert(badScenario.body.error.code === 'VALIDATION_ERROR', 'Error code is VALIDATION_ERROR');

// 2. Negative amount
const negAmount = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'NEW_PURCHASE',
    amount: -500,
    date: '2026-11-20',
  });
assert(negAmount.status === 422, 'Negative amount rejected with HTTP 422');

// 3. Zero amount for purchase
const zeroAmount = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'NEW_PURCHASE',
    amount: 0,
    date: '2026-11-20',
  });
assert(zeroAmount.status === 422, 'Zero amount rejected with HTTP 422');

// 4. Invalid date format
const badDate = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'NEW_PURCHASE',
    amount: 5000,
    date: '2026-13-45',
  });
assert(badDate.status === 422, 'Malformed calendar date rejected with HTTP 422');

// 5. Delayed receipt with new_date before original_date
const badOrderDate = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'DELAYED_RECEIPT',
    amount: 5000,
    original_date: '2026-11-25',
    new_date: '2026-11-20',
  });
assert(badOrderDate.status === 422, 'DELAYED_RECEIPT with new_date < original_date rejected with HTTP 422');

// ----------------------------------------------------
// Step 8: Nonexistent Baseline Forecast
// ----------------------------------------------------
console.log(`\n--- Step 8: Nonexistent Baseline Forecast ---`);
const missingRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: '00000000-0000-0000-0000-000000000000',
    scenario_type: 'NEW_PURCHASE',
    amount: 5000,
    date: '2026-11-20',
  });
assert(missingRes.status === 404, 'Nonexistent baseline forecast rejected with HTTP 404');
assert(missingRes.body.error.code === 'RESOURCE_NOT_FOUND', 'Error code is RESOURCE_NOT_FOUND');

// ----------------------------------------------------
// Step 9: Multi-Tenant Isolation
// ----------------------------------------------------
console.log(`\n--- Step 9: Multi-Tenant Isolation Protection ---`);
// Tenant Beta tries to run simulation using Tenant Alpha's baseline forecast
const crossTenantRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenB}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'NEW_PURCHASE',
    amount: 5000,
    date: '2026-11-20',
  });
assert(crossTenantRes.status === 404, 'Cross-tenant forecast simulation rejected with HTTP 404 (Isolation Confirmed)');

// ----------------------------------------------------
// Step 10: Python Engine Unavailable Handling
// ----------------------------------------------------
console.log(`\n--- Step 10: Python Engine Unavailable Handling ---`);
const originalAnalyticsUrl = process.env.ANALYTICS_SERVICE_URL;

try {
  // Point to a closed port
  process.env.ANALYTICS_SERVICE_URL = 'http://127.0.0.1:59999';

  const unavailableRes = await request(app)
    .post('/api/v1/forecasts/simulate')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      baseline_forecast_id: baselineForecastId,
      scenario_type: 'NEW_PURCHASE',
      amount: 5000,
      date: '2026-11-20',
    });

  assert(unavailableRes.status === 503, 'Python engine failure handled safely with HTTP 503');
  assert(unavailableRes.body.error.code === 'SERVICE_UNAVAILABLE', 'Error code is SERVICE_UNAVAILABLE');
} finally {
  // Restore original URL
  process.env.ANALYTICS_SERVICE_URL = originalAnalyticsUrl;
}

// Verify service recovers normally once URL is restored
const recoveryRes = await request(app)
  .post('/api/v1/forecasts/simulate')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'NEW_PURCHASE',
    amount: 1000,
    date: '2026-11-20',
  });
assert(recoveryRes.status === 200, 'Service recovered successfully once analytics service restored');

// ----------------------------------------------------
// Summary
// ----------------------------------------------------
await pool.end();

console.log(`\n========================================`);
console.log(`WHAT-IF SIMULATION TEST RESULTS SUMMARY`);
console.log(`========================================`);
console.log(`Total assertions: ${totalTests}`);
console.log(`Passed: ${passedTests}`);
console.log(`Failed: ${totalTests - passedTests}`);
if (passedTests === totalTests) {
  console.log(`\n🎉 ALL ${passedTests} TEST ASSERTIONS PASSED PERFECTLY!\n`);
  process.exit(0);
} else {
  console.error(`\n❌ SOME TESTS FAILED!\n`);
  process.exit(1);
}
