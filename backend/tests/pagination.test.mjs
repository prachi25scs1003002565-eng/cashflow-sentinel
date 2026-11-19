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
console.log(`CASHFLOW SENTINEL - SERVER-SIDE PAGINATION TEST`);
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
    display_name: 'Pagination Merchant Alpha',
    email: `page_alpha_${suffix}@test.local`,
    password: 'Password123!',
  });
assert(regResA.status === 201, `User A registered with HTTP 201`);
const tokenA = regResA.body.data.access_token;
const userIdA = regResA.body.data.user.id;
assert(typeof tokenA === 'string' && tokenA.length > 20, 'User A received valid JWT');

const regResB = await request(app)
  .post('/api/v1/auth/register')
  .send({
    display_name: 'Pagination Merchant Beta',
    email: `page_beta_${suffix}@test.local`,
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
assert(outflowCats.length >= 1, `Found ${outflowCats.length} outflow categories`);

const catSales = inflowCats[0];
const catSupplies = outflowCats[0];

// ----------------------------------------------------
// Step 1: Seed 11 Active Transactions + 1 Soft-Deleted Transaction
// ----------------------------------------------------
console.log(`\n--- Step 1: Seeding 11 Active Transactions + 1 Soft-Deleted ---`);

// 7 Income transactions with distinct dates
const incomeDates = [
  '2026-11-01',
  '2026-11-02',
  '2026-11-04',
  '2026-11-06',
  '2026-11-08',
  '2026-11-10',
  '2026-11-11',
];

// 4 Expense transactions with distinct dates
const expenseDates = [
  '2026-11-03',
  '2026-11-05',
  '2026-11-07',
  '2026-11-09',
];

const createdIds = [];

// Seed Income
for (let i = 0; i < incomeDates.length; i++) {
  const date = incomeDates[i];
  const amount = (1000 * (i + 1)).toFixed(2);
  const res = await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      amount,
      cash_direction: 'INFLOW',
      category_id: catSales.id,
      description: `Sales revenue installment #${i + 1}`,
      counterparty_name: `Customer ${String.fromCharCode(65 + i)}`,
      transaction_date: date,
    });
  assert(res.status === 201, `Seeded income transaction #${i + 1} for ${date}`);
  createdIds.push({ id: res.body.data.id, date, direction: 'INFLOW', amount });
}

// Seed Expense
for (let i = 0; i < expenseDates.length; i++) {
  const date = expenseDates[i];
  const amount = (500 * (i + 1)).toFixed(2);
  const res = await request(app)
    .post('/api/v1/transactions')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      amount,
      cash_direction: 'OUTFLOW',
      category_id: catSupplies.id,
      description: `Office supplies purchase #${i + 1}`,
      counterparty_name: `Vendor ${String.fromCharCode(88 + i)}`,
      transaction_date: date,
    });
  assert(res.status === 201, `Seeded expense transaction #${i + 1} for ${date}`);
  createdIds.push({ id: res.body.data.id, date, direction: 'OUTFLOW', amount });
}

// Seed 1 additional transaction to be soft-deleted
const deleteTargetRes = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`)
  .send({
    amount: '9999.00',
    cash_direction: 'OUTFLOW',
    category_id: catSupplies.id,
    description: 'Accidental duplicate expense to be reversed',
    transaction_date: '2026-11-12',
  });
assert(deleteTargetRes.status === 201, 'Seeded duplicate transaction for soft-deletion');
const deletedTxId = deleteTargetRes.body.data.id;

// Soft-delete the 12th transaction
const delRes = await request(app)
  .delete(`/api/v1/transactions/${deletedTxId}`)
  .set('Authorization', `Bearer ${tokenA}`);
assert(delRes.status === 200, 'Soft-deleted transaction via DELETE endpoint');

// ----------------------------------------------------
// Scenario 1: First Page (page=1, limit=5)
// ----------------------------------------------------
console.log(`\n--- Scenario 1: First Page (page=1, limit=5) ---`);
const p1Res = await request(app)
  .get('/api/v1/transactions?page=1&limit=5')
  .set('Authorization', `Bearer ${tokenA}`);
assert(p1Res.status === 200, 'Page 1 returned HTTP 200');

const p1Items = p1Res.body.data.items || p1Res.body.data;
const p1Meta = p1Res.body.meta?.pagination;

assert(Array.isArray(p1Items), 'Page 1 items is an array');
assert(p1Items.length === 5, `Page 1 contains exactly 5 items (got ${p1Items.length})`);
assert(p1Meta !== undefined, 'Page 1 response includes pagination metadata');
assert(p1Meta.page === 1, `Page 1 metadata reports page === 1 (got ${p1Meta.page})`);
assert(p1Meta.limit === 5, `Page 1 metadata reports limit === 5 (got ${p1Meta.limit})`);
assert(p1Meta.total_items === 11, `Page 1 metadata reports total_items === 11 (got ${p1Meta.total_items})`);
assert(p1Meta.total_count === 11, `Page 1 metadata reports total_count === 11 (got ${p1Meta.total_count})`);
assert(p1Meta.total_pages === 3, `Page 1 metadata reports total_pages === 3 (got ${p1Meta.total_pages})`);

// Check deterministic ordering: newest date first
for (let i = 0; i < p1Items.length - 1; i++) {
  const current = p1Items[i].transaction_date.slice(0, 10);
  const next = p1Items[i + 1].transaction_date.slice(0, 10);
  assert(current >= next, `Ordering is descending: ${current} >= ${next}`);
}
assert(p1Items[0].transaction_date.slice(0, 10) === '2026-11-11', 'First item on page 1 is newest (2026-11-11)');

// ----------------------------------------------------
// Scenario 2: Middle Page (page=2, limit=5)
// ----------------------------------------------------
console.log(`\n--- Scenario 2: Middle Page (page=2, limit=5) ---`);
const p2Res = await request(app)
  .get('/api/v1/transactions?page=2&limit=5')
  .set('Authorization', `Bearer ${tokenA}`);
assert(p2Res.status === 200, 'Page 2 returned HTTP 200');

const p2Items = p2Res.body.data.items || p2Res.body.data;
const p2Meta = p2Res.body.meta?.pagination;

assert(p2Items.length === 5, `Page 2 contains exactly 5 items (got ${p2Items.length})`);
assert(p2Meta.page === 2, `Page 2 metadata reports page === 2 (got ${p2Meta.page})`);
assert(p2Meta.total_items === 11, `Page 2 metadata reports total_items === 11`);
assert(p2Meta.total_pages === 3, `Page 2 metadata reports total_pages === 3`);

// Verify complete separation between Page 1 and Page 2 (no ID overlap)
const p1IdSet = new Set(p1Items.map((item) => item.id));
const p2IdOverlap = p2Items.filter((item) => p1IdSet.has(item.id));
assert(p2IdOverlap.length === 0, `Page 1 and Page 2 have zero overlapping IDs (got ${p2IdOverlap.length})`);

// ----------------------------------------------------
// Scenario 3: Final Page (page=3, limit=5)
// ----------------------------------------------------
console.log(`\n--- Scenario 3: Final Page (page=3, limit=5) ---`);
const p3Res = await request(app)
  .get('/api/v1/transactions?page=3&limit=5')
  .set('Authorization', `Bearer ${tokenA}`);
assert(p3Res.status === 200, 'Page 3 returned HTTP 200');

const p3Items = p3Res.body.data.items || p3Res.body.data;
const p3Meta = p3Res.body.meta?.pagination;

assert(p3Items.length === 1, `Page 3 contains remaining 1 item (got ${p3Items.length})`);
assert(p3Meta.page === 3, `Page 3 metadata reports page === 3`);
assert(p3Meta.total_items === 11, `Page 3 metadata reports total_items === 11`);
assert(p3Meta.total_pages === 3, `Page 3 metadata reports total_pages === 3`);
assert(p3Items[0].transaction_date.slice(0, 10) === '2026-11-01', 'Final item is oldest transaction (2026-11-01)');

// ----------------------------------------------------
// Scenario 4: Beyond Final Page (page=4 & page=999)
// ----------------------------------------------------
console.log(`\n--- Scenario 4: Beyond Final Page (page=4 & page=999) ---`);
const p4Res = await request(app)
  .get('/api/v1/transactions?page=4&limit=5')
  .set('Authorization', `Bearer ${tokenA}`);
assert(p4Res.status === 200, 'Page 4 returned HTTP 200');
const p4Items = p4Res.body.data.items || p4Res.body.data;
const p4Meta = p4Res.body.meta?.pagination;
assert(p4Items.length === 0, 'Page 4 beyond total pages returns 0 items');
assert(p4Meta.page === 4, 'Page 4 metadata reports page === 4');
assert(p4Meta.total_items === 11, 'Page 4 total_items remains 11');
assert(p4Meta.total_pages === 3, 'Page 4 total_pages remains 3');

const p999Res = await request(app)
  .get('/api/v1/transactions?page=999&limit=5')
  .set('Authorization', `Bearer ${tokenA}`);
assert(p999Res.status === 200, 'Page 999 returned HTTP 200');
const p999Items = p999Res.body.data.items || p999Res.body.data;
assert(p999Items.length === 0, 'Page 999 returns 0 items');

// ----------------------------------------------------
// Scenario 5: Combined Filtering and Pagination
// ----------------------------------------------------
console.log(`\n--- Scenario 5: Combined Filtering and Pagination ---`);

// Filter by type=income (7 items total) with limit=4
const incP1Res = await request(app)
  .get('/api/v1/transactions?type=income&page=1&limit=4')
  .set('Authorization', `Bearer ${tokenA}`);
assert(incP1Res.status === 200, 'Filtered income page 1 returned HTTP 200');
const incP1Items = incP1Res.body.data.items || incP1Res.body.data;
const incP1Meta = incP1Res.body.meta?.pagination;

assert(incP1Items.length === 4, `Income Page 1 returned 4 items (got ${incP1Items.length})`);
assert(incP1Meta.page === 1, 'Income Page 1 metadata page === 1');
assert(incP1Meta.limit === 4, 'Income Page 1 metadata limit === 4');
assert(incP1Meta.total_items === 7, `Income total_items accurately reflects 7 income transactions (got ${incP1Meta.total_items})`);
assert(incP1Meta.total_pages === 2, `Income total_pages accurately calculates ceil(7/4) = 2 (got ${incP1Meta.total_pages})`);
assert(incP1Items.every((item) => item.cash_direction === 'INFLOW'), 'All returned items are INFLOW');

// Income Page 2
const incP2Res = await request(app)
  .get('/api/v1/transactions?type=income&page=2&limit=4')
  .set('Authorization', `Bearer ${tokenA}`);
assert(incP2Res.status === 200, 'Filtered income page 2 returned HTTP 200');
const incP2Items = incP2Res.body.data.items || incP2Res.body.data;
assert(incP2Items.length === 3, `Income Page 2 returned remaining 3 items (got ${incP2Items.length})`);
assert(incP2Items.every((item) => item.cash_direction === 'INFLOW'), 'All Page 2 items are INFLOW');

// Combined search + pagination: search for "revenue" (7 items) with limit=3
const searchP1Res = await request(app)
  .get('/api/v1/transactions?search=revenue&page=1&limit=3')
  .set('Authorization', `Bearer ${tokenA}`);
assert(searchP1Res.status === 200, 'Search pagination returned HTTP 200');
const searchP1Items = searchP1Res.body.data.items || searchP1Res.body.data;
const searchP1Meta = searchP1Res.body.meta?.pagination;
assert(searchP1Items.length === 3, 'Search Page 1 returns 3 items');
assert(searchP1Meta.total_items === 7, 'Search pagination total_items === 7');
assert(searchP1Meta.total_pages === 3, 'Search pagination total_pages === 3');

// Combined category + pagination: supplies category (4 items) with limit=2
const catP1Res = await request(app)
  .get(`/api/v1/transactions?category_id=${catSupplies.id}&page=1&limit=2`)
  .set('Authorization', `Bearer ${tokenA}`);
assert(catP1Res.status === 200, 'Category pagination returned HTTP 200');
const catP1Items = catP1Res.body.data.items || catP1Res.body.data;
const catP1Meta = catP1Res.body.meta?.pagination;
assert(catP1Items.length === 2, 'Category Page 1 returns 2 items');
assert(catP1Meta.total_items === 4, 'Category pagination total_items === 4');
assert(catP1Meta.total_pages === 2, 'Category pagination total_pages === 2');

// ----------------------------------------------------
// Scenario 6: Empty Results
// ----------------------------------------------------
console.log(`\n--- Scenario 6: Empty Results ---`);
const emptyRes = await request(app)
  .get('/api/v1/transactions?search=NonExistentEntity999&page=1&limit=10')
  .set('Authorization', `Bearer ${tokenA}`);
assert(emptyRes.status === 200, 'Empty search returned HTTP 200');
const emptyItems = emptyRes.body.data.items || emptyRes.body.data;
const emptyMeta = emptyRes.body.meta?.pagination;
assert(Array.isArray(emptyItems) && emptyItems.length === 0, 'Empty search returns empty array');
assert(emptyMeta.total_items === 0, 'Empty search metadata reports total_items === 0');
assert(emptyMeta.total_pages === 0, 'Empty search metadata reports total_pages === 0');
assert(emptyMeta.page === 1, 'Empty search metadata reports page === 1');

// ----------------------------------------------------
// Scenario 7: Validation of Page and Limit Parameters
// ----------------------------------------------------
console.log(`\n--- Scenario 7: Parameter Validation ---`);

// Invalid page values
const invalidPageZero = await request(app)
  .get('/api/v1/transactions?page=0')
  .set('Authorization', `Bearer ${tokenA}`);
assert(invalidPageZero.status === 422, 'page=0 rejected with HTTP 422');

const invalidPageNeg = await request(app)
  .get('/api/v1/transactions?page=-2')
  .set('Authorization', `Bearer ${tokenA}`);
assert(invalidPageNeg.status === 422, 'page=-2 rejected with HTTP 422');

const invalidPageString = await request(app)
  .get('/api/v1/transactions?page=invalid')
  .set('Authorization', `Bearer ${tokenA}`);
assert(invalidPageString.status === 422, 'page=invalid rejected with HTTP 422');

const invalidPageFloat = await request(app)
  .get('/api/v1/transactions?page=2.5')
  .set('Authorization', `Bearer ${tokenA}`);
assert(invalidPageFloat.status === 422, 'page=2.5 rejected with HTTP 422');

// Invalid limit values
const invalidLimitZero = await request(app)
  .get('/api/v1/transactions?limit=0')
  .set('Authorization', `Bearer ${tokenA}`);
assert(invalidLimitZero.status === 422, 'limit=0 rejected with HTTP 422');

const invalidLimitNeg = await request(app)
  .get('/api/v1/transactions?limit=-10')
  .set('Authorization', `Bearer ${tokenA}`);
assert(invalidLimitNeg.status === 422, 'limit=-10 rejected with HTTP 422');

const invalidLimitHigh = await request(app)
  .get('/api/v1/transactions?limit=101')
  .set('Authorization', `Bearer ${tokenA}`);
assert(invalidLimitHigh.status === 422, 'limit=101 rejected with HTTP 422');

const invalidLimitString = await request(app)
  .get('/api/v1/transactions?limit=fifty')
  .set('Authorization', `Bearer ${tokenA}`);
assert(invalidLimitString.status === 422, 'limit=fifty rejected with HTTP 422');

// ----------------------------------------------------
// Scenario 8: Tenant Isolation
// ----------------------------------------------------
console.log(`\n--- Scenario 8: Tenant Isolation ---`);
const tenantBRes = await request(app)
  .get('/api/v1/transactions?page=1&limit=10')
  .set('Authorization', `Bearer ${tokenB}`);
assert(tenantBRes.status === 200, 'Tenant B listing returned HTTP 200');
const tenantBItems = tenantBRes.body.data.items || tenantBRes.body.data;
const tenantBMeta = tenantBRes.body.meta?.pagination;
assert(tenantBItems.length === 0, `Tenant B sees 0 transactions (got ${tenantBItems.length})`);
assert(tenantBMeta.total_items === 0, 'Tenant B total_items is 0');
assert(tenantBMeta.total_pages === 0, 'Tenant B total_pages is 0');

// ----------------------------------------------------
// Scenario 9: Default Pagination Parameters
// ----------------------------------------------------
console.log(`\n--- Scenario 9: Default Pagination Parameters ---`);
const defaultRes = await request(app)
  .get('/api/v1/transactions')
  .set('Authorization', `Bearer ${tokenA}`);
assert(defaultRes.status === 200, 'Default query without params returned HTTP 200');
const defaultItems = defaultRes.body.data.items || defaultRes.body.data;
const defaultMeta = defaultRes.body.meta?.pagination;
assert(defaultItems.length === 11, `Default query returns all 11 active items (got ${defaultItems.length})`);
assert(defaultMeta.page === 1, 'Default page is 1');
assert(defaultMeta.limit === 50, 'Default limit is 50');
assert(defaultMeta.total_items === 11, 'Default total_items is 11');
assert(defaultMeta.total_pages === 1, 'Default total_pages is 1');

// ----------------------------------------------------
// Scenario 10: Soft-Deleted (REVERSED) Transactions Excluded
// ----------------------------------------------------
console.log(`\n--- Scenario 10: REVERSED Transactions Excluded ---`);
const allTxsRes = await request(app)
  .get('/api/v1/transactions?limit=100')
  .set('Authorization', `Bearer ${tokenA}`);
const allItems = allTxsRes.body.data.items || allTxsRes.body.data;
const deletedFound = allItems.find((item) => item.id === deletedTxId);
assert(deletedFound === undefined, 'Soft-deleted transaction is completely absent from all paginated results');
assert(allTxsRes.body.meta?.pagination?.total_items === 11, 'Total items strictly excludes reversed transaction');

// ----------------------------------------------------
// Summary
// ----------------------------------------------------
console.log(`\n========================================`);
console.log(`PAGINATION TEST RESULTS SUMMARY`);
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
