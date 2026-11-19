import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const JWT_SECRET = process.env.JWT_SECRET;
const API_BASE = 'http://localhost:5000/api/v1';

console.log('========================================================================');
console.log('CASHFLOW SENTINEL — PHASE 1 AUTH SECURITY REMEDIATION TEST SUITE');
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

// -----------------------------------------------------------------------------
// Test 1: Normal Login Works and Issues Valid HS256 JWT
// -----------------------------------------------------------------------------
console.log('--- Test 1: Normal Login & HS256 Token Issuance ---');
const loginRes = await fetch(`${API_BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'demo.merchant@cashflowsentinel.local',
    password: 'DemoPassword123!',
  }),
});

assert(loginRes.status === 200, 'Normal login returns HTTP 200');
const loginData = await loginRes.json();
const validToken = loginData.data?.access_token;
assert(typeof validToken === 'string' && validToken.length > 20, 'Received valid token string');

// Inspect JWT header
const tokenHeaderB64 = validToken.split('.')[0];
const tokenHeader = JSON.parse(Buffer.from(tokenHeaderB64, 'base64url').toString('utf8'));
assert(tokenHeader.alg === 'HS256', `Token header explicitly specifies alg === 'HS256' (got: ${tokenHeader.alg})`);

// -----------------------------------------------------------------------------
// Test 2: Valid HS256 Token Passes Backend Verification
// -----------------------------------------------------------------------------
console.log('\n--- Test 2: Valid HS256 Token Verification ---');
const meRes = await fetch(`${API_BASE}/auth/me`, {
  headers: { Authorization: `Bearer ${validToken}` },
});
assert(meRes.status === 200, 'GET /auth/me returns HTTP 200 with valid HS256 token');
const meData = await meRes.json();
assert(meData.data?.email === 'demo.merchant@cashflowsentinel.local', 'Profile returned for correct authenticated user');

const txRes = await fetch(`${API_BASE}/transactions?limit=1`, {
  headers: { Authorization: `Bearer ${validToken}` },
});
assert(txRes.status === 200, 'GET /transactions returns HTTP 200 with valid HS256 token');

// -----------------------------------------------------------------------------
// Test 3: Mismatched Algorithm Tokens Must Be Rejected
// -----------------------------------------------------------------------------
console.log('\n--- Test 3: Algorithm Pinning Enforcement (Mismatched Algorithms) ---');

// 3a: 'none' algorithm token
const noneTokenHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
const noneTokenPayload = Buffer.from(JSON.stringify({ sub: meData.data.id, email: meData.data.email })).toString('base64url');
const noneToken = `${noneTokenHeader}.${noneTokenPayload}.`;

const noneRes = await fetch(`${API_BASE}/auth/me`, {
  headers: { Authorization: `Bearer ${noneToken}` },
});
assert(noneRes.status === 401, `Token with alg: "none" is strictly rejected with HTTP 401 (got ${noneRes.status})`);

// 3b: 'HS384' algorithm token (signed with same secret but different algorithm)
const hs384Token = jwt.sign(
  { sub: meData.data.id, email: meData.data.email },
  JWT_SECRET,
  { algorithm: 'HS384', expiresIn: 900 }
);
const hs384Res = await fetch(`${API_BASE}/auth/me`, {
  headers: { Authorization: `Bearer ${hs384Token}` },
});
assert(hs384Res.status === 401, `Token with alg: "HS384" is strictly rejected with HTTP 401 (got ${hs384Res.status})`);

// 3c: 'HS512' algorithm token
const hs512Token = jwt.sign(
  { sub: meData.data.id, email: meData.data.email },
  JWT_SECRET,
  { algorithm: 'HS512', expiresIn: 900 }
);
const hs512Res = await fetch(`${API_BASE}/auth/me`, {
  headers: { Authorization: `Bearer ${hs512Token}` },
});
assert(hs512Res.status === 401, `Token with alg: "HS512" is strictly rejected with HTTP 401 (got ${hs512Res.status})`);

// -----------------------------------------------------------------------------
// Test 4: Tampered Signature Rejection
// -----------------------------------------------------------------------------
console.log('\n--- Test 4: Tampered Signature Rejection ---');
const tamperedToken = validToken.slice(0, -6) + 'abcdef';
const tamperedRes = await fetch(`${API_BASE}/auth/me`, {
  headers: { Authorization: `Bearer ${tamperedToken}` },
});
assert(tamperedRes.status === 401, 'Token with tampered signature is rejected with HTTP 401');

// -----------------------------------------------------------------------------
// Test 5: Expired Token Rejection
// -----------------------------------------------------------------------------
console.log('\n--- Test 5: Expired Token Rejection ---');
const expiredToken = jwt.sign(
  { sub: meData.data.id, email: meData.data.email },
  JWT_SECRET,
  { algorithm: 'HS256', expiresIn: -10 } // expired 10 seconds ago
);

const expiredRes = await fetch(`${API_BASE}/auth/me`, {
  headers: { Authorization: `Bearer ${expiredToken}` },
});
assert(expiredRes.status === 401, 'Expired token is rejected with HTTP 401');
const expiredData = await expiredRes.json();
assert(expiredData.error?.code === 'TOKEN_EXPIRED', 'Expired token returns specific error code TOKEN_EXPIRED');

// -----------------------------------------------------------------------------
// Test 6: Fake URL Query Parameter Cannot Authenticate
// -----------------------------------------------------------------------------
console.log('\n--- Test 6: URL Query Parameter Token Invalidation ---');
const fakeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXVzZXItaWQiLCJlbWFpbCI6ImF0dGFja2VyQGV4YW1wbGUuY29tIn0.fakesignature';
const fakeRes = await fetch(`${API_BASE}/auth/me`, {
  headers: { Authorization: `Bearer ${fakeToken}` },
});
assert(fakeRes.status === 401, 'Arbitrary fake token is rejected with HTTP 401');

// -----------------------------------------------------------------------------
// Test 7: Static Inspection of Frontend App.tsx
// -----------------------------------------------------------------------------
console.log('\n--- Test 7: Frontend Source Code Inspection (SEC-01 & SEC-02) ---');
const appTsxPath = path.resolve(__dirname, '../../frontend/src/App.tsx');
const appTsxContent = fs.readFileSync(appTsxPath, 'utf8');

assert(!appTsxContent.includes('urlToken'), 'App.tsx contains NO urlToken reference');
assert(!appTsxContent.includes('location.search'), 'App.tsx does NOT inspect window.location.search');
assert(!appTsxContent.includes('atob('), 'App.tsx contains NO unverified atob() decoding');
assert(!appTsxContent.includes('parts[1]'), 'App.tsx contains NO token splitting or payload decoding');
assert(appTsxContent.includes('await logout()'), 'App.tsx clears session via logout() on verification failure');
assert(appTsxContent.includes('active && getAccessToken() === token'), 'App.tsx requires both active and getAccessToken() === token before setting user');
assert(appTsxContent.includes('if (getAccessToken() === token)'), 'App.tsx ensures failed session restore only calls logout() if current token matches original token');

// -----------------------------------------------------------------------------
// Test 8: Static Inspection of Backend AuthService & Auth Middleware (SEC-06)
// -----------------------------------------------------------------------------
console.log('\n--- Test 8: Backend Source Code Inspection (SEC-06) ---');
const authServicePath = path.resolve(__dirname, '../src/modules/auth/auth.service.ts');
const authServiceContent = fs.readFileSync(authServicePath, 'utf8');
assert(authServiceContent.includes("algorithm: 'HS256'"), "auth.service.ts explicitly specifies algorithm: 'HS256' in jwt.sign");

const authMiddlewarePath = path.resolve(__dirname, '../src/middleware/auth.ts');
const authMiddlewareContent = fs.readFileSync(authMiddlewarePath, 'utf8');
assert(authMiddlewareContent.includes("algorithms: ['HS256']"), "auth.ts explicitly specifies algorithms: ['HS256'] in jwt.verify");

console.log('\n========================================================================');
console.log(`AUTH SECURITY REMEDIATION TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
console.log('========================================================================\n');

if (passedTests === totalTests) {
  process.exit(0);
} else {
  process.exit(1);
}
