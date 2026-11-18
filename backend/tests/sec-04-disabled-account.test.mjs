/**
 * Cashflow Sentinel — SEC-04 Disabled Account Access Test Suite
 *
 * Verifies:
 * 1. Active users with valid JWTs can access protected routes normally.
 * 2. Disabled users with previously issued valid JWTs receive HTTP 401.
 * 3. Disabled users cannot access `/auth/me`.
 * 4. Disabled users cannot access transactions or forecasting endpoints protected by tenant isolation.
 * 5. Pending-verification users cannot access protected business routes.
 * 6. Disabled users cannot trigger default business or cash-account auto-provisioning.
 * 7. Existing tenant membership and business-status restrictions still work.
 * 8. Missing or invalid JWT behavior remains unchanged.
 */

import request from 'supertest';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

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
console.log(`[SAFETY CHECK PASSED] Target database confirmed: "${currentDb}"\n`);

import appExport from '../dist/app.js';
const app = appExport.default || appExport;

const JWT_SECRET = process.env.JWT_SECRET;
const suffix = Date.now();

console.log('========================================================================');
console.log('CASHFLOW SENTINEL — SEC-04 DISABLED ACCOUNT ACCESS TEST SUITE');
console.log(`Target Database: ${currentDb}`);
console.log(`Timestamp Suffix: ${suffix}`);
console.log('========================================================================\n');

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

// Helper to sign valid test JWTs
function signToken(userId, email) {
  return jwt.sign(
    { sub: userId, email },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '15m' }
  );
}

// Track created test IDs for guaranteed cleanup
const createdUserIds = [];
const createdBusinessIds = [];

try {
  // ---------------------------------------------------------------------------
  // 1. Setup Active Test User
  // ---------------------------------------------------------------------------
  console.log('--- 1. Active User Access ---');
  const user1Email = `sec04.active.${suffix}@example.com`;
  const user1Res = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, account_status)
     VALUES ($1, 'dummy_hash', 'SEC04 Active User', 'ACTIVE')
     RETURNING id, email`,
    [user1Email]
  );
  const user1Id = user1Res.rows[0].id;
  createdUserIds.push(user1Id);

  const user1Token = signToken(user1Id, user1Email);

  // Active user can access /auth/me
  const meRes = await request(app)
    .get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${user1Token}`);

  assert(meRes.status === 200, 'Active user receives HTTP 200 on /auth/me');
  assert(meRes.body?.data?.email === user1Email, 'Active user profile data matches');
  assert(meRes.body?.data?.account_status === 'ACTIVE', 'Active user profile shows account_status ACTIVE');

  // Active user can access business-protected routes (auto-provisions initial business)
  const txRes = await request(app)
    .get('/api/v1/transactions')
    .set('Authorization', `Bearer ${user1Token}`);

  assert(txRes.status === 200, 'Active user receives HTTP 200 on /transactions');

  // Verify business was auto-provisioned
  const bizRes = await pool.query(
    `SELECT b.id FROM businesses b
     JOIN business_memberships bm ON bm.business_id = b.id
     WHERE bm.user_id = $1`,
    [user1Id]
  );
  assert(bizRes.rows.length === 1, 'Active user successfully auto-provisioned 1 business');
  createdBusinessIds.push(bizRes.rows[0].id);

  // ---------------------------------------------------------------------------
  // 2. Disabled User with Previously Issued JWT
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Disabled User Immediate Revocation ---');

  // Administrator disables the user account in database:
  await pool.query(
    `UPDATE users SET account_status = 'DISABLED' WHERE id = $1`,
    [user1Id]
  );

  // Attempt /auth/me with the SAME previously valid JWT
  const disabledMeRes = await request(app)
    .get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${user1Token}`);

  assert(disabledMeRes.status === 401, `Disabled user is rejected with HTTP 401 on /auth/me (got ${disabledMeRes.status})`);
  assert(
    disabledMeRes.body?.error?.code === 'ACCOUNT_DISABLED',
    `Disabled user receives error code "ACCOUNT_DISABLED" on /auth/me (got ${disabledMeRes.body?.error?.code})`
  );
  assert(
    typeof disabledMeRes.body?.error?.message === 'string',
    `Disabled user error message is present: "${disabledMeRes.body?.error?.message}"`
  );

  // Attempt /transactions with the SAME previously valid JWT
  const disabledTxRes = await request(app)
    .get('/api/v1/transactions')
    .set('Authorization', `Bearer ${user1Token}`);

  assert(disabledTxRes.status === 401, `Disabled user is rejected with HTTP 401 on /transactions (got ${disabledTxRes.status})`);
  assert(
    disabledTxRes.body?.error?.code === 'ACCOUNT_DISABLED',
    `Disabled user receives error code "ACCOUNT_DISABLED" on /transactions (got ${disabledTxRes.body?.error?.code})`
  );

  // Attempt /forecasts/simulate with the SAME previously valid JWT
  const disabledSimRes = await request(app)
    .post('/api/v1/forecasts/simulate')
    .set('Authorization', `Bearer ${user1Token}`)
    .send({ horizon_days: 30 });

  assert(disabledSimRes.status === 401, `Disabled user is rejected with HTTP 401 on /forecasts/simulate (got ${disabledSimRes.status})`);
  assert(
    disabledSimRes.body?.error?.code === 'ACCOUNT_DISABLED',
    `Disabled user receives error code "ACCOUNT_DISABLED" on /forecasts/simulate (got ${disabledSimRes.body?.error?.code})`
  );

  // ---------------------------------------------------------------------------
  // 3. Disabled User Without Business Cannot Trigger Auto-Provisioning
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Disabled User Cannot Trigger Auto-Provisioning ---');

  const user2Email = `sec04.disabled.nobiz.${suffix}@example.com`;
  const user2Res = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, account_status)
     VALUES ($1, 'dummy_hash', 'SEC04 Disabled No-Biz', 'DISABLED')
     RETURNING id, email`,
    [user2Email]
  );
  const user2Id = user2Res.rows[0].id;
  createdUserIds.push(user2Id);
  const user2Token = signToken(user2Id, user2Email);

  // Disabled user makes a request to /transactions
  const noBizTxRes = await request(app)
    .get('/api/v1/transactions')
    .set('Authorization', `Bearer ${user2Token}`);

  assert(noBizTxRes.status === 401, `Disabled user without business is rejected with HTTP 401 (got ${noBizTxRes.status})`);
  assert(noBizTxRes.body?.error?.code === 'ACCOUNT_DISABLED', 'Error code is ACCOUNT_DISABLED');

  // Verify that NO businesses were created for this disabled user
  const user2BizCount = await pool.query(
    `SELECT count(*) FROM business_memberships WHERE user_id = $1`,
    [user2Id]
  );
  assert(
    Number(user2BizCount.rows[0].count) === 0,
    'Verified: auto-provisioning was NEVER triggered for the disabled user (0 businesses created)'
  );

  // ---------------------------------------------------------------------------
  // 4. Pending Verification User Access
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. Pending Verification User Access ---');

  const user3Email = `sec04.pending.${suffix}@example.com`;
  const user3Res = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, account_status)
     VALUES ($1, 'dummy_hash', 'SEC04 Pending User', 'PENDING_VERIFICATION')
     RETURNING id, email`,
    [user3Email]
  );
  const user3Id = user3Res.rows[0].id;
  createdUserIds.push(user3Id);
  const user3Token = signToken(user3Id, user3Email);

  // Attempt /auth/me
  const pendingMeRes = await request(app)
    .get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${user3Token}`);

  assert(pendingMeRes.status === 401, `Pending verification user is rejected with HTTP 401 on /auth/me (got ${pendingMeRes.status})`);
  assert(
    pendingMeRes.body?.error?.code === 'ACCOUNT_PENDING_VERIFICATION',
    `Pending verification code is "ACCOUNT_PENDING_VERIFICATION" on /auth/me (got ${pendingMeRes.body?.error?.code})`
  );

  // Attempt /transactions
  const pendingTxRes = await request(app)
    .get('/api/v1/transactions')
    .set('Authorization', `Bearer ${user3Token}`);

  assert(pendingTxRes.status === 401, `Pending verification user is rejected with HTTP 401 on /transactions (got ${pendingTxRes.status})`);
  assert(
    pendingTxRes.body?.error?.code === 'ACCOUNT_PENDING_VERIFICATION',
    `Pending verification code is "ACCOUNT_PENDING_VERIFICATION" on /transactions (got ${pendingTxRes.body?.error?.code})`
  );

  // ---------------------------------------------------------------------------
  // 5. Tenant Membership & Isolation Invariance
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. Tenant Isolation Invariance ---');

  // Reactivate user 1
  await pool.query(
    `UPDATE users SET account_status = 'ACTIVE' WHERE id = $1`,
    [user1Id]
  );

  // Accessing an unassociated/random business UUID returns 404
  const randomBizId = '00000000-0000-0000-0000-000000000099';
  const unauthBizRes = await request(app)
    .get(`/api/v1/businesses/${randomBizId}/transactions`)
    .set('Authorization', `Bearer ${user1Token}`);

  assert(
    unauthBizRes.status === 404,
    `Active user requesting unassociated business receives HTTP 404 (got ${unauthBizRes.status})`
  );
  assert(
    unauthBizRes.body?.error?.code === 'BUSINESS_NOT_FOUND',
    'Error code is BUSINESS_NOT_FOUND for inaccessible tenant'
  );

  // ---------------------------------------------------------------------------
  // 6. Missing or Invalid JWT Behavior Unchanged
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. Missing / Invalid JWT Behavior ---');

  // Missing Authorization header
  const noTokenRes = await request(app).get('/api/v1/transactions');
  assert(noTokenRes.status === 401, 'Request without token returns HTTP 401');
  assert(noTokenRes.body?.error?.code === 'AUTHENTICATION_REQUIRED', 'Error code is AUTHENTICATION_REQUIRED');

  // Invalid signature
  const forgedToken = signToken(user1Id, user1Email).slice(0, -6) + 'xxxxxx';
  const forgedRes = await request(app)
    .get('/api/v1/transactions')
    .set('Authorization', `Bearer ${forgedToken}`);
  assert(forgedRes.status === 401, 'Request with forged signature returns HTTP 401');

} finally {
  // ---------------------------------------------------------------------------
  // Guaranteed Cleanup of Test Data in Test Database
  // ---------------------------------------------------------------------------
  console.log('\n--- Cleanup Test Artifacts ---');
  for (const bId of createdBusinessIds) {
    await pool.query('DELETE FROM businesses WHERE id = $1', [bId]);
  }
  for (const uId of createdUserIds) {
    await pool.query('DELETE FROM users WHERE id = $1', [uId]);
  }
  await pool.end();
  console.log(`Cleaned up ${createdUserIds.length} test users and ${createdBusinessIds.length} test businesses.`);
}

console.log('\n========================================================================');
console.log(`SEC-04 DISABLED ACCOUNT ACCESS TEST SUITE: ${passedTests}/${totalTests} PASSED`);
console.log('========================================================================\n');

if (passedTests === totalTests) {
  process.exit(0);
} else {
  process.exit(1);
}
