import request from 'supertest';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Load .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const TARGET_DB = 'cashflow_sentinel_migration_test';
const PROTECTED_DB = 'cashflow_sentinel';

function assertSafety(dbName) {
  if (dbName === PROTECTED_DB) {
    throw new Error(`CRITICAL SECURITY VIOLATION: Attempted access to protected database "${PROTECTED_DB}"! Halting immediately.`);
  }
  if (dbName !== TARGET_DB) {
    throw new Error(`CRITICAL SECURITY VIOLATION: Target database "${dbName}" is not the approved test database "${TARGET_DB}"! Halting immediately.`);
  }
}

// Pre-flight database check
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
await pool.end();

// Import the compiled express app
import appExport from '../dist/app.js';
const app = appExport.default || appExport;

const suffix = Date.now();
console.log(`\n========================================`);
console.log(`CASHFLOW SENTINEL - TRANSACTION API INTEGRATION TEST`);
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

// Scenario 1: Authentication / Registration
console.log(`--- Scenario 1: User Registration ---`);
const regResA = await request(app)
  .post('/api/v1/auth/register')
  .send({
    display_name: 'Store Owner A',
    email: `owner_a_${suffix}@test.local`,
    password: 'Password123!',
  });
assert(regResA.status === 201, `User A registered successfully with HTTP 201 (got ${regResA.status})`);
const tokenA = regResA.body.data.access_token;
assert(typeof tokenA === 'string' && tokenA.length > 20, 'User A received valid JWT token');

const regResB = await request(app)
  .post('/api/v1/auth/register')
  .send({
    display_name: 'Store Owner B',
    email: `owner_b_${suffix}@test.local`,
    password: 'Password123!',
  });
assert(regResB.status === 201, `User B registered successfully with HTTP 201 (got ${regResB.status})`);
const tokenB = regResB.body.data.access_token;
assert(typeof tokenB === 'string' && tokenB.length > 20, 'User B received valid JWT token');

// Scenario 2: Unauthenticated Security Assertions & Input Validation
console.log(`\n--- Scenario 2: Unauthenticated Security & Input Validation ---`);
const unauthPost = await request(app)
  .post('/api/v1/transactions')
  .send({ type: 'income', amount: '1000', transaction_date: '2026-11-16' });
assert(unauthPost.status === 401, `Unauthenticated POST rejected with HTTP 401 (got ${unauthPost.status})`);

const unauthGet = await request(app).get('/api/v1/transactions');
assert(unauthGet.status === 401, `Unauthenticated GET /transactions rejected with HTTP 401 (got ${unauthGet.status})`);

const unauthSummary = await request(app).get('/api/v1/transactions/summary');
assert(unauthSummary.status === 401, `Unauthenticated GET /transactions/summary rejected with HTTP 401 (got ${unauthSummary.status})`);

const invalidAmount = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({ type: 'income', amount: '-500', transaction_date: '2026-11-16' });
assert(invalidAmount.status === 422, `Negative amount rejected with HTTP 422 (got ${invalidAmount.status})`);

const invalidDate = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({ type: 'income', amount: '500', transaction_date: 'not-a-date' });
assert(invalidDate.status === 422, `Invalid date format rejected with HTTP 422 (got ${invalidDate.status})`);

// Scenario 3: Initial Empty State for User A
console.log(`\n--- Scenario 3: Initial State for New Business ---`);
const initSummary = await request(app)
  .get('/api/v1/transactions/summary')
  .set('Authorization', `Bearer ${tokenA}`);
assert(initSummary.status === 200, `Initial summary returned HTTP 200 (got ${initSummary.status})`);
assert(initSummary.body.data.transaction_count === 0, `Initial transaction count is 0 (got ${initSummary.body.data.transaction_count})`);
assert(initSummary.body.data.total_income_paise === '0', 'Initial total income is 0 paise');
assert(initSummary.body.data.total_expense_paise === '0', 'Initial total expense is 0 paise');
assert(initSummary.body.data.net_cash_flow_paise === '0', 'Initial net cash flow is 0 paise');

// Scenario 4: POST Income Transaction (Inflow)
console.log(`\n--- Scenario 4: POST /api/v1/transactions (Income) ---`);
const incomeRes = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    type: 'income',
    amount: '15000.50',
    category: 'Sales & Customer Inflow',
    description: 'Daily cash sales',
    counterparty_name: 'Walk-in Customers',
    transaction_date: '2026-11-16',
  });
assert(incomeRes.status === 201, `Income transaction created with HTTP 201 (got ${incomeRes.status})`);
const txIncome = incomeRes.body.data;
assert(txIncome.id && typeof txIncome.id === 'string', `Transaction returned UUID: ${txIncome.id}`);
assert(txIncome.cash_direction === 'INFLOW', `Cash direction is INFLOW (got ${txIncome.cash_direction})`);
assert(txIncome.transaction_type === 'INFLOW', `Transaction type is INFLOW (got ${txIncome.transaction_type})`);
assert(txIncome.amount_paise === '1500050', `Amount in paise is 1500050 (got ${txIncome.amount_paise})`);
assert(txIncome.amount_rupees === 15000.5, `Amount in rupees is 15000.50 (got ${txIncome.amount_rupees})`);
assert(txIncome.record_status === 'POSTED', 'Record status is POSTED');
assert(txIncome.account_name !== null, `Associated with account: ${txIncome.account_name}`);
assert(txIncome.category_name !== null, `Associated with category: ${txIncome.category_name}`);

// Scenario 5: POST Expense Transaction (Outflow)
console.log(`\n--- Scenario 5: POST /api/v1/transactions (Expense) ---`);
const expenseRes = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    type: 'expense',
    amount: '3500.00',
    category: 'Utilities & Bills',
    description: 'Monthly electricity bill',
    transaction_date: '2026-11-16',
  });
assert(expenseRes.status === 201, `Expense transaction created with HTTP 201 (got ${expenseRes.status})`);
const txExpense = expenseRes.body.data;
assert(txExpense.cash_direction === 'OUTFLOW', `Cash direction is OUTFLOW (got ${txExpense.cash_direction})`);
assert(txExpense.amount_paise === '350000', `Amount in paise is 350000 (got ${txExpense.amount_paise})`);
assert(txExpense.amount_rupees === 3500, `Amount in rupees is 3500.00 (got ${txExpense.amount_rupees})`);

// Scenario 6: GET /api/v1/transactions (List & Filtering)
console.log(`\n--- Scenario 6: GET /api/v1/transactions (List & Filters) ---`);
const listAll = await request(app)
  .get('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`);
assert(listAll.status === 200, `Transaction list returned HTTP 200 (got ${listAll.status})`);
assert(listAll.body.data.length === 2, `Retrieved exactly 2 transactions for User A (got ${listAll.body.data.length})`);

const listIncome = await request(app)
  .get('/api/v1/transactions?type=income')
  .set('Authorization', `Bearer ${tokenA}`);
assert(listIncome.body.data.length === 1, `Income filter returned exactly 1 transaction (got ${listIncome.body.data.length})`);
assert(listIncome.body.data[0].id === txIncome.id, 'Income filter returned correct transaction ID');

const listExpense = await request(app)
  .get('/api/v1/transactions?type=expense')
  .set('Authorization', `Bearer ${tokenA}`);
assert(listExpense.body.data.length === 1, `Expense filter returned exactly 1 transaction (got ${listExpense.body.data.length})`);
assert(listExpense.body.data[0].id === txExpense.id, 'Expense filter returned correct transaction ID');

// Scenario 7: GET /api/v1/transactions/summary (Dashboard Financials)
console.log(`\n--- Scenario 7: GET /api/v1/transactions/summary (Live Dashboard Data) ---`);
const summaryA = await request(app)
  .get('/api/v1/transactions/summary')
  .set('Authorization', `Bearer ${tokenA}`);
assert(summaryA.status === 200, `Summary returned HTTP 200 (got ${summaryA.status})`);
const dataA = summaryA.body.data;
assert(dataA.transaction_count === 2, `Transaction count is 2 (got ${dataA.transaction_count})`);
assert(dataA.total_income_paise === '1500050', `Total income is ₹15,000.50 (1500050 paise) (got ${dataA.total_income_paise})`);
assert(dataA.total_expense_paise === '350000', `Total expenses is ₹3,500.00 (350000 paise) (got ${dataA.total_expense_paise})`);
assert(dataA.net_cash_flow_paise === '1150050', `Net cash flow is ₹11,500.50 (1150050 paise) (got ${dataA.net_cash_flow_paise})`);
assert(dataA.current_cash_balance_paise === '1150050', `Current cash balance matches ledger: ₹11,500.50 (got ${dataA.current_cash_balance_paise})`);
assert(Array.isArray(dataA.recent_transactions) && dataA.recent_transactions.length === 2, 'Recent transactions returned in summary');

// Scenario 8: Multi-Tenant Isolation
console.log(`\n--- Scenario 8: Strict Multi-Tenant Isolation ---`);
const listB = await request(app)
  .get('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenB}`);
assert(listB.body.data.length === 0, `User B sees 0 transactions (got ${listB.body.data.length}) - Isolation Confirmed`);

const summaryB = await request(app)
  .get('/api/v1/transactions/summary')
  .set('Authorization', `Bearer ${tokenB}`);
assert(summaryB.body.data.transaction_count === 0, 'User B summary shows 0 transactions');
assert(summaryB.body.data.total_income_paise === '0', 'User B summary total income is 0');
assert(summaryB.body.data.total_expense_paise === '0', 'User B summary total expense is 0');

const crossAccess = await request(app)
  .get(`/api/v1/transactions/${txIncome.id}`)
  .set('Authorization', `Bearer ${tokenB}`);
assert(crossAccess.status === 404, `User B blocked from accessing User A transaction: HTTP 404 (got ${crossAccess.status})`);

// User B adds their own transaction
const txB = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenB}`)
  .send({
    type: 'income',
    amount: '8000.00',
    category: 'Sales & Customer Inflow',
    description: 'User B retail revenue',
    transaction_date: '2026-11-16',
  });
assert(txB.status === 201, `User B added their own transaction: HTTP 201`);

// Re-check User A is completely isolated from User B's new transaction
const recheckA = await request(app)
  .get('/api/v1/transactions/summary')
  .set('Authorization', `Bearer ${tokenA}`);
assert(recheckA.body.data.transaction_count === 2, `User A still has exactly 2 transactions (unaffected by User B)`);
assert(recheckA.body.data.total_income_paise === '1500050', `User A total income unchanged: ₹15,000.50`);

// Scenario 9: Categories Endpoint
console.log(`\n--- Scenario 9: Transaction Categories API ---`);
const catRes = await request(app)
  .get('/api/v1/transactions/categories')
  .set('Authorization', `Bearer ${tokenA}`);
assert(catRes.status === 200, `Categories endpoint returned HTTP 200 (got ${catRes.status})`);
assert(Array.isArray(catRes.body.data) && catRes.body.data.length > 0, `Returned ${catRes.body.data.length} categories for business`);

console.log(`\n========================================`);
console.log(`INTEGRATION TEST SUMMARY:`);
console.log(`Total assertions: ${totalTests}`);
console.log(`Passed: ${passedTests}`);
console.log(`Failed: 0`);
console.log(`ALL 9 INTEGRATION TEST SCENARIOS PASSED!`);
console.log(`========================================\n`);

process.exit(0);
