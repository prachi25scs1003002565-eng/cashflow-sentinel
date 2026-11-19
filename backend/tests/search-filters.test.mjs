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
console.log(`CASHFLOW SENTINEL - SEARCH & FILTERS TEST`);
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
    display_name: 'Search Merchant Alpha',
    email: `search_alpha_${suffix}@test.local`,
    password: 'Password123!',
  });
assert(regResA.status === 201, `User A registered with HTTP 201`);
const tokenA = regResA.body.data.access_token;
const userIdA = regResA.body.data.user.id;
assert(typeof tokenA === 'string' && tokenA.length > 20, 'User A received valid JWT');

const regResB = await request(app)
  .post('/api/v1/auth/register')
  .send({
    display_name: 'Search Merchant Beta',
    email: `search_beta_${suffix}@test.local`,
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
const inflowCats = categories.filter((c) => c.allowed_direction === 'INFLOW' || c.allowed_direction === 'BOTH');
const outflowCats = categories.filter((c) => c.allowed_direction === 'OUTFLOW' || c.allowed_direction === 'BOTH');
assert(inflowCats.length >= 1, `Found ${inflowCats.length} inflow categories`);
assert(outflowCats.length >= 2, `Found ${outflowCats.length} outflow categories`);

const catSales = inflowCats[0];
const catRent = outflowCats[0];
const catSupplies = outflowCats.length > 1 ? outflowCats[1] : outflowCats[0];

// ----------------------------------------------------
// Scenario 1: Populate Diverse Transactions
// ----------------------------------------------------
console.log(`\n--- Scenario 1: Creating Diverse Transactions ---`);

// Tx 1: Inflow, Wholesale Client, ABC Enterprises, Nov 5
const tx1Res = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '12000.00',
    cash_direction: 'INFLOW',
    category_id: catSales.id,
    description: 'Special Wholesale Client Payment',
    counterparty_name: 'ABC Enterprises',
    transaction_date: '2026-11-05',
  });
assert(tx1Res.status === 201, 'Tx 1 created');
const tx1 = tx1Res.body.data;

// Tx 2: Inflow, Retail Store Sales Cash, Counter Walk-in, Nov 10
const tx2Res = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '4500.00',
    cash_direction: 'INFLOW',
    category_id: catSales.id,
    description: 'Retail Store Sales Cash',
    counterparty_name: 'Counter Walk-in',
    transaction_date: '2026-11-10',
  });
assert(tx2Res.status === 201, 'Tx 2 created');
const tx2 = tx2Res.body.data;

// Tx 3: Outflow, Monthly Office Lease, Prime Properties, Nov 2, catRent
const tx3Res = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '5000.00',
    cash_direction: 'OUTFLOW',
    category_id: catRent.id,
    description: 'Monthly Office Lease',
    counterparty_name: 'Prime Properties',
    transaction_date: '2026-11-02',
  });
assert(tx3Res.status === 201, 'Tx 3 created');
const tx3 = tx3Res.body.data;

// Tx 4: Outflow, Raw Material Inventory Restock, ABC Suppliers, Nov 12, catSupplies
const tx4Res = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '3200.00',
    cash_direction: 'OUTFLOW',
    category_id: catSupplies.id,
    description: 'Raw Material Inventory Restock',
    counterparty_name: 'ABC Suppliers',
    transaction_date: '2026-11-12',
  });
assert(tx4Res.status === 201, 'Tx 4 created');
const tx4 = tx4Res.body.data;

// Tx 5: Outflow, Electricity and Utility Bill, City Power Corp, Nov 15
const tx5Res = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '1800.00',
    cash_direction: 'OUTFLOW',
    category_id: catRent.id,
    description: 'Electricity and Utility Bill',
    counterparty_name: 'City Power Corp',
    transaction_date: '2026-11-15',
  });
assert(tx5Res.status === 201, 'Tx 5 created');
const tx5 = tx5Res.body.data;

// Tx 6: Outflow, Erroneous Duplicate, Nov 8 -> Deleted/Reversed
const tx6Res = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '999.00',
    cash_direction: 'OUTFLOW',
    category_id: catRent.id,
    description: 'Erroneous Charge to ABC Duplicate',
    counterparty_name: 'ABC Suppliers',
    transaction_date: '2026-11-08',
  });
assert(tx6Res.status === 201, 'Tx 6 created');
const tx6 = tx6Res.body.data;

// Soft delete Tx 6
const del6Res = await request(app)
  .delete(`/api/v1/transactions/${tx6.id}`)
  .set('Authorization', `Bearer ${tokenA}`);
assert(del6Res.status === 200, 'Tx 6 soft-deleted');

// Baseline check: total active transactions = 5
const allRes = await request(app)
  .get('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`);
assert(allRes.status === 200, 'List all returned HTTP 200');
const allList = allRes.body.data.items || allRes.body.data;
assert(allList.length === 5, `Expected 5 active transactions, got ${allList.length}`);
assert(!allList.some((t) => t.id === tx6.id), 'Soft-deleted Tx 6 is excluded from normal listing');

// ----------------------------------------------------
// Scenario 2: Search by Description and Counterparty
// ----------------------------------------------------
console.log(`\n--- Scenario 2: Search by Description and Counterparty ---`);

// Search by description: "Wholesale"
const searchDescRes = await request(app)
  .get('/api/v1/transactions?search=Wholesale')
  .set('Authorization', `Bearer ${tokenA}`);
assert(searchDescRes.status === 200, 'Search by description returned HTTP 200');
const descItems = searchDescRes.body.data.items || searchDescRes.body.data;
assert(descItems.length === 1, `Search "Wholesale" returned 1 item (got ${descItems.length})`);
assert(descItems[0].id === tx1.id, 'Returned Tx 1');

// Search by counterparty: "City Power"
const searchCpRes = await request(app)
  .get('/api/v1/transactions?search=City%20Power')
  .set('Authorization', `Bearer ${tokenA}`);
assert(searchCpRes.status === 200, 'Search by counterparty returned HTTP 200');
const cpItems = searchCpRes.body.data.items || searchCpRes.body.data;
assert(cpItems.length === 1, `Search "City Power" returned 1 item (got ${cpItems.length})`);
assert(cpItems[0].id === tx5.id, 'Returned Tx 5');

// Case-insensitive search on counterparty/description: "abc"
// Tx 1 has counterparty ABC Enterprises; Tx 4 has ABC Suppliers. (Tx 6 is reversed, so excluded)
const searchAbcRes = await request(app)
  .get('/api/v1/transactions?search=abc')
  .set('Authorization', `Bearer ${tokenA}`);
assert(searchAbcRes.status === 200, 'Search "abc" returned HTTP 200');
const abcItems = searchAbcRes.body.data.items || searchAbcRes.body.data;
assert(abcItems.length === 2, `Search "abc" returned exactly 2 active items (got ${abcItems.length})`);
assert(abcItems.some((t) => t.id === tx1.id), 'Includes Tx 1 (ABC Enterprises)');
assert(abcItems.some((t) => t.id === tx4.id), 'Includes Tx 4 (ABC Suppliers)');
assert(!abcItems.some((t) => t.id === tx6.id), 'Excludes soft-deleted Tx 6');

// Search with no matching terms
const searchEmptyRes = await request(app)
  .get('/api/v1/transactions?search=nonexistentterm987')
  .set('Authorization', `Bearer ${tokenA}`);
assert(searchEmptyRes.status === 200, 'Search no match returned HTTP 200');
const emptyItems = searchEmptyRes.body.data.items || searchEmptyRes.body.data;
assert(emptyItems.length === 0, `Search with no match returned empty array (got ${emptyItems.length})`);

// ----------------------------------------------------
// Scenario 3: Income / Expense Type Filter
// ----------------------------------------------------
console.log(`\n--- Scenario 3: Income / Expense Type Filter ---`);

const incomeRes = await request(app)
  .get('/api/v1/transactions?type=income')
  .set('Authorization', `Bearer ${tokenA}`);
assert(incomeRes.status === 200, 'Filter type=income returned HTTP 200');
const incomeItems = incomeRes.body.data.items || incomeRes.body.data;
assert(incomeItems.length === 2, `Found exactly 2 income transactions (got ${incomeItems.length})`);
assert(incomeItems.every((t) => t.cash_direction === 'INFLOW'), 'All items have cash_direction INFLOW');

const expenseRes = await request(app)
  .get('/api/v1/transactions?type=expense')
  .set('Authorization', `Bearer ${tokenA}`);
assert(expenseRes.status === 200, 'Filter type=expense returned HTTP 200');
const expenseItems = expenseRes.body.data.items || expenseRes.body.data;
assert(expenseItems.length === 3, `Found exactly 3 active expense transactions (got ${expenseItems.length})`);
assert(expenseItems.every((t) => t.cash_direction === 'OUTFLOW'), 'All items have cash_direction OUTFLOW');

// ----------------------------------------------------
// Scenario 4: Category Filtering
// ----------------------------------------------------
console.log(`\n--- Scenario 4: Category Filtering ---`);

const catFilterRes = await request(app)
  .get(`/api/v1/transactions?category_id=${catSupplies.id}`)
  .set('Authorization', `Bearer ${tokenA}`);
assert(catFilterRes.status === 200, 'Category filter returned HTTP 200');
const catItems = catFilterRes.body.data.items || catFilterRes.body.data;
assert(catItems.length >= 1, `Found ${catItems.length} transactions for category`);
assert(catItems.every((t) => t.category_id === catSupplies.id), 'All items match filtered category_id');

// ----------------------------------------------------
// Scenario 5: Date Range Filtering
// ----------------------------------------------------
console.log(`\n--- Scenario 5: Date Range Filtering ---`);

// Range Nov 04 through Nov 11: should match Tx 1 (Nov 5) and Tx 2 (Nov 10)
const dateRangeRes = await request(app)
  .get('/api/v1/transactions?from_date=2026-11-04&to_date=2026-11-11')
  .set('Authorization', `Bearer ${tokenA}`);
assert(dateRangeRes.status === 200, 'Date range query returned HTTP 200');
const dateItems = dateRangeRes.body.data.items || dateRangeRes.body.data;
assert(dateItems.length === 2, `Date range returned exactly 2 items (got ${dateItems.length})`);
assert(dateItems.some((t) => t.id === tx1.id), 'Includes Tx 1 (Nov 5)');
assert(dateItems.some((t) => t.id === tx2.id), 'Includes Tx 2 (Nov 10)');

// Open-ended from_date: from Nov 12 onwards -> Tx 4 (Nov 12) and Tx 5 (Nov 15)
const fromDateRes = await request(app)
  .get('/api/v1/transactions?from_date=2026-11-12')
  .set('Authorization', `Bearer ${tokenA}`);
assert(fromDateRes.status === 200, 'from_date query returned HTTP 200');
const fromDateItems = fromDateRes.body.data.items || fromDateRes.body.data;
assert(fromDateItems.length === 2, `from_date >= Nov 12 returned 2 items (got ${fromDateItems.length})`);
assert(fromDateItems.some((t) => t.id === tx4.id), 'Includes Tx 4 (Nov 12)');
assert(fromDateItems.some((t) => t.id === tx5.id), 'Includes Tx 5 (Nov 15)');

// Open-ended to_date: up to Nov 03 -> Tx 3 (Nov 02)
const toDateRes = await request(app)
  .get('/api/v1/transactions?to_date=2026-11-03')
  .set('Authorization', `Bearer ${tokenA}`);
assert(toDateRes.status === 200, 'to_date query returned HTTP 200');
const toDateItems = toDateRes.body.data.items || toDateRes.body.data;
assert(toDateItems.length === 1, `to_date <= Nov 03 returned 1 item (got ${toDateItems.length})`);
assert(toDateItems[0].id === tx3.id, 'Returned Tx 3');

// ----------------------------------------------------
// Scenario 6: Combined Filters (Working Together)
// ----------------------------------------------------
console.log(`\n--- Scenario 6: Combined Filters (Working Together) ---`);

// Combined: search=abc AND type=expense
// Tx 1 matches abc but is income; Tx 4 matches abc and is expense!
const combined1Res = await request(app)
  .get('/api/v1/transactions?search=abc&type=expense')
  .set('Authorization', `Bearer ${tokenA}`);
assert(combined1Res.status === 200, 'Combined filter 1 returned HTTP 200');
const comb1Items = combined1Res.body.data.items || combined1Res.body.data;
assert(comb1Items.length === 1, `Combined search=abc & type=expense returned exactly 1 item (got ${comb1Items.length})`);
assert(comb1Items[0].id === tx4.id, 'Returned Tx 4 (Raw Material Inventory Restock from ABC Suppliers)');

// Combined: type=income AND from_date=2026-11-08
// Tx 1 is Nov 05 (excluded); Tx 2 is Nov 10 (matched!)
const combined2Res = await request(app)
  .get('/api/v1/transactions?type=income&from_date=2026-11-08')
  .set('Authorization', `Bearer ${tokenA}`);
assert(combined2Res.status === 200, 'Combined filter 2 returned HTTP 200');
const comb2Items = combined2Res.body.data.items || combined2Res.body.data;
assert(comb2Items.length === 1, `Combined type=income & from_date=Nov 08 returned 1 item (got ${comb2Items.length})`);
assert(comb2Items[0].id === tx2.id, 'Returned Tx 2');

// Combined: search=Retail AND category_id=catRent
// Tx 2 has description Retail but category_id is catSales, not catRent
const combined3Res = await request(app)
  .get(`/api/v1/transactions?search=Retail&category_id=${catRent.id}`)
  .set('Authorization', `Bearer ${tokenA}`);
assert(combined3Res.status === 200, 'Combined filter 3 returned HTTP 200');
const comb3Items = combined3Res.body.data.items || combined3Res.body.data;
assert(comb3Items.length === 0, `Combined search=Retail & mismatched category returned 0 items (got ${comb3Items.length})`);

// ----------------------------------------------------
// Scenario 7: Invalid Date Range Validation
// ----------------------------------------------------
console.log(`\n--- Scenario 7: Invalid Date Range Validation ---`);

// start date > end date
const invalidRangeRes = await request(app)
  .get('/api/v1/transactions?from_date=2026-11-20&to_date=2026-11-10')
  .set('Authorization', `Bearer ${tokenA}`);
assert(invalidRangeRes.status === 422, `Invalid date range (from > to) rejected with HTTP 422 (got ${invalidRangeRes.status})`);
assert(
  invalidRangeRes.body.error?.message?.toLowerCase().includes('date') ||
  invalidRangeRes.body.error?.message?.toLowerCase().includes('cannot be after'),
  `Validation error explains date range issue: "${invalidRangeRes.body.error?.message}"`
);

// Malformed date strings
const malformedFromRes = await request(app)
  .get('/api/v1/transactions?from_date=not-a-date')
  .set('Authorization', `Bearer ${tokenA}`);
assert(malformedFromRes.status === 422, `Malformed from_date rejected with HTTP 422 (got ${malformedFromRes.status})`);

const malformedToRes = await request(app)
  .get('/api/v1/transactions?to_date=2026-13-45')
  .set('Authorization', `Bearer ${tokenA}`);
assert(malformedToRes.status === 422, `Malformed to_date rejected with HTTP 422 (got ${malformedToRes.status})`);

// ----------------------------------------------------
// Scenario 8: Tenant Isolation in Search & Filters
// ----------------------------------------------------
console.log(`\n--- Scenario 8: Tenant Isolation in Search & Filters ---`);

// User B queries transactions with search=ABC
const tenantSearchRes = await request(app)
  .get('/api/v1/transactions?search=abc')
  .set('Authorization', `Bearer ${tokenB}`);
assert(tenantSearchRes.status === 200, 'User B search returned HTTP 200');
const userBItems = tenantSearchRes.body.data.items || tenantSearchRes.body.data;
assert(userBItems.length === 0, `User B sees 0 transactions for search=abc (got ${userBItems.length}) - Tenant Isolation Verified`);

// User B queries with wide date range
const tenantDateRes = await request(app)
  .get('/api/v1/transactions?from_date=2026-01-01&to_date=2026-12-31')
  .set('Authorization', `Bearer ${tokenB}`);
assert(tenantDateRes.status === 200, 'User B date query returned HTTP 200');
const userBDateItems = tenantDateRes.body.data.items || tenantDateRes.body.data;
assert(userBDateItems.length === 0, `User B sees 0 transactions in wide date range (got ${userBDateItems.length})`);

console.log(`\n========================================`);
console.log(`TEST SUMMARY: ${passedTests}/${totalTests} PASSED`);
console.log(`========================================\n`);

if (passedTests !== totalTests) {
  process.exit(1);
} else {
  process.exit(0);
}
