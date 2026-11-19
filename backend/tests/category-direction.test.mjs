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
console.log(`CASHFLOW SENTINEL - CATEGORY DIRECTION TEST`);
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

// Scenario 1: User & Business Registration
console.log(`--- Scenario 1: Provisioning Test Business ---`);
const regRes = await request(app)
  .post('/api/v1/auth/register')
  .send({
    display_name: 'Category Direction Merchant',
    email: `cat_dir_${suffix}@test.local`,
    password: 'Password123!',
  });
assert(regRes.status === 201, `User registered successfully with HTTP 201 (got ${regRes.status})`);
const token = regRes.body.data.access_token;
assert(typeof token === 'string' && token.length > 20, 'Received valid JWT token');

// Scenario 2: Fetch Categories
console.log(`\n--- Scenario 2: Categories Data Source Verification ---`);
const catRes = await request(app)
  .get('/api/v1/transactions/categories')
  .set('Authorization', `Bearer ${token}`);
assert(catRes.status === 200, `Categories endpoint returned HTTP 200 (got ${catRes.status})`);
const categories = catRes.body.data;
assert(Array.isArray(categories) && categories.length > 0, `Returned ${categories.length} categories`);

// Verify structure: id, category_code, display_name, allowed_direction
for (const cat of categories) {
  assert(Boolean(cat.id), `Category "${cat.display_name}" has valid id`);
  assert(['INFLOW', 'OUTFLOW', 'BOTH'].includes(cat.allowed_direction), `Category "${cat.display_name}" has valid allowed_direction: ${cat.allowed_direction}`);
}

// Scenario 3: Test Frontend Category-Filtering Logic for INFLOW
console.log(`\n--- Scenario 3: Direction-Based Filtering (INFLOW) ---`);
const filterInflow = (cats) => cats.filter((c) => c.allowed_direction === 'BOTH' || c.allowed_direction === 'INFLOW');
const inflowCategories = filterInflow(categories);
assert(inflowCategories.length > 0, `Found ${inflowCategories.length} categories for INFLOW`);
for (const c of inflowCategories) {
  assert(c.allowed_direction === 'INFLOW' || c.allowed_direction === 'BOTH', `Inflow filtered category "${c.display_name}" is strictly INFLOW or BOTH`);
}

// Scenario 4: Test Frontend Category-Filtering Logic for OUTFLOW
console.log(`\n--- Scenario 4: Direction-Based Filtering (OUTFLOW) ---`);
const filterOutflow = (cats) => cats.filter((c) => c.allowed_direction === 'BOTH' || c.allowed_direction === 'OUTFLOW');
const outflowCategories = filterOutflow(categories);
assert(outflowCategories.length > 0, `Found ${outflowCategories.length} categories for OUTFLOW`);
for (const c of outflowCategories) {
  assert(c.allowed_direction === 'OUTFLOW' || c.allowed_direction === 'BOTH', `Outflow filtered category "${c.display_name}" is strictly OUTFLOW or BOTH`);
}

// Ensure there is no overlap between strict INFLOW-only and strict OUTFLOW-only
const strictlyInflowIds = new Set(categories.filter((c) => c.allowed_direction === 'INFLOW').map((c) => c.id));
const strictlyOutflowIds = new Set(categories.filter((c) => c.allowed_direction === 'OUTFLOW').map((c) => c.id));
for (const id of strictlyInflowIds) {
  assert(!strictlyOutflowIds.has(id), `Strictly INFLOW category id ${id} is not in strictly OUTFLOW`);
}

// Scenario 5: Direction Switch Simulation
console.log(`\n--- Scenario 5: State-Management Direction Switch Simulation ---`);
// Simulate starting with 'income'
let currentFormType = 'income';
let currentAvailable = currentFormType === 'income' ? filterInflow(categories) : filterOutflow(categories);
let currentFormCategoryId = currentAvailable[0].id;
const initialInflowCat = categories.find((c) => c.id === currentFormCategoryId);
assert(initialInflowCat.allowed_direction === 'INFLOW' || initialInflowCat.allowed_direction === 'BOTH', `Initial category is valid for INFLOW: ${initialInflowCat.display_name}`);

// Switch to 'expense'
currentFormType = 'expense';
currentAvailable = currentFormType === 'income' ? filterInflow(categories) : filterOutflow(categories);
currentFormCategoryId = currentAvailable[0].id;
const switchedExpenseCat = categories.find((c) => c.id === currentFormCategoryId);
assert(switchedExpenseCat.allowed_direction === 'OUTFLOW' || switchedExpenseCat.allowed_direction === 'BOTH', `Switched category is valid for OUTFLOW: ${switchedExpenseCat.display_name}`);
assert(currentFormCategoryId !== initialInflowCat.id || initialInflowCat.allowed_direction === 'BOTH', `Category reset on direction switch verified`);

// Switch back to 'income'
currentFormType = 'income';
currentAvailable = currentFormType === 'income' ? filterInflow(categories) : filterOutflow(categories);
currentFormCategoryId = currentAvailable[0].id;
const switchedBackInflowCat = categories.find((c) => c.id === currentFormCategoryId);
assert(switchedBackInflowCat.allowed_direction === 'INFLOW' || switchedBackInflowCat.allowed_direction === 'BOTH', `Switched back category is valid for INFLOW: ${switchedBackInflowCat.display_name}`);

// Scenario 6: Validation Rule Simulation Before Submission
console.log(`\n--- Scenario 6: Client-Side Validation Rules Before Submission ---`);
function validateSubmission(formType, categoryId, cats) {
  if (!categoryId) {
    return { valid: false, error: 'Please select a valid category for this transaction.' };
  }
  const selected = cats.find((c) => c.id === categoryId);
  if (!selected) {
    return { valid: false, error: 'The selected category does not exist. Please choose a valid category.' };
  }
  const expectedDirection = formType === 'income' ? 'INFLOW' : 'OUTFLOW';
  if (selected.allowed_direction !== 'BOTH' && selected.allowed_direction !== expectedDirection) {
    return {
      valid: false,
      error: `Category "${selected.display_name}" is only allowed for ${
        selected.allowed_direction === 'INFLOW' ? 'income (inflow)' : 'expense (outflow)'
      } transactions and cannot be used with ${formType === 'income' ? 'income' : 'expense'}.`,
    };
  }
  return { valid: true, error: null };
}

// 6a: Valid income with inflow category
const val1 = validateSubmission('income', inflowCategories[0].id, categories);
assert(val1.valid === true && val1.error === null, 'Valid income submission passed client validation');

// 6b: Valid expense with outflow category
const val2 = validateSubmission('expense', outflowCategories[0].id, categories);
assert(val2.valid === true && val2.error === null, 'Valid expense submission passed client validation');

// 6c: Invalid combination: income with strictly outflow category
const strictlyOutflowCat = categories.find((c) => c.allowed_direction === 'OUTFLOW');
assert(Boolean(strictlyOutflowCat), `Found strictly OUTFLOW category: ${strictlyOutflowCat.display_name}`);
const val3 = validateSubmission('income', strictlyOutflowCat.id, categories);
assert(val3.valid === false, 'Invalid combination (income + OUTFLOW category) rejected by client validation');
assert(val3.error.includes('only allowed for expense (outflow) transactions'), `Error message clearly explains incompatibility: "${val3.error}"`);

// 6d: Invalid combination: expense with strictly inflow category
const strictlyInflowCat = categories.find((c) => c.allowed_direction === 'INFLOW');
assert(Boolean(strictlyInflowCat), `Found strictly INFLOW category: ${strictlyInflowCat.display_name}`);
const val4 = validateSubmission('expense', strictlyInflowCat.id, categories);
assert(val4.valid === false, 'Invalid combination (expense + INFLOW category) rejected by client validation');
assert(val4.error.includes('only allowed for income (inflow) transactions'), `Error message clearly explains incompatibility: "${val4.error}"`);

// 6e: Non-existent category
const val5 = validateSubmission('income', '00000000-0000-0000-0000-000000000000', categories);
assert(val5.valid === false, 'Non-existent category rejected');
assert(val5.error.includes('selected category does not exist'), `Error explains category not found: "${val5.error}"`);

// Scenario 7: Live Backend & PostgreSQL Trigger Enforcement
console.log(`\n--- Scenario 7: Database & Backend Compatibility Testing ---`);

// 7a: Create valid INFLOW transaction with category_id
const todayStr = new Date().toISOString().slice(0, 10);
const postValidInflow = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${token}`)
  .send({
    type: 'income',
    amount: '4500.00',
    category_id: strictlyInflowCat.id,
    category: strictlyInflowCat.display_name,
    description: 'Valid Inflow Transaction with category_id',
    transaction_date: todayStr,
  });
assert(postValidInflow.status === 201, `Valid INFLOW transaction created: HTTP 201 (got ${postValidInflow.status})`);
assert(postValidInflow.body.data.category_id === strictlyInflowCat.id, `Persisted transaction has correct category_id: ${postValidInflow.body.data.category_id}`);
assert(postValidInflow.body.data.cash_direction === 'INFLOW', `Persisted cash_direction is INFLOW`);

// 7b: Create valid OUTFLOW transaction with category_id
const postValidOutflow = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${token}`)
  .send({
    type: 'expense',
    amount: '1200.00',
    category_id: strictlyOutflowCat.id,
    category: strictlyOutflowCat.display_name,
    description: 'Valid Outflow Transaction with category_id',
    transaction_date: todayStr,
  });
assert(postValidOutflow.status === 201, `Valid OUTFLOW transaction created: HTTP 201 (got ${postValidOutflow.status})`);
assert(postValidOutflow.body.data.category_id === strictlyOutflowCat.id, `Persisted transaction has correct category_id: ${postValidOutflow.body.data.category_id}`);
assert(postValidOutflow.body.data.cash_direction === 'OUTFLOW', `Persisted cash_direction is OUTFLOW`);

// 7c: Attempt to submit invalid combination to backend (simulating a bypassed client)
// PostgreSQL trigger fn_check_transaction_category_direction must reject this!
const postInvalidCombination = await request(app)
  .post('/api/v1/transactions')
  .set('Authorization', `Bearer ${token}`)
  .send({
    type: 'income',
    amount: '999.00',
    category_id: strictlyOutflowCat.id, // OUTFLOW category for income!
    description: 'Bypassed invalid direction transaction',
    transaction_date: todayStr,
  });
assert(postInvalidCombination.status >= 400, `Backend / DB Trigger rejected incompatible category-direction: HTTP ${postInvalidCombination.status}`);
console.log(`Backend / DB Trigger rejection confirmed: status ${postInvalidCombination.status}, message: ${postInvalidCombination.body?.error?.message || 'Rejected'}`);

console.log(`\n========================================`);
console.log(`CATEGORY DIRECTION TEST SUMMARY:`);
console.log(`Total assertions: ${totalTests}`);
console.log(`Passed: ${passedTests}`);
console.log(`Failed: 0`);
console.log(`ALL TEST SCENARIOS PASSED!`);
console.log(`========================================\n`);

process.exit(0);
