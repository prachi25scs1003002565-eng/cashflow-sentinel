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

// Import the compiled express app
import appExport from '../dist/app.js';
const app = appExport.default || appExport;

const suffix = Date.now();
console.log(`\n========================================`);
console.log(`CASHFLOW SENTINEL - DELETE TRANSACTION END-TO-END TEST`);
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
const regResA = await request(app)
  .post('/api/v1/auth/register')
  .send({
    display_name: 'Merchant Delete A',
    email: `del_alpha_${suffix}@test.local`,
    password: 'Password123!',
  });
assert(regResA.status === 201, `User A registered with HTTP 201`);
const tokenA = regResA.body.data.access_token;
const userIdA = regResA.body.data.user.id;
assert(typeof tokenA === 'string' && tokenA.length > 20, 'User A received valid JWT');

const regResB = await request(app)
  .post('/api/v1/auth/register')
  .send({
    display_name: 'Merchant Delete B',
    email: `del_beta_${suffix}@test.local`,
    password: 'Password123!',
  });
assert(regResB.status === 201, `User B registered with HTTP 201`);
const tokenB = regResB.body.data.access_token;
const userIdB = regResB.body.data.user.id;
assert(typeof tokenB === 'string' && tokenB.length > 20, 'User B received valid JWT');
assert(userIdA !== userIdB, 'User A and User B belong to distinct users');

// Fetch categories for User A
const catRes = await request(app)
  .get('/api/v1/transactions/categories')
  .set('Authorization', `Bearer ${tokenA}`);
assert(catRes.status === 200, 'Categories endpoint returned HTTP 200');
const categories = catRes.body.data;
const inflowCat = categories.find((c) => c.allowed_direction === 'INFLOW' || c.allowed_direction === 'BOTH');
const outflowCat = categories.find((c) => c.allowed_direction === 'OUTFLOW' || c.allowed_direction === 'BOTH');
assert(Boolean(inflowCat), 'Found valid inflow category');
assert(Boolean(outflowCat), 'Found valid outflow category');

// ----------------------------------------------------
// Scenario 1: Create Baseline Transactions
// ----------------------------------------------------
console.log(`\n--- Scenario 1: Create Baseline Transactions ---`);
const txIncomeRes = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '10000.00',
    cash_direction: 'INFLOW',
    category_id: inflowCat.id,
    description: 'Wholesale Client Order #101',
    transaction_date: '2026-11-01',
  });
assert(txIncomeRes.status === 201, 'Created income transaction (₹10,000)');
const txIncome = txIncomeRes.body.data;

const txExpense1Res = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '3000.00',
    cash_direction: 'OUTFLOW',
    category_id: outflowCat.id,
    description: 'Shop Rent Nov',
    transaction_date: '2026-11-02',
  });
assert(txExpense1Res.status === 201, 'Created expense transaction 1 (₹3,000)');
const txExpense1 = txExpense1Res.body.data;

const txExpense2Res = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '1500.00',
    cash_direction: 'OUTFLOW',
    category_id: outflowCat.id,
    description: 'Accidental Duplicate Utility Bill',
    transaction_date: '2026-11-03',
  });
assert(txExpense2Res.status === 201, 'Created expense transaction 2 (₹1,500)');
const txExpense2 = txExpense2Res.body.data;

// Verify baseline summary
const baselineSumRes = await request(app)
  .get('/api/v1/transactions/summary')
  .set('Authorization', `Bearer ${tokenA}`);
assert(baselineSumRes.status === 200, 'Summary endpoint returned HTTP 200');
const baseSum = baselineSumRes.body.data;
assert(baseSum.transaction_count === 3, `Baseline transaction count is 3 (got ${baseSum.transaction_count})`);
assert(Number(baseSum.total_income_paise) === 1000000, `Baseline total income is 1000000 paise (₹10,000) (got ${baseSum.total_income_paise})`);
assert(Number(baseSum.total_expense_paise) === 450000, `Baseline total expense is 450000 paise (₹4,500) (got ${baseSum.total_expense_paise})`);
assert(Number(baseSum.net_cash_flow_paise) === 550000, `Baseline net cash flow is 550000 paise (₹5,500) (got ${baseSum.net_cash_flow_paise})`);

// ----------------------------------------------------
// Scenario 2: Soft-Delete Expense Transaction 2
// ----------------------------------------------------
console.log(`\n--- Scenario 2: Soft-Delete Expense Transaction 2 ---`);
const delRes1 = await request(app)
  .delete(`/api/v1/transactions/${txExpense2.id}`)
  .set('Authorization', `Bearer ${tokenA}`);

assert(delRes1.status === 200, `Delete returned HTTP 200 (got ${delRes1.status})`);
assert(delRes1.body.data.id === txExpense2.id, 'Returned deleted transaction ID');
assert(delRes1.body.data.record_status === 'REVERSED', 'Returned record_status is REVERSED');
assert(typeof delRes1.body.data.message === 'string', 'Returned confirmation message');

// Directly inspect PostgreSQL to confirm soft-deletion (row NOT destroyed)
const dbCheckRes = await pool.query(
  'SELECT id, record_status, amount_paise, description, updated_at FROM transactions WHERE id = $1',
  [txExpense2.id]
);
assert(dbCheckRes.rows.length === 1, 'Transaction row is NOT permanently deleted from PostgreSQL');
assert(dbCheckRes.rows[0].record_status === 'REVERSED', 'Transaction record_status in DB is REVERSED');
assert(Number(dbCheckRes.rows[0].amount_paise) === 150000, 'Original amount_paise (150000) is preserved');
assert(dbCheckRes.rows[0].description === 'Accidental Duplicate Utility Bill', 'Original description is preserved');

// ----------------------------------------------------
// Scenario 3: Verify Transaction Listing Excludes Deleted Transaction
// ----------------------------------------------------
console.log(`\n--- Scenario 3: Transaction Listing Verification ---`);
const listAfterDelRes = await request(app)
  .get('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`);
assert(listAfterDelRes.status === 200, 'List endpoint returned HTTP 200');
const activeList = listAfterDelRes.body.data.items || listAfterDelRes.body.data;
assert(activeList.length === 2, `Default listing returns exactly 2 active transactions (got ${activeList.length})`);
assert(!activeList.some((t) => t.id === txExpense2.id), 'Deleted transaction does NOT appear in normal listing');
assert(activeList.some((t) => t.id === txIncome.id), 'Income transaction still present in listing');
assert(activeList.some((t) => t.id === txExpense1.id), 'Expense 1 still present in listing');

// ----------------------------------------------------
// Scenario 4: Dashboard Totals Recalculation After Expense Deletion
// ----------------------------------------------------
console.log(`\n--- Scenario 4: Dashboard Totals Recalculation After Expense Deletion ---`);
const summaryAfterDel1 = await request(app)
  .get('/api/v1/transactions/summary')
  .set('Authorization', `Bearer ${tokenA}`);
assert(summaryAfterDel1.status === 200, 'Summary endpoint returned HTTP 200');
const sum1 = summaryAfterDel1.body.data;

assert(sum1.transaction_count === 2, `Active transaction count recalculated from 3 to 2 (got ${sum1.transaction_count})`);
assert(Number(sum1.total_income_paise) === 1000000, `Total income remains 1000000 paise (₹10,000)`);
assert(Number(sum1.total_expense_paise) === 300000, `Total expense reduced by ₹1,500 to 300000 paise (₹3,000) (got ${sum1.total_expense_paise})`);
assert(Number(sum1.net_cash_flow_paise) === 700000, `Net cash flow increased from ₹5,500 to ₹7,000 (700000 paise) (got ${sum1.net_cash_flow_paise})`);

// ----------------------------------------------------
// Scenario 5: Soft-Delete Income Transaction & Recalculate
// ----------------------------------------------------
console.log(`\n--- Scenario 5: Soft-Delete Income Transaction ---`);
const delIncomeRes = await request(app)
  .delete(`/api/v1/transactions/${txIncome.id}`)
  .set('Authorization', `Bearer ${tokenA}`);
assert(delIncomeRes.status === 200, 'Income transaction delete returned HTTP 200');
assert(delIncomeRes.body.data.record_status === 'REVERSED', 'Income transaction record_status is REVERSED');

const summaryAfterDel2 = await request(app)
  .get('/api/v1/transactions/summary')
  .set('Authorization', `Bearer ${tokenA}`);
const sum2 = summaryAfterDel2.body.data;
assert(sum2.transaction_count === 1, `Active transaction count recalculated to 1 (got ${sum2.transaction_count})`);
assert(Number(sum2.total_income_paise) === 0, `Total income recalculated to 0 paise (got ${sum2.total_income_paise})`);
assert(Number(sum2.total_expense_paise) === 300000, `Total expense remains 300000 paise (got ${sum2.total_expense_paise})`);
assert(Number(sum2.net_cash_flow_paise) === -300000, `Net cash flow recalculated to -300000 paise (-₹3,000) (got ${sum2.net_cash_flow_paise})`);

// ----------------------------------------------------
// Scenario 6: Prevent Duplicate Deletion
// ----------------------------------------------------
console.log(`\n--- Scenario 6: Prevent Duplicate Deletion ---`);
const dupDeleteRes = await request(app)
  .delete(`/api/v1/transactions/${txIncome.id}`)
  .set('Authorization', `Bearer ${tokenA}`);
assert(dupDeleteRes.status === 409, `Duplicate delete rejected with HTTP 409 Conflict (got ${dupDeleteRes.status})`);
assert(
  dupDeleteRes.body.error?.message?.toLowerCase().includes('already') ||
  dupDeleteRes.body.error?.code?.includes('ALREADY'),
  `Conflict message explains transaction is already deleted: "${dupDeleteRes.body.error?.message}"`
);

// ----------------------------------------------------
// Scenario 7: Multi-Tenant Ownership Isolation
// ----------------------------------------------------
console.log(`\n--- Scenario 7: Multi-Tenant Ownership Isolation ---`);
// User B attempts to delete User A's remaining expense transaction
const unauthorizedDelRes = await request(app)
  .delete(`/api/v1/transactions/${txExpense1.id}`)
  .set('Authorization', `Bearer ${tokenB}`);

assert(unauthorizedDelRes.status === 404, `User B deleting User A's transaction returned HTTP 404 Not Found (got ${unauthorizedDelRes.status})`);

// Verify User A's transaction remains active and POSTED
const verifyTxA = await request(app)
  .get(`/api/v1/transactions/${txExpense1.id}`)
  .set('Authorization', `Bearer ${tokenA}`);
assert(verifyTxA.status === 200, 'User A transaction still accessible');
assert(verifyTxA.body.data.record_status === 'POSTED', 'User A transaction remains in POSTED status');

// ----------------------------------------------------
// Scenario 8: Non-Existent Transaction ID
// ----------------------------------------------------
console.log(`\n--- Scenario 8: Non-Existent Transaction ID ---`);
const notFoundDelRes = await request(app)
  .delete(`/api/v1/transactions/00000000-0000-0000-0000-000000000000`)
  .set('Authorization', `Bearer ${tokenA}`);
assert(notFoundDelRes.status === 404, `Non-existent transaction returned HTTP 404 (got ${notFoundDelRes.status})`);

// ----------------------------------------------------
// Scenario 9: Audit History Preservation
// ----------------------------------------------------
console.log(`\n--- Scenario 9: Audit History Preservation ---`);
const auditRes = await pool.query(
  `SELECT id, action, entity_name, entity_id, actor_user_id, metadata
   FROM audit_events
   WHERE action = 'TRANSACTION_DELETED' AND (entity_id = $1 OR entity_id = $2)
   ORDER BY created_at ASC`,
  [txExpense2.id, txIncome.id]
);
assert(auditRes.rows.length === 2, `Found exactly 2 TRANSACTION_DELETED audit events (got ${auditRes.rows.length})`);
for (const row of auditRes.rows) {
  assert(row.entity_name === 'transactions', 'Audit event entity_name is transactions');
  assert(row.actor_user_id === userIdA, 'Audit event actor_user_id matches User A');
  assert(row.metadata?.previous_status === 'POSTED', 'Audit event metadata logs previous_status POSTED');
}

await pool.end();

console.log(`\n========================================`);
console.log(`TEST SUMMARY: ${passedTests}/${totalTests} PASSED`);
console.log(`========================================\n`);

if (passedTests !== totalTests) {
  process.exit(1);
} else {
  process.exit(0);
}
