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
console.log(`DAY 2 — PHASE 4: FINANCIAL EXPLANATION ENGINE TEST SUITE`);
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
    const email = `expl_${tag}_${suffix}@example.com`;
    const password = 'Password@123';
    const displayName = `Expl ${tag} Enterprise`;

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
  async function seedReceivable(tenant, dateStr, amountPaise, label, certainty = 'CONFIRMED') {
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
       VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
      [receivableId, tenant.businessId, invoiceId, dateStr, certainty]
    );
  }

  // Helper: Seed future supplier payable (supplier bill)
  async function seedPayable(tenant, dateStr, amountPaise, label, certainty = 'CONFIRMED') {
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
       VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
      [payableId, tenant.businessId, billId, dateStr, certainty]
    );
  }

  // =========================================================================
  // TEST 1: Insufficient-History Explanation
  // =========================================================================
  console.log(`\n--- Test 1: Insufficient-History Explanation ---`);
  const tenantNew = await createIsolatedTenant('insuff_exp');
  const resInsuff = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantNew.token}`);

  assert(resInsuff.status === 200, 'GET /forecasts/latest returns 200 for insufficient history');
  assert(resInsuff.body.data.has_sufficient_history === false, 'has_sufficient_history is false');
  assert(Array.isArray(resInsuff.body.data.explanations), 'explanations array returned');
  assert(resInsuff.body.data.explanations.length >= 1, 'at least 1 explanation returned');

  const expInsuff = resInsuff.body.data.explanations.find((e) => e.category === 'INSUFFICIENT_HISTORY');
  assert(expInsuff !== undefined, 'INSUFFICIENT_HISTORY explanation exists');
  assert(expInsuff.title === 'Historical Transaction Coverage Required', 'Explanation title is correct');
  assert(expInsuff.text.includes('14 calendar days'), 'Explanation mentions 14 calendar days requirement');
  assert(expInsuff.text.includes('7 distinct active transaction days'), 'Explanation mentions 7 active transaction days');
  assert(expInsuff.text.includes('7 posted transactions'), 'Explanation mentions 7 posted transactions');
  assert(expInsuff.severity === 'WARNING', 'Severity is WARNING');
  assert(expInsuff.source_type === 'DATA_REQUIREMENT', 'Source type is DATA_REQUIREMENT');

  // =========================================================================
  // TEST 2: Upcoming Payable Obligations Explanation
  // =========================================================================
  console.log(`\n--- Test 2: Upcoming Payable Obligations Explanation ---`);
  const tenantPay = await createIsolatedTenant('payable_exp');
  await seedHistoryForOpeningBalance(tenantPay, 10000000n); // ₹100,000 opening
  await setBusinessBuffer(tenantPay, 5000000n); // ₹50,000 buffer

  // Scheduled payable: ₹45,000.00 (4,500,000 paise) to "Steel City Supplies" on Day 5 (2026-10-19)
  const day5Date = '2026-10-19';
  await seedPayable(tenantPay, day5Date, 4500000n, 'Steel City Supplies', 'CONFIRMED');

  const resPay = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantPay.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(resPay.status === 201, 'Forecast generated with HTTP 201');
  assert(Array.isArray(resPay.body.data.run.explanations), 'run.explanations is an array');

  const expPay = resPay.body.data.run.explanations.find((e) => e.category === 'PAYABLE_OBLIGATION');
  assert(expPay !== undefined, 'PAYABLE_OBLIGATION explanation exists');
  assert(expPay.title.includes('Steel City Supplies'), 'Title includes supplier name: "Steel City Supplies"');
  assert(expPay.text.includes('45,000.00'), 'Text includes formatted amount: ₹45,000.00');
  assert(expPay.text.includes('Steel City Supplies'), 'Text mentions supplier');
  assert(expPay.text.includes(day5Date), `Text mentions scheduled date ${day5Date}`);
  assert(expPay.text.includes('reduces projected cash'), 'Text explains cash impact (reduces projected cash)');
  assert(expPay.date === day5Date, `Explanation date matches ${day5Date}`);
  assert(expPay.amount_paise === '4500000', 'amount_paise is 4500000');
  assert(expPay.certainty === 'CONFIRMED', 'Certainty is CONFIRMED');
  assert(expPay.source_type === 'PAYABLE', 'source_type is PAYABLE');

  // =========================================================================
  // TEST 3: Expected Receivables Explanation
  // =========================================================================
  console.log(`\n--- Test 3: Expected Receivables Explanation ---`);
  // Scheduled receivable: ₹75,000.00 (7,500,000 paise) from "Apex Distributors" on Day 8 (2026-10-22)
  const day8Date = '2026-10-22';
  await seedReceivable(tenantPay, day8Date, 7500000n, 'Apex Distributors', 'CONFIRMED');

  const resRec = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantPay.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(resRec.status === 201, 'Forecast regenerated with receivable');
  const expRec = resRec.body.data.run.explanations.find((e) => e.category === 'EXPECTED_RECEIVABLE');
  assert(expRec !== undefined, 'EXPECTED_RECEIVABLE explanation exists');
  assert(expRec.title.includes('Apex Distributors'), 'Title includes customer name: "Apex Distributors"');
  assert(expRec.text.includes('75,000.00'), 'Text includes formatted amount: ₹75,000.00');
  assert(expRec.text.includes('Apex Distributors'), 'Text mentions customer name');
  assert(expRec.text.includes(day8Date), `Text mentions expected collection date ${day8Date}`);
  assert(expRec.text.includes('supports projected cash'), 'Text explains positive cash contribution');
  assert(expRec.date === day8Date, `Explanation date matches ${day8Date}`);
  assert(expRec.amount_paise === '7500000', 'amount_paise is 7500000');
  assert(expRec.certainty === 'CONFIRMED', 'Certainty is CONFIRMED');
  assert(expRec.source_type === 'RECEIVABLE', 'source_type is RECEIVABLE');

  // =========================================================================
  // TEST 4: Cash-Buffer Breach Explanation
  // =========================================================================
  console.log(`\n--- Test 4: Cash-Buffer Breach Explanation ---`);
  const tenantBreach = await createIsolatedTenant('breach_exp');
  await seedHistoryForOpeningBalance(tenantBreach, 10000000n); // ₹100,000 opening
  await setBusinessBuffer(tenantBreach, 8000000n); // ₹80,000 buffer

  // Payable on Day 5: ₹40,000 -> Cash dips to ₹60,000 (< ₹80,000 buffer) -> Shortfall ₹20,000
  await seedPayable(tenantBreach, day5Date, 4000000n, 'Large Raw Material Bill');

  const resBreach = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantBreach.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(resBreach.status === 201, 'Forecast generated with breach');
  const expBreach = resBreach.body.data.run.explanations.find((e) => e.category === 'BUFFER_BREACH');
  assert(expBreach !== undefined, 'BUFFER_BREACH explanation exists');
  assert(expBreach.title.includes('Operating Cash Buffer Breach'), 'Title indicates buffer breach');
  assert(expBreach.text.includes('60,000.00'), 'Text includes projected closing cash ₹60,000.00');
  assert(expBreach.text.includes('20,000.00'), 'Text includes calculated shortfall ₹20,000.00');
  assert(expBreach.text.includes('80,000.00'), 'Text includes required buffer ₹80,000.00');
  assert(expBreach.date === day5Date, `Breach explanation date is Day 5 (${day5Date})`);
  assert(expBreach.amount_paise === '2000000', 'Shortfall amount_paise is 2000000');
  assert(expBreach.severity === 'WARNING', 'Severity is WARNING (cash remains positive)');

  // =========================================================================
  // TEST 5: Negative Cash Position Explanation
  // =========================================================================
  console.log(`\n--- Test 5: Negative Cash Position Explanation ---`);
  const tenantNeg = await createIsolatedTenant('neg_exp');
  await seedHistoryForOpeningBalance(tenantNeg, 5000000n); // ₹50,000 opening
  await setBusinessBuffer(tenantNeg, 2000000n); // ₹20,000 buffer

  // Payable on Day 7 (2026-10-21): ₹75,000 -> Cash drops to -₹25,000
  const day7Date = '2026-10-21';
  await seedPayable(tenantNeg, day7Date, 7500000n, 'Heavy Machinery Purchase');

  const resNeg = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantNeg.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(resNeg.status === 201, 'Forecast generated with negative cash');
  const expNeg = resNeg.body.data.run.explanations.find((e) => e.category === 'NEGATIVE_CASH');
  assert(expNeg !== undefined, 'NEGATIVE_CASH explanation exists');
  assert(expNeg.severity === 'CRITICAL', 'NEGATIVE_CASH severity is CRITICAL');
  assert(expNeg.title.includes('Negative Cash Position'), 'Title mentions Negative Cash Position');
  assert(expNeg.text.includes(day7Date), `Text mentions date of deficit onset ${day7Date}`);
  assert(expNeg.text.includes('25,000.00'), 'Text mentions deficit amount: ₹25,000.00');
  assert(expNeg.date === day7Date, `Explanation date matches ${day7Date}`);
  assert(expNeg.amount_paise === '2500000', 'Deficit amount_paise is 2500000');

  // =========================================================================
  // TEST 6: No-Movement Scenario Explanation
  // =========================================================================
  console.log(`\n--- Test 6: No-Movement Scenario Explanation ---`);
  const tenantNoMove = await createIsolatedTenant('nomove_exp');
  await seedHistoryForOpeningBalance(tenantNoMove, 8000000n); // ₹80,000 opening, 0 movements
  await setBusinessBuffer(tenantNoMove, 4000000n);

  const resNoMove = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantNoMove.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(resNoMove.status === 201, 'No-movement forecast generated');
  const expNoMove = resNoMove.body.data.run.explanations.find((e) => e.category === 'NO_MOVEMENTS');
  assert(expNoMove !== undefined, 'NO_MOVEMENTS explanation exists');
  assert(expNoMove.title.includes('No Scheduled Movements'), 'Title indicates no scheduled movements');
  assert(expNoMove.text.includes('80,000.00'), 'Text explains cash holds steady at opening balance ₹80,000.00');
  assert(expNoMove.text.includes('No upcoming customer receivables or supplier payables'), 'Text clarifies no registered movements');
  assert(expNoMove.severity === 'INFO', 'Severity is INFO');

  // =========================================================================
  // TEST 7: Tenant Isolation
  // =========================================================================
  console.log(`\n--- Test 7: Multi-Tenant Explanation Isolation ---`);
  const tenantSecret = await createIsolatedTenant('secret_exp');
  await seedHistoryForOpeningBalance(tenantSecret, 5000000n);
  await seedPayable(tenantSecret, '2026-10-20', 3000000n, 'Classified Ultra Secret Payment');

  const resSecret = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantSecret.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(resSecret.status === 201, 'Tenant Secret forecast generated');
  const secretExps = resSecret.body.data.run.explanations;
  assert(secretExps.some((e) => e.text.includes('Classified Ultra Secret Payment')), 'Secret tenant has own explanation');

  // Tenant NoMove queries /latest
  const latestNoMove = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantNoMove.token}`);

  const noMoveExplanations = latestNoMove.body.data.explanations;
  const hasLeakage = noMoveExplanations.some((e) =>
    e.text.includes('Classified Ultra Secret Payment') || e.title.includes('Classified Ultra Secret Payment')
  );
  assert(hasLeakage === false, 'Tenant NoMove has ZERO exposure to Tenant Secret data (Isolation Confirmed)');

  // =========================================================================
  // TEST 8: Cash-Flow Improvement After Forecast Regeneration
  // =========================================================================
  console.log(`\n--- Test 8: Cash-Flow Improvement After Regeneration ---`);
  const tenantImp = await createIsolatedTenant('improve_exp');
  await seedHistoryForOpeningBalance(tenantImp, 6000000n); // ₹60,000 opening
  await setBusinessBuffer(tenantImp, 5000000n); // ₹50,000 buffer

  // Run 1: Payable on Day 5: ₹20,000 -> Drops to ₹40,000 (< ₹50,000 buffer) -> Breach!
  await seedPayable(tenantImp, day5Date, 2000000n, 'Bill causing deficit');

  const run1 = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantImp.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(run1.status === 201, 'Run 1 generated with breach');
  assert(run1.body.data.summary.has_buffer_breach === true, 'Run 1 has breach');

  // Step 2: Add large receivable from "Global Retail Client" on Day 3: ₹100,000.00
  const day3Date = '2026-10-17';
  await seedReceivable(tenantImp, day3Date, 10000000n, 'Global Retail Client');

  // Run 2: Generated after receivable added
  const run2 = await request(app)
    .post('/api/v1/forecasts/generate')
    .set('Authorization', `Bearer ${tenantImp.token}`)
    .send({ horizon_days: 30, as_of_date: AS_OF_DATE });

  assert(run2.status === 201, 'Run 2 generated');
  assert(run2.body.data.summary.has_buffer_breach === false, 'Run 2 breach is resolved');

  const expImp = run2.body.data.run.explanations.find((e) => e.category === 'CASH_FLOW_IMPROVEMENT');
  assert(expImp !== undefined, 'CASH_FLOW_IMPROVEMENT explanation generated for Run 2');
  assert(expImp.title.includes('Cash-Flow Improvement'), 'Title indicates Cash-Flow Improvement');
  assert(expImp.text.includes('Global Retail Client'), 'Explanation identifies customer receipt driver');
  assert(expImp.text.includes('1,00,000.00') || expImp.text.includes('improved by'), 'Explanation details improvement amount');
  assert(expImp.text.includes('resolved'), 'Explanation notes that previous buffer breach is resolved');

  // Verify GET /latest returns Run 2 with CASH_FLOW_IMPROVEMENT
  const latestImp = await request(app)
    .get('/api/v1/forecasts/latest')
    .set('Authorization', `Bearer ${tenantImp.token}`);

  assert(latestImp.status === 200, 'GET /latest succeeded');
  assert(
    latestImp.body.data.explanations.some((e) => e.category === 'CASH_FLOW_IMPROVEMENT'),
    'GET /latest includes CASH_FLOW_IMPROVEMENT explanation'
  );

  console.log(`\n========================================================================`);
  console.log(`🎉 ALL FINANCIAL EXPLANATION ENGINE TESTS PASSED: ${passedTests}/${totalTests} assertions`);
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
