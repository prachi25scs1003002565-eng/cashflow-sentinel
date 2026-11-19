import dotenv from 'dotenv';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEMO_IDS, DEMO_CREDENTIALS, seedDemoAccount } from '../scripts/seed-demo-account.mjs';

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

let totalTests = 0;
let passedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
  passedTests++;
}

console.log(`\n======================================================`);
console.log(`DEMO DATA VERIFICATION & LIVE FORECAST/SIMULATION SUITE`);
console.log(`Target Database: ${currentDb}`);
console.log(`======================================================\n`);

// 1. Seed the demo account
console.log(`--- Step 1: Seeding Demo Account ---`);
const seedResult = await seedDemoAccount(pool);
assert(seedResult.success === true, 'seedDemoAccount returned success');
assert(seedResult.transactionCount === 36, 'Seeded exactly 36 transactions');

// 2. Database Integrity Checks
console.log(`\n--- Step 2: Database Integrity Verification ---`);
const txCountRes = await pool.query(
  `SELECT 
     COUNT(*) as count,
     COUNT(DISTINCT transaction_date) as distinct_days,
     MIN(transaction_date) as earliest,
     MAX(transaction_date) as latest
   FROM transactions 
   WHERE business_id = $1 AND record_status = 'POSTED'`,
  [DEMO_IDS.BUSINESS_ID]
);
const txStats = txCountRes.rows[0];
const totalTx = parseInt(txStats.count, 10);
const distinctDays = parseInt(txStats.distinct_days, 10);
const earliest = txStats.earliest.toISOString().slice(0, 10);
const latest = txStats.latest.toISOString().slice(0, 10);

const coverageDays =
  Math.floor((new Date(latest).getTime() - new Date(earliest).getTime()) / (1000 * 60 * 60 * 24)) + 1;

assert(totalTx === 36, `36 transactions present in PostgreSQL (got ${totalTx})`);
assert(distinctDays >= 7, `At least 7 distinct transaction days (got ${distinctDays})`);
assert(coverageDays >= 14, `At least 14 calendar days of coverage (got ${coverageDays} days: ${earliest} to ${latest})`);

// Verify categories direction integrity
const invalidCatRes = await pool.query(
  `SELECT t.id, t.cash_direction, tc.allowed_direction 
   FROM transactions t
   JOIN transaction_categories tc ON tc.id = t.category_id
   WHERE t.business_id = $1 AND tc.allowed_direction <> 'BOTH' AND tc.allowed_direction <> t.cash_direction`,
  [DEMO_IDS.BUSINESS_ID]
);
assert(invalidCatRes.rows.length === 0, 'Zero category-direction mismatches (Database trigger compliance)');

// 3. Authenticate with Demo Account against local backend API (port 5000)
console.log(`\n--- Step 3: Demo Authentication via Local API (Port 5000) ---`);
const loginRes = await fetch('http://localhost:5000/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: DEMO_CREDENTIALS.email,
    password: DEMO_CREDENTIALS.password,
  }),
});
assert(loginRes.status === 200, 'Demo account login returned HTTP 200');
const loginData = await loginRes.json();
const token = loginData.data.access_token;
const user = loginData.data.user;
assert(user.email === DEMO_CREDENTIALS.email, 'Logged in user email matches demo credential');
assert(typeof token === 'string' && token.length > 20, 'Received valid JWT bearer token');

// 4. Verify Financial Summaries
console.log(`\n--- Step 4: Transaction Summary Verification ---`);
const sumRes = await fetch('http://localhost:5000/api/v1/transactions/summary', {
  headers: { Authorization: `Bearer ${token}` },
});
assert(sumRes.status === 200, 'GET /transactions/summary returned HTTP 200');
const sumData = await sumRes.json();
const summary = sumData.data;
assert(summary.transaction_count === 36, 'Transaction summary reflects 36 transactions');
assert(BigInt(summary.total_income_paise) > 0n, 'Total income is positive');
assert(BigInt(summary.total_expense_paise) > 0n, 'Total expense is positive');
console.log(`   Income: ₹${(Number(BigInt(summary.total_income_paise)) / 100).toLocaleString('en-IN')}`);
console.log(`   Expense: ₹${(Number(BigInt(summary.total_expense_paise)) / 100).toLocaleString('en-IN')}`);
console.log(`   Net Flow: ₹${(Number(BigInt(summary.net_cash_flow_paise)) / 100).toLocaleString('en-IN')}`);

// 5. Generate Real Forecast via Node.js Backend & Python AI Engine
console.log(`\n--- Step 5: Real Forecast Generation (Backend -> Python AI Engine) ---`);
const genRes = await fetch('http://localhost:5000/api/v1/forecasts/generate', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    horizon_days: 30,
    as_of_date: latest,
  }),
});
assert(genRes.status === 201, 'POST /forecasts/generate returned HTTP 201');
const genData = await genRes.json();
assert(genData.data.has_sufficient_history === true, 'Data sufficiency is TRUE');
assert(genData.data.status === 'SUCCEEDED', 'Forecast status is SUCCEEDED');
const forecastRun = genData.data.run;
assert(typeof forecastRun.id === 'string', 'Generated forecast run UUID');
assert(forecastRun.business_id === DEMO_IDS.BUSINESS_ID, 'Forecast run strictly scoped to Demo Business ID');
assert(forecastRun.points.length === 30, 'Forecast run contains exactly 30 daily projection points');

// Verify database persistence of forecast
const dbPointsRes = await pool.query(
  `SELECT COUNT(*) as count FROM forecast_points WHERE business_id = $1 AND forecast_run_id = $2`,
  [DEMO_IDS.BUSINESS_ID, forecastRun.id]
);
assert(parseInt(dbPointsRes.rows[0].count, 10) === 30, 'All 30 forecast points persisted in PostgreSQL');

// Verify latest forecast retrieval
const latestRes = await fetch('http://localhost:5000/api/v1/forecasts/latest', {
  headers: { Authorization: `Bearer ${token}` },
});
assert(latestRes.status === 200, 'GET /forecasts/latest returned HTTP 200');
const latestData = await latestRes.json();
assert(latestData.data.has_sufficient_history === true, 'Latest forecast reports has_sufficient_history === true');
assert(latestData.data.run.id === forecastRun.id, 'Latest forecast matches generated run ID');

// 6. Test All Five What-If Simulations
console.log(`\n--- Step 6: Test All 5 What-If Simulations ---`);
const baselineForecastId = forecastRun.id;
const pDay5 = forecastRun.points[4].forecast_date;
const pDay10 = forecastRun.points[9].forecast_date;
const pDay15 = forecastRun.points[14].forecast_date;

// Scenario 1: DELAYED_RECEIPT
console.log(`- Testing Scenario 1: DELAYED_RECEIPT...`);
const delayRes = await fetch('http://localhost:5000/api/v1/forecasts/simulate', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'DELAYED_RECEIPT',
    amount: 12000,
    original_date: pDay5,
    delay_days: 5,
  }),
});
assert(delayRes.status === 200, 'DELAYED_RECEIPT simulation returned HTTP 200');
const delayData = (await delayRes.json()).data;
assert(delayData.scenario_type === 'DELAYED_RECEIPT', 'Response reports DELAYED_RECEIPT');
assert(delayData.baseline_points.length === 30, 'Baseline points count is 30');
assert(delayData.simulated_points.length === 30, 'Simulated points count is 30');
assert(delayData.closing_balance_difference_paise === '0', 'Closing balance delta returns to 0 after receipt arrives');

// Scenario 2: EARLIER_RECEIPT
console.log(`- Testing Scenario 2: EARLIER_RECEIPT...`);
const earlyRes = await fetch('http://localhost:5000/api/v1/forecasts/simulate', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'EARLIER_RECEIPT',
    amount: 15000,
    original_date: pDay15,
    new_date: pDay10,
  }),
});
assert(earlyRes.status === 200, 'EARLIER_RECEIPT simulation returned HTTP 200');
const earlyData = (await earlyRes.json()).data;
assert(earlyData.scenario_type === 'EARLIER_RECEIPT', 'Response reports EARLIER_RECEIPT');
const p10Sim = earlyData.simulated_points.find((p) => p.forecast_date === pDay10);
assert(p10Sim.difference_paise === '1500000', 'Day 10 cash is higher by +₹15,000 (1,500,000 paise)');

// Scenario 3: NEW_PURCHASE (Capital Outlay with Buffer Breach Test)
console.log(`- Testing Scenario 3: NEW_PURCHASE...`);
const purchaseRes = await fetch('http://localhost:5000/api/v1/forecasts/simulate', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'NEW_PURCHASE',
    amount: 100000,
    date: pDay5,
    description: 'Commercial delivery vehicle purchase',
  }),
});
assert(purchaseRes.status === 200, 'NEW_PURCHASE simulation returned HTTP 200');
const purchaseData = (await purchaseRes.json()).data;
assert(purchaseData.scenario_type === 'NEW_PURCHASE', 'Response reports NEW_PURCHASE');
assert(purchaseData.closing_balance_difference_rupees === -100000, 'Closing balance is reduced by -₹100,000');
const breachCount = purchaseData.simulated_points.filter((p) => p.buffer_breached).length;
assert(breachCount > 0, `Detected ${breachCount} points with cash buffer breach`);
assert(purchaseData.simulated_risk_status === 'AT_RISK' || purchaseData.simulated_risk_status === 'CRITICAL', 'Elevated risk status detected');

// Scenario 4: EXPENSE_CHANGE
console.log(`- Testing Scenario 4: EXPENSE_CHANGE...`);
const expenseRes = await fetch('http://localhost:5000/api/v1/forecasts/simulate', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'EXPENSE_CHANGE',
    amount: 2500,
    date: pDay5,
    description: 'Monthly electricity tariff hike',
  }),
});
assert(expenseRes.status === 200, 'EXPENSE_CHANGE simulation returned HTTP 200');
const expenseData = (await expenseRes.json()).data;
assert(expenseData.scenario_type === 'EXPENSE_CHANGE', 'Response reports EXPENSE_CHANGE');
assert(expenseData.closing_balance_difference_rupees === -2500, 'Closing balance is reduced by -₹2,500');

// Scenario 5: MANUAL_CASH_MOVEMENT
console.log(`- Testing Scenario 5: MANUAL_CASH_MOVEMENT...`);
const moveRes = await fetch('http://localhost:5000/api/v1/forecasts/simulate', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    baseline_forecast_id: baselineForecastId,
    scenario_type: 'MANUAL_CASH_MOVEMENT',
    direction: 'INFLOW',
    amount: 10000,
    date: pDay5,
    description: 'Partner equity contribution',
  }),
});
assert(moveRes.status === 200, 'MANUAL_CASH_MOVEMENT simulation returned HTTP 200');
const moveData = (await moveRes.json()).data;
assert(moveData.scenario_type === 'MANUAL_CASH_MOVEMENT', 'Response reports MANUAL_CASH_MOVEMENT');
assert(moveData.closing_balance_difference_rupees === 10000, 'Closing balance is increased by +₹10,000');

// 7. Verify Financial Data Ledger Immutability
console.log(`\n--- Step 7: Ledger Immutability Verification ---`);
const afterTxCountRes = await pool.query(
  `SELECT COUNT(*) as count FROM transactions WHERE business_id = $1`,
  [DEMO_IDS.BUSINESS_ID]
);
assert(
  parseInt(afterTxCountRes.rows[0].count, 10) === 36,
  'Actual ledger transaction count remains strictly 36 after all simulations (Immutability Confirmed)'
);

// 8. Verify Multi-Tenant Isolation
console.log(`\n--- Step 8: Multi-Tenant Isolation Verification ---`);
// Register temporary outside user
const outUserRes = await fetch('http://localhost:5000/api/v1/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: `isolated_eval_${Date.now()}@test.local`,
    password: 'Password@123',
    display_name: 'Outside Tenant',
  }),
});
const outToken = (await outUserRes.json()).data.access_token;

// Outside user queries forecast - must not see demo forecast
const outForecastRes = await fetch('http://localhost:5000/api/v1/forecasts/latest', {
  headers: { Authorization: `Bearer ${outToken}` },
});
const outData = (await outForecastRes.json()).data;
assert(
  outData.status === 'INSUFFICIENT_HISTORY',
  'Outside user cannot see demo business forecast (Tenant Isolation Confirmed)'
);

await pool.end();

console.log(`\n======================================================`);
console.log(`DEMO DATA & SIMULATION TEST SUMMARY`);
console.log(`======================================================`);
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
