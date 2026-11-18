/**
 * Cashflow Sentinel — SEC-03 Rate Limiting Test Suite
 *
 * Verifies:
 * 1. First five login requests from the same IP are allowed through the limiter.
 * 2. Sixth login request receives HTTP 429.
 * 3. Response contains `TOO_MANY_REQUESTS`.
 * 4. Response contains a valid `Retry-After` header.
 * 5. Registration requests enforce the separate registration limit (3 requests).
 * 6. Requests from different IPs are independently tracked.
 * 7. Unrelated endpoints (e.g. /health) are not rate-limited.
 * 8. Reusable middleware unit tests (injectable clock, bounded store, reset, timer-safety).
 */

import request from 'supertest';
import appExport from '../dist/app.js';
import { createRateLimiter } from '../dist/middleware/rate-limit.js';
import { loginRateLimiter, registerRateLimiter } from '../dist/modules/auth/auth.routes.js';

const app = appExport.default || appExport;

console.log('========================================================================');
console.log('CASHFLOW SENTINEL — SEC-03 RATE LIMITING TEST SUITE');
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

// Reset limiters before starting
loginRateLimiter.reset();
registerRateLimiter.reset();

// -----------------------------------------------------------------------------
// Test Suite 1: Login Rate Limiting (5 requests per 60s per IP)
// -----------------------------------------------------------------------------
console.log('\n--- 1. Login Rate Limiting (POST /api/v1/auth/login) ---');

// Requests 1 through 5 should pass through the rate limiter.
// Even with empty/invalid payload, they reach controller/validator and return 422 or 401, NOT 429!
for (let i = 1; i <= 5; i++) {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'test@example.com', password: 'wrong' });

  assert(
    res.status !== 429,
    `Login request #${i} passes limiter (got HTTP ${res.status}, not 429)`
  );
}

// Request 6 must be blocked by the rate limiter with HTTP 429
const blockedRes = await request(app)
  .post('/api/v1/auth/login')
  .send({ email: 'test@example.com', password: 'wrong' });

assert(blockedRes.status === 429, `Login request #6 is blocked with HTTP 429 (got ${blockedRes.status})`);
assert(
  blockedRes.body?.error?.code === 'TOO_MANY_REQUESTS',
  `Blocked response code is "TOO_MANY_REQUESTS" (got: ${blockedRes.body?.error?.code})`
);
assert(
  typeof blockedRes.body?.error?.message === 'string' && blockedRes.body.error.message.length > 0,
  `Blocked response contains informative message: "${blockedRes.body?.error?.message}"`
);
assert(
  typeof blockedRes.body?.request_id === 'string' && blockedRes.body.request_id.length > 0,
  `Blocked response preserves request_id: "${blockedRes.body?.request_id}"`
);

const retryAfter = blockedRes.headers['retry-after'];
assert(
  retryAfter !== undefined && Number(retryAfter) > 0 && Number(retryAfter) <= 60,
  `Blocked response provides valid Retry-After header: ${retryAfter} seconds`
);

// -----------------------------------------------------------------------------
// Test Suite 2: Registration Rate Limiting (3 requests per 60m per IP)
// -----------------------------------------------------------------------------
console.log('\n--- 2. Registration Rate Limiting (POST /api/v1/auth/register) ---');

// Requests 1 through 3 should pass through the rate limiter (e.g. 422 validation error, not 429)
for (let i = 1; i <= 3; i++) {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 'test@example.com' });

  assert(
    res.status !== 429,
    `Registration request #${i} passes limiter (got HTTP ${res.status}, not 429)`
  );
}

// Request 4 must receive HTTP 429
const blockedRegRes = await request(app)
  .post('/api/v1/auth/register')
  .send({ email: 'test@example.com' });

assert(
  blockedRegRes.status === 429,
  `Registration request #4 is blocked with HTTP 429 (got ${blockedRegRes.status})`
);
assert(
  blockedRegRes.body?.error?.code === 'TOO_MANY_REQUESTS',
  `Registration blocked response code is "TOO_MANY_REQUESTS"`
);
assert(
  Number(blockedRegRes.headers['retry-after']) > 0,
  `Registration provides Retry-After header: ${blockedRegRes.headers['retry-after']}s`
);

// -----------------------------------------------------------------------------
// Test Suite 3: Independent IP Tracking
// -----------------------------------------------------------------------------
console.log('\n--- 3. Independent Tracking Across Different IPs ---');

// With a custom keyGenerator or custom limiter, different IPs have distinct buckets
const customIpLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 2,
  keyGenerator: (req) => req.headers['x-simulated-ip'] || req.ip || '127.0.0.1',
});

const mockReqA = { headers: { 'x-simulated-ip': '198.51.100.1' } };
const mockReqB = { headers: { 'x-simulated-ip': '198.51.100.2' } };
let resStatusA = 200;
let resStatusB = 200;
const mockRes = (setter) => ({
  setHeader: () => {},
  status: (s) => {
    setter(s);
    return { json: () => {} };
  },
});

// Send 2 requests from IP A
customIpLimiter(mockReqA, mockRes((s) => (resStatusA = s)), () => {});
customIpLimiter(mockReqA, mockRes((s) => (resStatusA = s)), () => {});
assert(resStatusA === 200, 'IP A first 2 requests succeed');

// 3rd request from IP A is blocked (HTTP 429)
customIpLimiter(mockReqA, mockRes((s) => (resStatusA = s)), () => {});
assert(resStatusA === 429, 'IP A 3rd request is blocked with HTTP 429');

// Meanwhile, IP B has its own bucket and is NOT blocked
customIpLimiter(mockReqB, mockRes((s) => (resStatusB = s)), () => {});
assert(resStatusB === 200, 'IP B is tracked independently and not blocked by IP A traffic');

// -----------------------------------------------------------------------------
// Test Suite 4: Unrelated Endpoints Not Rate-Limited
// -----------------------------------------------------------------------------
console.log('\n--- 4. Unrelated Endpoints (GET /api/v1/health) Not Rate-Limited ---');

for (let i = 1; i <= 10; i++) {
  const res = await request(app).get('/api/v1/health');
  assert(res.status === 200, `Health check request #${i} returns HTTP 200`);
}

// -----------------------------------------------------------------------------
// Test Suite 5: Unit Testing Injectable Clock & Window Reset
// -----------------------------------------------------------------------------
console.log('\n--- 5. Injectable Clock & Window Reset ---');

let simulatedTime = 1000000;
const testClockLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 60s
  max: 2,
  getTime: () => simulatedTime,
});

let status = 200;
const testRes = {
  setHeader: () => {},
  status: (s) => {
    status = s;
    return { json: () => {} };
  },
};
const dummyReq = { ip: '10.0.0.1', headers: {} };

// Req 1 & 2 pass
testClockLimiter(dummyReq, testRes, () => {});
testClockLimiter(dummyReq, testRes, () => {});
assert(status === 200, 'Requests 1 and 2 within window are allowed');

// Req 3 blocked
testClockLimiter(dummyReq, testRes, () => {});
assert(status === 429, 'Request 3 within same window is blocked (429)');

// Fast-forward simulated clock by 61 seconds
simulatedTime += 61 * 1000;
status = 200;

// Req 4 in new window passes!
testClockLimiter(dummyReq, testRes, () => {});
assert(status === 200, 'Request after window expiration starts new window and passes (HTTP 200)');

// -----------------------------------------------------------------------------
// Test Suite 6: Bounded Store Capacity & Eviction
// -----------------------------------------------------------------------------
console.log('\n--- 6. Bounded Store & Eviction (Memory Safety) ---');

const boundedLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  maxEntries: 3, // strict cap
  keyGenerator: (req) => req.headers['x-client-id'],
});

boundedLimiter({ headers: { 'x-client-id': 'client-1' } }, testRes, () => {});
boundedLimiter({ headers: { 'x-client-id': 'client-2' } }, testRes, () => {});
boundedLimiter({ headers: { 'x-client-id': 'client-3' } }, testRes, () => {});
assert(boundedLimiter.size() === 3, 'Store holds 3 entries');

// 4th distinct client triggers eviction, keeping size <= maxEntries
boundedLimiter({ headers: { 'x-client-id': 'client-4' } }, testRes, () => {});
assert(boundedLimiter.size() <= 3, `Store remains bounded: current size ${boundedLimiter.size()} <= 3`);

// Reset test limiters
loginRateLimiter.reset();
registerRateLimiter.reset();

console.log('\n========================================================================');
console.log(`SEC-03 RATE LIMITING TEST SUITE: ${passedTests}/${totalTests} PASSED`);
console.log('========================================================================\n');

if (passedTests === totalTests) {
  process.exit(0);
} else {
  process.exit(1);
}

