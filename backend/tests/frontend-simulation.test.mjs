import dotenv from 'dotenv';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
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

console.log(`\n========================================`);
console.log(`CASHFLOW SENTINEL - PHASE 3 FRONTEND SIMULATOR VERIFICATION`);
console.log(`========================================\n`);

// 1. Verify frontend files exist
console.log(`--- Step 1: File Structure Verification ---`);
const simServicePath = path.resolve(__dirname, '../../frontend/src/services/simulation.ts');
assert(fs.existsSync(simServicePath), 'frontend/src/services/simulation.ts exists');

const simComponentPath = path.resolve(__dirname, '../../frontend/src/components/simulator/WhatIfSimulator.tsx');
assert(fs.existsSync(simComponentPath), 'frontend/src/components/simulator/WhatIfSimulator.tsx exists');

const forecastServicePath = path.resolve(__dirname, '../../frontend/src/services/forecast.ts');
assert(fs.existsSync(forecastServicePath), 'frontend/src/services/forecast.ts exists');

const dashboardPath = path.resolve(__dirname, '../../frontend/src/pages/DashboardPage.tsx');
assert(fs.existsSync(dashboardPath), 'frontend/src/pages/DashboardPage.tsx exists');

// 2. Verify content in simulation.ts
console.log(`\n--- Step 2: API Service Interface Verification ---`);
const simContent = fs.readFileSync(simServicePath, 'utf-8');
assert(simContent.includes('export async function simulateForecast'), 'Exports simulateForecast function');
assert(simContent.includes('export type ScenarioType ='), 'Exports ScenarioType union');
assert(simContent.includes('DELAYED_RECEIPT'), 'Supports DELAYED_RECEIPT');
assert(simContent.includes('EARLIER_RECEIPT'), 'Supports EARLIER_RECEIPT');
assert(simContent.includes('NEW_PURCHASE'), 'Supports NEW_PURCHASE');
assert(simContent.includes('EXPENSE_CHANGE'), 'Supports EXPENSE_CHANGE');
assert(simContent.includes('MANUAL_CASH_MOVEMENT'), 'Supports MANUAL_CASH_MOVEMENT');
assert(simContent.includes('POST'), 'Uses POST method');
assert(simContent.includes('/forecasts/simulate'), 'Points to /forecasts/simulate endpoint');

// 3. Verify forecast.ts re-exports
const forecastContent = fs.readFileSync(forecastServicePath, 'utf-8');
assert(forecastContent.includes("from './simulation'"), 'forecast.ts re-exports simulation service members');

// 4. Verify WhatIfSimulator.tsx component
console.log(`\n--- Step 3: WhatIfSimulator Component Verification ---`);
const compContent = fs.readFileSync(simComponentPath, 'utf-8');
assert(compContent.includes('export function WhatIfSimulator'), 'Exports WhatIfSimulator component');
assert(compContent.includes('DELAYED_RECEIPT'), 'Component handles DELAYED_RECEIPT');
assert(compContent.includes('EARLIER_RECEIPT'), 'Component handles EARLIER_RECEIPT');
assert(compContent.includes('NEW_PURCHASE'), 'Component handles NEW_PURCHASE');
assert(compContent.includes('EXPENSE_CHANGE'), 'Component handles EXPENSE_CHANGE');
assert(compContent.includes('MANUAL_CASH_MOVEMENT'), 'Component handles MANUAL_CASH_MOVEMENT');
assert(compContent.includes('AMOUNT_PRESETS'), 'Provides fast preset chips');
assert(compContent.includes('Comparative Trajectory Projection'), 'Renders comparative trajectory chart');
assert(compContent.includes('simulatedPath'), 'Renders simulated trajectory SVG path');
assert(compContent.includes('baselinePath'), 'Renders baseline forecast SVG path');
assert(compContent.includes('buffer_breached'), 'Handles cash buffer breach detection');

// 5. Verify DashboardPage.tsx integration
console.log(`\n--- Step 4: DashboardPage Integration Verification ---`);
const dashContent = fs.readFileSync(dashboardPath, 'utf-8');
assert(dashContent.includes('WhatIfSimulator'), 'DashboardPage imports WhatIfSimulator');
assert(dashContent.includes('<WhatIfSimulator'), 'DashboardPage renders WhatIfSimulator component');
assert(!dashContent.includes('Explore the simulator <ArrowRight'), 'Static simulator callout replaced cleanly');

// 6. Test real backend endpoint over HTTP on running server (port 5000)
console.log(`\n--- Step 5: End-to-End Live HTTP Simulation Test ---`);
const suffix = Date.now();
const regRes = await fetch('http://localhost:5000/api/v1/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: `sim_fe_${suffix}@test.local`,
    password: 'Password@123',
    display_name: 'FE Simulator Tester',
  }),
});
assert(regRes.status === 201, 'Registered test tenant on port 5000');
const regData = await regRes.json();
const token = regData.data.access_token;
const userId = regData.data.user.id;

// Initialize tenant context
await fetch('http://localhost:5000/api/v1/transactions/summary', {
  headers: { Authorization: `Bearer ${token}` },
});

const bizRes = await pool.query(
  `SELECT b.id FROM businesses b
   JOIN business_memberships bm ON bm.business_id = b.id
   WHERE bm.user_id = $1`,
  [userId]
);
const businessId = bizRes.rows[0]?.id;
assert(typeof businessId === 'string', 'Found business ID in database');

// Set minimum buffer to ₹20,000
await pool.query(
  `UPDATE businesses SET minimum_cash_buffer_paise = 2000000 WHERE id = $1`,
  [businessId]
);

// Fetch categories
const catRes = await fetch('http://localhost:5000/api/v1/transactions/categories', {
  headers: { Authorization: `Bearer ${token}` },
});
const catData = await catRes.json();
const catSales = catData.data.find(
  (c) => c.allowed_direction === 'INFLOW' || c.allowed_direction === 'BOTH'
);

// Seed 15 days of revenue
const dates = [
  '2026-11-01', '2026-11-03', '2026-11-05', '2026-11-07',
  '2026-11-09', '2026-11-11', '2026-11-13', '2026-11-15'
];
for (const d of dates) {
  const txRes = await fetch('http://localhost:5000/api/v1/transactions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: '5000.00',
      cash_direction: 'INFLOW',
      category_id: catSales.id,
      description: 'Daily shop sales',
      transaction_date: d,
    }),
  });
  assert(txRes.status === 201, `Seeded transaction for ${d}`);
}

// Generate baseline forecast
const genRes = await fetch('http://localhost:5000/api/v1/forecasts/generate', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ horizon_days: 30, as_of_date: '2026-11-16' }),
});
assert(genRes.status === 201, 'Baseline forecast generated on port 5000');
const genData = await genRes.json();
const baselineId = genData.data.run.id;
assert(typeof baselineId === 'string', 'Baseline forecast ID generated');

// Fire simulation exactly matching the frontend WhatIfSimulator payload
const simLiveRes = await fetch('http://localhost:5000/api/v1/forecasts/simulate', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    baseline_forecast_id: baselineId,
    scenario_type: 'NEW_PURCHASE',
    amount: 25000,
    date: '2026-11-20',
    description: 'Emergency HVAC overhaul',
  }),
});
assert(simLiveRes.status === 200, 'Frontend simulation payload executed with HTTP 200 on port 5000');
const simResult = await simLiveRes.json();
const simData = simResult.data;
assert(simData.baseline_forecast_id === baselineId, 'Result links to correct baseline ID');
assert(simData.scenario_type === 'NEW_PURCHASE', 'Scenario type is NEW_PURCHASE');
assert(simData.baseline_points.length === 30, 'Baseline points count is 30');
assert(simData.simulated_points.length === 30, 'Simulated points count is 30');
assert(simData.baseline_risk_status === 'PROTECTED', 'Baseline risk is PROTECTED');
assert(simData.simulated_risk_status === 'AT_RISK', 'Simulated risk is AT_RISK');
assert(simData.closing_balance_difference_rupees === -25000, 'Closing balance delta is -₹25,000');

await pool.end();

console.log(`\n========================================`);
console.log(`PHASE 3 FRONTEND SIMULATOR TEST SUMMARY`);
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
