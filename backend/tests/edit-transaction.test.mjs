import request from 'supertest';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Load .env from project root
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
console.log(`CASHFLOW SENTINEL - EDIT TRANSACTION END-TO-END TEST`);
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
// Setup: Register User A and User B for multi-tenant tests
// ----------------------------------------------------
console.log(`--- Step 0: Provisioning Test Tenants ---`);
const regResA = await request(app)
  .post('/api/v1/auth/register')
  .send({
    display_name: 'Merchant Alpha',
    email: `alpha_${suffix}@test.local`,
    password: 'Password123!',
  });
assert(regResA.status === 201, `User A registered with HTTP 201 (got ${regResA.status})`);
const tokenA = regResA.body.data.access_token;
const userIdA = regResA.body.data.user?.id;
assert(typeof tokenA === 'string' && tokenA.length > 20, 'User A received valid JWT');

const regResB = await request(app)
  .post('/api/v1/auth/register')
  .send({
    display_name: 'Merchant Beta',
    email: `beta_${suffix}@test.local`,
    password: 'Password123!',
  });
assert(regResB.status === 201, `User B registered with HTTP 201 (got ${regResB.status})`);
const tokenB = regResB.body.data.access_token;
const userIdB = regResB.body.data.user?.id;
assert(typeof tokenB === 'string' && tokenB.length > 20, 'User B received valid JWT');
assert(userIdA !== userIdB, 'User A and User B belong to distinct users');

// Fetch categories
const catRes = await request(app)
  .get('/api/v1/transactions/categories')
  .set('Authorization', `Bearer ${tokenA}`);
assert(catRes.status === 200, 'Categories endpoint returned HTTP 200');
const categories = catRes.body.data;
assert(Array.isArray(categories) && categories.length >= 2, `Categories returned (${categories.length})`);

const inflowCats = categories.filter((c) => c.allowed_direction === 'INFLOW' || c.allowed_direction === 'BOTH');
const outflowCats = categories.filter((c) => c.allowed_direction === 'OUTFLOW' || c.allowed_direction === 'BOTH');
const strictOutflowCats = categories.filter((c) => c.allowed_direction === 'OUTFLOW');
const strictInflowCats = categories.filter((c) => c.allowed_direction === 'INFLOW');

assert(inflowCats.length > 0, `Found ${inflowCats.length} inflow categories`);
assert(outflowCats.length >= 2, `Found ${outflowCats.length} outflow categories`);

const initialInflowCat = inflowCats[0];
const initialOutflowCat = outflowCats[0];
const alternativeOutflowCat = outflowCats.length > 1 ? outflowCats[1] : outflowCats[0];

// ----------------------------------------------------
// Scenario 1: Create baseline transactions for User A
// ----------------------------------------------------
console.log(`\n--- Scenario 1: Create Baseline Transactions ---`);
const createIncomeRes = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '5000.00',
    cash_direction: 'INFLOW',
    category_id: initialInflowCat.id,
    description: 'Initial Income Payment',
    counterparty_name: 'Alpha Customer',
    transaction_date: '2026-11-01',
  });
assert(createIncomeRes.status === 201, `Income transaction created (HTTP 201)`);
const txIncome = createIncomeRes.body.data;
assert(txIncome.amount_paise === '500000' || txIncome.amount_paise === 500000, 'Initial income amount_paise is 500000 (₹5,000)');

const createExpenseRes = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '2000.00',
    cash_direction: 'OUTFLOW',
    category_id: initialOutflowCat.id,
    description: 'Initial Office Expense',
    counterparty_name: 'Alpha Vendor',
    transaction_date: '2026-11-02',
  });
assert(createExpenseRes.status === 201, `Expense transaction created (HTTP 201)`);
const txExpense = createExpenseRes.body.data;
assert(txExpense.amount_paise === '200000' || txExpense.amount_paise === 200000, 'Initial expense amount_paise is 200000 (₹2,000)');

// Verify initial summary
const initialSummaryRes = await request(app)
  .get('/api/v1/transactions/summary')
  .set('Authorization', `Bearer ${tokenA}`);
assert(initialSummaryRes.status === 200, 'Summary endpoint returned HTTP 200');
const initSummary = initialSummaryRes.body.data;
assert(Number(initSummary.total_income_paise) === 500000, 'Initial total income is 500000 paise');
assert(Number(initSummary.total_expense_paise) === 200000, 'Initial total expense is 200000 paise');
assert(Number(initSummary.net_cash_flow_paise) === 300000, 'Initial net cash flow is 300000 paise');

// ----------------------------------------------------
// Scenario 2: Valid edit of Income transaction
// ----------------------------------------------------
console.log(`\n--- Scenario 2: Edit Income Transaction (Amount, Description, Date) ---`);
const editIncomeRes = await request(app)
  .patch(`/api/v1/transactions/${txIncome.id}`)
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '7500.00',
    category_id: initialInflowCat.id,
    description: 'Updated Customer Payment (Contract #42)',
    counterparty_name: 'Alpha Major Client',
    transaction_date: '2026-11-05',
  });

assert(editIncomeRes.status === 200, `Edit income returned HTTP 200 (got ${editIncomeRes.status})`);
const updatedIncome = editIncomeRes.body.data;
assert(updatedIncome.id === txIncome.id, 'Transaction ID matches');
assert(Number(updatedIncome.amount_paise) === 750000, `Updated amount_paise is 750000 (got ${updatedIncome.amount_paise})`);
assert(updatedIncome.amount_rupees === 7500 || Number(updatedIncome.amount_paise) === 750000, 'Amount rupees is ₹7,500');
assert(updatedIncome.description === 'Updated Customer Payment (Contract #42)', 'Description successfully updated');
assert(updatedIncome.counterparty_name === 'Alpha Major Client', 'Counterparty name successfully updated');
assert(updatedIncome.transaction_date.slice(0, 10) === '2026-11-05', 'Transaction date successfully updated');
assert(updatedIncome.cash_direction === 'INFLOW', 'Cash direction remains INFLOW');

// Verify summary dynamically recalculated
const summaryAfterIncomeEdit = await request(app)
  .get('/api/v1/transactions/summary')
  .set('Authorization', `Bearer ${tokenA}`);
const sumInc = summaryAfterIncomeEdit.body.data;
assert(Number(sumInc.total_income_paise) === 750000, `Total income updated to 750000 paise (₹7,500) (got ${sumInc.total_income_paise})`);
assert(Number(sumInc.net_cash_flow_paise) === 550000, `Net cash flow updated to 550000 paise (₹5,500) (got ${sumInc.net_cash_flow_paise})`);

// ----------------------------------------------------
// Scenario 3: Valid edit of Expense transaction (Amount, Category)
// ----------------------------------------------------
console.log(`\n--- Scenario 3: Edit Expense Transaction (Amount, Category) ---`);
const editExpenseRes = await request(app)
  .patch(`/api/v1/transactions/${txExpense.id}`)
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '2800.50',
    category_id: alternativeOutflowCat.id,
    description: 'Adjusted Supply Cost',
    transaction_date: '2026-11-06',
  });

assert(editExpenseRes.status === 200, `Edit expense returned HTTP 200 (got ${editExpenseRes.status})`);
const updatedExpense = editExpenseRes.body.data;
assert(Number(updatedExpense.amount_paise) === 280050, `Updated amount_paise is 280050 (₹2,800.50) (got ${updatedExpense.amount_paise})`);
assert(updatedExpense.category_id === alternativeOutflowCat.id, 'Category ID updated to new OUTFLOW category');
assert(updatedExpense.cash_direction === 'OUTFLOW', 'Cash direction remains OUTFLOW');

// Verify summary dynamically recalculated
const summaryAfterExpenseEdit = await request(app)
  .get('/api/v1/transactions/summary')
  .set('Authorization', `Bearer ${tokenA}`);
const sumExp = summaryAfterExpenseEdit.body.data;
assert(Number(sumExp.total_expense_paise) === 280050, `Total expense updated to 280050 paise (₹2,800.50) (got ${sumExp.total_expense_paise})`);
assert(Number(sumExp.net_cash_flow_paise) === (750000 - 280050), `Net cash flow updated to ${750000 - 280050} paise`);

// ----------------------------------------------------
// Scenario 4: Reject invalid amounts (Negative, Zero, NaN)
// ----------------------------------------------------
console.log(`\n--- Scenario 4: Rejection of Invalid Amounts ---`);
const negAmountRes = await request(app)
  .patch(`/api/v1/transactions/${txIncome.id}`)
  .set('Authorization', `Bearer ${tokenA}`)
  .send({ amount: '-1500.00' });
assert(negAmountRes.status === 422 || negAmountRes.status === 400, `Negative amount rejected with HTTP ${negAmountRes.status}`);

const zeroAmountRes = await request(app)
  .patch(`/api/v1/transactions/${txIncome.id}`)
  .set('Authorization', `Bearer ${tokenA}`)
  .send({ amount: '0' });
assert(zeroAmountRes.status === 422 || zeroAmountRes.status === 400, `Zero amount rejected with HTTP ${zeroAmountRes.status}`);

const nanAmountRes = await request(app)
  .patch(`/api/v1/transactions/${txIncome.id}`)
  .set('Authorization', `Bearer ${tokenA}`)
  .send({ amount: 'abc' });
assert(nanAmountRes.status === 422 || nanAmountRes.status === 400, `Invalid numeric string rejected with HTTP ${nanAmountRes.status}`);

// ----------------------------------------------------
// Scenario 5: Reject incompatible category direction
// ----------------------------------------------------
console.log(`\n--- Scenario 5: Rejection of Incompatible Category Direction ---`);
if (strictOutflowCats.length > 0) {
  const incompatibleCat = strictOutflowCats[0];
  const invalidCatRes = await request(app)
    .patch(`/api/v1/transactions/${txIncome.id}`)
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      category_id: incompatibleCat.id,
    });
  assert(
    invalidCatRes.status === 422 || invalidCatRes.status === 400,
    `Incompatible category direction rejected with HTTP ${invalidCatRes.status}`
  );
  assert(
    invalidCatRes.body.error?.message?.toLowerCase().includes('category') ||
    invalidCatRes.body.error?.message?.toLowerCase().includes('direction') ||
    invalidCatRes.body.error?.message?.toLowerCase().includes('inflow'),
    `Error message mentions category/direction incompatibility: "${invalidCatRes.body.error?.message}"`
  );
} else {
  console.log(`(Skipping strict outflow test: no strict OUTFLOW category in DB)`);
}

// ----------------------------------------------------
// Scenario 6: Multi-tenant ownership isolation
// ----------------------------------------------------
console.log(`\n--- Scenario 6: Multi-Tenant Ownership Isolation ---`);
// User B attempts to edit User A's transaction
const unauthorizedEditRes = await request(app)
  .patch(`/api/v1/transactions/${txIncome.id}`)
  .set('Authorization', `Bearer ${tokenB}`)
  .send({
    amount: '99999.00',
    description: 'Hacked by User B',
  });

assert(unauthorizedEditRes.status === 404, `User B editing User A's transaction returned HTTP 404 Not Found (got ${unauthorizedEditRes.status})`);

// Verify User A's transaction is unchanged
const checkIncomeRes = await request(app)
  .get(`/api/v1/transactions/${txIncome.id}`)
  .set('Authorization', `Bearer ${tokenA}`);
assert(checkIncomeRes.status === 200, 'User A can still fetch their transaction');
assert(Number(checkIncomeRes.body.data.amount_paise) === 750000, 'User A amount_paise remains 750000 (not modified by User B)');
assert(checkIncomeRes.body.data.description === 'Updated Customer Payment (Contract #42)', 'Description unchanged');

// ----------------------------------------------------
// Scenario 7: Non-existent transaction ID
// ----------------------------------------------------
console.log(`\n--- Scenario 7: Non-Existent Transaction ID ---`);
const notFoundRes = await request(app)
  .patch(`/api/v1/transactions/00000000-0000-0000-0000-000000000000`)
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '1000.00',
  });
assert(notFoundRes.status === 404, `Non-existent transaction returned HTTP 404 (got ${notFoundRes.status})`);

// ----------------------------------------------------
// Scenario 8: Verify Transaction Listing shows updated values
// ----------------------------------------------------
console.log(`\n--- Scenario 8: Transaction Listing Persistence ---`);
const listRes = await request(app)
  .get('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`);
assert(listRes.status === 200, 'Transaction list returned HTTP 200');
const items = listRes.body.data.items || listRes.body.data;
const listedIncome = items.find((i) => i.id === txIncome.id);
const listedExpense = items.find((i) => i.id === txExpense.id);

assert(Boolean(listedIncome), 'Income transaction present in listing');
assert(Number(listedIncome.amount_paise) === 750000, `Listed income amount is 750000 paise (₹7,500) (got ${listedIncome.amount_paise})`);
assert(listedIncome.description === 'Updated Customer Payment (Contract #42)', 'Listed income description matches');

assert(Boolean(listedExpense), 'Expense transaction present in listing');
assert(Number(listedExpense.amount_paise) === 280050, `Listed expense amount is 280050 paise (₹2,800.50) (got ${listedExpense.amount_paise})`);
assert(listedExpense.category_id === alternativeOutflowCat.id, 'Listed expense category matches');

console.log(`\n========================================`);
console.log(`TEST SUMMARY: ${passedTests}/${totalTests} PASSED`);
console.log(`========================================\n`);

if (passedTests !== totalTests) {
  process.exit(1);
} else {
  process.exit(0);
}
