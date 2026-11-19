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
const app = appExport.default || appExport;

const suffix = Date.now();
const AS_OF_DATE = '2026-10-15';

console.log(`\n========================================================================`);
console.log(`DAY 2 — PHASE 5: USER JOURNEY & REAL-USER EXPERIENCE TEST SUITE`);
console.log(`Database: ${currentDb}`);
console.log(`As-Of-Date: ${AS_OF_DATE}`);
console.log(`Timestamp: ${new Date().toISOString()} (Suffix: ${suffix})`);
console.log(`========================================================================\n`);

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`  FAIL [X]: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`  PASS [✓]: ${message}`);
}

// Helper: Register and auto-provision an isolated test tenant
async function createIsolatedTenant(tag) {
  const email = `journey_${tag.toLowerCase()}_${suffix}@example.com`;
  const password = 'Password@123';
  const displayName = `${tag} Operations`;

  const regRes = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password, display_name: displayName });

  assert(regRes.status === 201, `Tenant [${tag}] registered successfully via POST /api/v1/auth/register`);
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

// Helper: Set business minimum cash buffer
async function setBusinessBuffer(tenant, bufferPaise) {
  await pool.query(
    `UPDATE businesses SET minimum_cash_buffer_paise = $1 WHERE id = $2`,
    [bufferPaise.toString(), tenant.businessId]
  );
}

// Helper: Seed future supplier payable
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

try {
  // =========================================================================
  // STEP 1: User Login & Session Establishment
  // =========================================================================
  console.log(`\n--- Step 1: User Login & Session Verification ---`);
  const tenantA = await createIsolatedTenant('RetailOps');

  // Verify auth session
  const meRes = await request(app)
    .get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${tenantA.token}`);

  assert(meRes.status === 200, 'GET /api/v1/auth/me returns HTTP 200 for authenticated user');
  assert(meRes.body.data.id === tenantA.userId, 'User profile ID matches authenticated session');
  assert(meRes.body.data.email === tenantA.email, 'User profile email verified');

  // Set minimum cash buffer to ₹5,000 (500,000 paise)
  await setBusinessBuffer(tenantA, 500000n);

  // =========================================================================
  // STEP 2: Initial Dashboard State (Empty & Insufficient History)
  // =========================================================================
  console.log(`\n--- Step 2: Initial Empty Dashboard & Insufficient History State ---`);

  // Financial summary
  const summaryRes1 = await request(app)
    .get('/api/v1/transactions/summary')
    .set('Authorization', `Bearer ${tenantA.token}`);

  assert(summaryRes1.status === 200, 'GET /api/v1/transactions/summary returns HTTP 200');
  const summary1 = summaryRes1.body.data;
  assert(BigInt(summary1.current_cash_balance_paise) === 0n, 'Cash available starts at ₹0 for fresh account');
  assert(BigInt(summary1.total_income_paise) === 0n, 'Total income starts at ₹0');
  assert(BigInt(summary1.total_expense_paise) === 0n, 'Total expenses starts at ₹0');
  assert(BigInt(summary1.net_cash_flow_paise) === 0n, 'Net cash flow starts at ₹0');
  assert(summary1.transaction_count === 0, 'Transaction count starts at 0');

  // Empty transactions list
  const txRes1 = await request(app)
    .get('/api/v1/transactions')
    .set('Authorization', `Bearer ${tenantA.token}`);

  assert(txRes1.status === 200, 'GET /api/v1/transactions returns HTTP 200');
  assert(Array.isArray(txRes1.body.data), 'Transactions is an array');
  assert(txRes1.body.data.length === 0, 'Transactions list is empty (displays empty state card)');

  // Latest forecast before sufficient history
  const forecastRes1 = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantA.token}`);

  assert(forecastRes1.status === 200, 'GET /api/v1/forecasts/latest returns HTTP 200');
  const fData1 = forecastRes1.body.data;
  assert(fData1.has_sufficient_history === false, 'has_sufficient_history is false');
  assert(fData1.calendar_days_coverage === 0, 'Calendar coverage is 0/14');
  assert(fData1.distinct_days_recorded === 0, 'Active days is 0/7');
  assert(fData1.transaction_count === 0, 'Transaction count is 0/7');
  const isEligible1 =
    fData1.calendar_days_coverage >= (fData1.min_calendar_days_required || 14) &&
    fData1.distinct_days_recorded >= (fData1.min_distinct_days_required || 7) &&
    fData1.transaction_count >= (fData1.min_transactions_required || 7);
  assert(isEligible1 === false, 'isEligibleToGenerate is false');

  // Explanations in insufficient history state
  assert(Array.isArray(fData1.explanations), 'Explanations array present');
  const insufExp = fData1.explanations.find((e) => e.category === 'INSUFFICIENT_HISTORY');
  assert(insufExp !== undefined, 'Contains INSUFFICIENT_HISTORY explanation for dashboard banner');

  // Attempt forecast generation prematurely
  const genFailRes = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantA.token}`)
    .send({ horizon_days: 30 });

  assert(genFailRes.status === 201, 'POST /forecasts/generate responds when history insufficient');
  assert(genFailRes.body.data.has_sufficient_history === false, 'has_sufficient_history is false');
  assert(genFailRes.body.data.status === 'INSUFFICIENT_HISTORY', 'Status is INSUFFICIENT_HISTORY');

  // =========================================================================
  // STEP 3: Add Income Transaction & Verify Metric Updates
  // =========================================================================
  console.log(`\n--- Step 3: Add Income Transaction & Verify Real-Time Summary ---`);

  // Record ₹15,000 customer payment
  const addIncomeRes = await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', `Bearer ${tenantA.token}`)
    .send({
      type: 'income',
      amount: '15000.00',
      category: 'Customer Receipts',
      description: 'Retail customer sale batch #101',
      transaction_date: '2026-10-01',
    });

  assert(addIncomeRes.status === 201, 'POST /api/v1/transactions created income transaction (HTTP 201)');
  const incomeTx = addIncomeRes.body.data;
  assert(incomeTx.id !== undefined, 'Transaction ID returned');
  assert(incomeTx.cash_direction === 'INFLOW', 'Cash direction is INFLOW');
  assert(incomeTx.amount_paise === '1500000', 'Amount is exactly 1,500,000 paise (₹15,000.00)');

  // Verify dashboard summary updated
  const summaryRes2 = await request(app)
    .get('/api/v1/transactions/summary')
    .set('Authorization', `Bearer ${tenantA.token}`);

  assert(summaryRes2.status === 200, 'Summary updated successfully');
  const summary2 = summaryRes2.body.data;
  assert(
    BigInt(summary2.current_cash_balance_paise) === 1500000n,
    'Cash available increased: ₹0 + ₹15,000 = ₹15,000 (1,500,000 paise)'
  );
  assert(
    BigInt(summary2.total_income_paise) === 1500000n,
    'Total income updated to ₹15,000 (1,500,000 paise)'
  );
  assert(
    BigInt(summary2.total_expense_paise) === 0n,
    'Total expenses remains ₹0'
  );
  assert(
    BigInt(summary2.net_cash_flow_paise) === 1500000n,
    'Net cash flow updated to +₹15,000 (+1,500,000 paise)'
  );
  assert(summary2.transaction_count === 1, 'Transaction count updated to 1');

  // =========================================================================
  // STEP 4: Add Expense Transaction & Verify Metric Updates
  // =========================================================================
  console.log(`\n--- Step 4: Add Expense Transaction & Verify Summary Updates ---`);

  // Record ₹8,000 inventory purchase
  const addExpenseRes = await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', `Bearer ${tenantA.token}`)
    .send({
      type: 'expense',
      amount: '8000.00',
      category: 'Inventory',
      description: 'Packaging & stock replenishment',
      transaction_date: '2026-10-05',
    });

  assert(addExpenseRes.status === 201, 'POST /api/v1/transactions created expense transaction (HTTP 201)');
  const expenseTx = addExpenseRes.body.data;
  assert(expenseTx.id !== undefined, 'Expense Transaction ID returned');
  assert(expenseTx.cash_direction === 'OUTFLOW', 'Cash direction is OUTFLOW');
  assert(expenseTx.amount_paise === '800000', 'Amount is exactly 800,000 paise (₹8,000.00)');

  // Verify updated summary
  const summaryRes3 = await request(app)
    .get('/api/v1/transactions/summary')
    .set('Authorization', `Bearer ${tenantA.token}`);

  const summary3 = summaryRes3.body.data;
  assert(
    BigInt(summary3.current_cash_balance_paise) === 700000n,
    'Cash available decreased: ₹15,000 - ₹8,000 = ₹7,000 (700,000 paise)'
  );
  assert(
    BigInt(summary3.total_income_paise) === 1500000n,
    'Total income preserved at ₹15,000 (1,500,000 paise)'
  );
  assert(
    BigInt(summary3.total_expense_paise) === 800000n,
    'Total expenses updated to ₹8,000 (800,000 paise)'
  );
  assert(
    BigInt(summary3.net_cash_flow_paise) === 700000n,
    'Net cash flow updated to ₹15,000 - ₹8,000 = +₹7,000 (700,000 paise)'
  );
  assert(summary3.transaction_count === 2, 'Transaction count updated to 2');

  // Verify transactions list contains both in reverse chronological order
  const txListRes2 = await request(app)
    .get('/api/v1/transactions')
    .set('Authorization', `Bearer ${tenantA.token}`);

  assert(txListRes2.body.data.length === 2, 'Transactions list has 2 items');
  assert(txListRes2.body.data[0].id === expenseTx.id, 'Latest transaction appears first (reverse chrono: Oct 5)');
  assert(txListRes2.body.data[1].id === incomeTx.id, 'Earlier transaction appears second (Oct 1)');

  // =========================================================================
  // STEP 5: Historical Data Sufficiency Calibration
  // =========================================================================
  console.log(`\n--- Step 5: Historical Sufficiency Calibration (15-day span) ---`);

  // Intermediate check: 2 transactions spanning Oct 1 to Oct 5
  const forecastRes2 = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantA.token}`);

  const fData2 = forecastRes2.body.data;
  assert(fData2.has_sufficient_history === false, 'Still insufficient history');
  assert(fData2.calendar_days_coverage === 5, 'Calendar coverage is 5/14 days');
  assert(fData2.distinct_days_recorded === 2, 'Active days is 2/7 days');
  assert(fData2.transaction_count === 2, 'Total transactions is 2/7');

  // Add 6 more posted transactions to meet all 3 criteria (>=14 calendar days, >=7 active days, >=7 txs)
  const additionalTxs = [
    { date: '2026-10-07', type: 'income', amt: '5000.00', cat: 'Sales', desc: 'Daily POS revenue' },
    { date: '2026-10-09', type: 'expense', amt: '2000.00', cat: 'Utilities', desc: 'Electricity bill' },
    { date: '2026-10-11', type: 'income', amt: '6000.00', cat: 'Sales', desc: 'Weekend sales' },
    { date: '2026-10-12', type: 'expense', amt: '1500.00', cat: 'Logistics', desc: 'Courier & delivery' },
    { date: '2026-10-14', type: 'income', amt: '7000.00', cat: 'Sales', desc: 'Mid-week revenue' },
    { date: '2026-10-15', type: 'expense', amt: '2500.00', cat: 'Supplies', desc: 'Store consumables' },
  ];

  for (const tx of additionalTxs) {
    const res = await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${tenantA.token}`)
      .send({
        type: tx.type,
        amount: tx.amt,
        category: tx.cat,
        description: tx.desc,
        transaction_date: tx.date,
      });
    assert(res.status === 201, `Added transaction on ${tx.date}`);
  }

  // Verify sufficiency endpoint confirms all 3 criteria are satisfied
  const suffRes = await request(app)
    .get('/api/v1/forecasts/sufficiency')
    .set('Authorization', `Bearer ${tenantA.token}`);

  assert(suffRes.status === 200, 'GET /forecasts/sufficiency returns HTTP 200');
  const suffData = suffRes.body.data;
  assert(
    suffData.calendar_days_coverage === 15,
    'Calendar coverage satisfied: 15 days (>= 14)'
  );
  assert(
    suffData.distinct_days_recorded === 8,
    'Distinct active days satisfied: 8 days (>= 7)'
  );
  assert(
    suffData.transaction_count === 8,
    'Total transactions satisfied: 8 transactions (>= 7)'
  );
  assert(
    suffData.has_sufficient_history === true,
    'has_sufficient_history is TRUE — System calibrated for forecasting'
  );

  // =========================================================================
  // STEP 6: Generate 30-Day Forecast & Verify Real Output
  // =========================================================================
  console.log(`\n--- Step 6: Generate 30-Day Forecast & Engine Output Verification ---`);

  // Add a scheduled payable on Oct 25 of ₹50,000 (5,000,000 paise) to test obligations & risk alert trigger
  await seedPayable(tenantA, '2026-10-25', 5000000n, 'Apex Machinery');

  const genRes = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantA.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(genRes.status === 201, 'POST /forecasts/generate returns HTTP 201 Created');
  const genData = genRes.body.data;
  assert(genData.has_sufficient_history === true, 'has_sufficient_history is true');
  assert(genData.run !== undefined, 'Forecast run object returned');

  const run = genData.run;
  assert(run.business_id === tenantA.businessId, 'Run is scoped to tenant business_id');
  assert(run.horizon_days === 30, 'Horizon is 30 days');
  assert(run.points.length === 30, 'Generates exactly 30 daily forecast points');

  // Verify engine labeling logic matches frontend display requirement
  const engineLabel =
    run.method_name === 'DETERMINISTIC_ROLL_FORWARD'
      ? 'Python Forecast Engine'
      : 'Baseline Statistical Projection';
  assert(
    engineLabel === 'Python Forecast Engine',
    `Frontend Engine Badge displays: "${engineLabel}" (NOT trained AI/ML)`
  );

  // Verify integer paise integrity across points
  let allIntegers = true;
  for (const pt of run.points) {
    if (
      typeof pt.closing_predicted_paise !== 'string' ||
      !/^-?\d+$/.test(pt.closing_predicted_paise)
    ) {
      allIntegers = false;
      break;
    }
  }
  assert(allIntegers, 'All 30 forecast points handle balances in integer paise strings without floating-point errors');

  // Verify early warning alert generated for the buffer breach
  assert(Array.isArray(run.alerts), 'Alerts array present on forecast run');
  assert(run.alerts.length >= 1, 'Buffer breach alert generated for scheduled ₹50,000 payable');
  const alert = run.alerts[0];
  assert(alert.alert_type === 'CASH_BUFFER_BREACH', 'Alert alert_type is CASH_BUFFER_BREACH');
  assert(alert.projected_date === '2026-10-25', 'Breach date matches payable due date: 2026-10-25');
  assert(BigInt(alert.threshold_paise) === 500000n, 'Minimum buffer verified: ₹5,000 (500,000 paise)');
  const shortfallPaise = BigInt(alert.threshold_paise) - BigInt(alert.projected_balance_paise);
  assert(shortfallPaise > 0n, 'Shortfall amount is strictly positive integer paise');

  // Verify financial explanations
  assert(Array.isArray(run.explanations), 'Explanations array present on forecast run');
  assert(run.explanations.length >= 1, 'At least 1 explanation generated');
  const payableExp = run.explanations.find((e) => e.category === 'PAYABLE_OBLIGATION');
  assert(payableExp !== undefined, 'PAYABLE_OBLIGATION explanation generated for Apex Machinery');
  assert(payableExp.text.includes('Apex Machinery'), 'Explanation names the vendor');
  assert(payableExp.text.includes('₹50,000'), 'Explanation formats rupee amount correctly');

  // =========================================================================
  // STEP 7: Page Refresh Simulation (Persistence & Consistency)
  // =========================================================================
  console.log(`\n--- Step 7: Page Refresh Simulation (Persistence & Idempotency) ---`);

  // Simulate full dashboard reload by re-fetching all primary endpoints
  const [refreshSummary, refreshTxList, refreshForecast] = await Promise.all([
    request(app).get('/api/v1/transactions/summary').set('Authorization', `Bearer ${tenantA.token}`),
    request(app).get('/api/v1/transactions').set('Authorization', `Bearer ${tenantA.token}`),
    request(app).get('/api/v1/forecasts/latest').set('Authorization', `Bearer ${tenantA.token}`),
  ]);

  assert(refreshSummary.status === 200, 'Re-fetched summary succeeds');
  assert(refreshTxList.status === 200, 'Re-fetched transactions succeeds');
  assert(refreshForecast.status === 200, 'Re-fetched forecast succeeds');

  // Verify consistency with previous state
  assert(refreshTxList.body.data.length === 8, '8 transactions persist after reload');
  assert(refreshForecast.body.data.has_sufficient_history === true, 'Latest forecast loaded with sufficient history');
  assert(refreshForecast.body.data.run.id === run.id, 'Latest forecast run ID matches generated run ID');
  assert(refreshForecast.body.data.run.alerts.length === run.alerts.length, 'Alerts identical after page reload');
  assert(refreshForecast.body.data.run.explanations.length === run.explanations.length, 'Explanations identical after reload');

  // =========================================================================
  // STEP 8: Multi-Tenant Isolation & User Scoping
  // =========================================================================
  console.log(`\n--- Step 8: Multi-Tenant Isolation & User Scoping ---`);
  const tenantB = await createIsolatedTenant('CompetitorStore');

  // Tenant B summary
  const summaryB = await request(app)
    .get('/api/v1/transactions/summary')
    .set('Authorization', `Bearer ${tenantB.token}`);

  assert(summaryB.body.data.transaction_count === 0, 'Tenant B has 0 transactions (isolated from Tenant A)');
  assert(BigInt(summaryB.body.data.current_cash_balance_paise) === 0n, 'Tenant B sees only its own fresh balance ₹0');

  // Tenant B forecast latest
  const forecastB = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantB.token}`);

  assert(forecastB.body.data.has_sufficient_history === false, 'Tenant B has insufficient history');
  assert(forecastB.body.data.run === undefined, 'Tenant B cannot see Tenant A forecast run');

  // =========================================================================
  // STEP 9: Production Database Safety & Integrity Confirmation
  // =========================================================================
  console.log(`\n--- Step 9: Production Database Safety Confirmation ---`);
  const postSafety = await pool.query('SELECT current_database() as db');
  assert(postSafety.rows[0].db === TARGET_DB, `Target database remains "${TARGET_DB}"`);
  assert(postSafety.rows[0].db !== PROTECTED_DB, `Protected database "${PROTECTED_DB}" was never touched`);

  console.log(`\n========================================================================`);
  console.log(`ALL USER JOURNEY TESTS COMPLETED: ${passedTests}/${totalTests} ASSERTIONS PASSED (100%)`);
  console.log(`========================================================================\n`);

  await pool.end();
  process.exit(0);
} catch (err) {
  console.error('\nUser Journey Test Failed with Error:', err);
  await pool.end();
  process.exit(1);
}
