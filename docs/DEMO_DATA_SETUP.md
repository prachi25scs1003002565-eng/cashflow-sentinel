# Cashflow Sentinel — Local Demo Data Setup & Verification Guide

This guide describes how to initialize, test, and safely reset the dedicated demo environment in **Cashflow Sentinel**.

The demo account provisions realistic historical transaction data meeting all forecasting data sufficiency thresholds ($\ge 14$ calendar days, $\ge 7$ distinct active days, $\ge 7$ transactions), allowing immediate evaluation of real AI forecasting and interactive What-If simulations without waiting 14 real-time days.

---

## 1. Demo Credentials & Account Details

| Attribute | Value |
|---|---|
| **Login Email** | `demo.merchant@cashflowsentinel.local` |
| **Password** | `DemoPassword123!` |
| **Business Name** | `Shree Balaji Traders (Demo)` |
| **Business ID** | `b0000000-0000-4000-8000-000000000001` |
| **User ID** | `a0000000-0000-4000-8000-000000000001` |
| **Minimum Cash Buffer** | ₹25,000 (`2500000` paise) |
| **Default Currency** | INR (₹) |

---

## 2. Seed Script Execution

To provision or refresh the demo data, execute:

```bash
# From workspace root
npm run seed:demo

# Or from backend directory
npm --prefix backend run seed:demo
# Or directly with Node
node backend/scripts/seed-demo-account.mjs
```

### What the Seed Script Provisions:
1. **Isolated Business & User**: Creates/updates the dedicated demo tenant and user with bcrypt-hashed password credentials.
2. **Accounts & Data Sources**: Provisions a Primary HDFC Business Current Account (`₹75,000` opening balance), a Petty Cash Drawer (`₹15,000` opening balance), and Manual Entry / CSV data sources.
3. **Categories**: Sets up 8 compliant financial categories (`SALES_RETAIL`, `SALES_BULK`, `SERVICES_INCOME`, `RENT_OFFICE`, `SALARIES_STAFF`, `UTILITIES_POWER`, `RAW_MATERIALS`, `TRANSPORT_FREIGHT`) matching database direction constraints.
4. **36 Historical Transactions**: Dynamically dates 36 realistic transactions across the last **35 calendar days ending today**, satisfying:
   - Calendar days coverage: 35 days ($\ge 14$ required)
   - Distinct active days: 35 days ($\ge 7$ required)
   - Transaction count: 36 ($\ge 7$ required)
   - Category direction integrity: 100% compliant with PostgreSQL trigger `trg_check_transaction_category_direction`.
5. **Idempotence**: Uses `ON CONFLICT (id) DO UPDATE` to ensure safe, repeatable re-runs.

---

## 3. Safety Guarantees & Isolation

- **Target Database Assertion**: The script explicitly inspects `process.env.DB_NAME` / config and enforces that the target database is `cashflow_sentinel_migration_test`. It aborts immediately if pointed to any protected database (such as `cashflow_sentinel`).
- **Tenant Isolation**: All seeded entities use hardcoded demo UUIDs (`b0000000-...` and `a0000000-...`). No real user records, tenant memberships, or financial accounts are modified.
- **Ledger Immutability**: What-If simulations are purely analytical and never persist hypothetical rows into the `transactions` table.

---

## 4. Reset Script Execution

To safely purge the demo account and all associated test forecast runs without touching any other tenant:

```bash
# From workspace root
npm run reset:demo

# Or from backend directory
npm --prefix backend run reset:demo
# Or directly with Node
node backend/scripts/reset-demo-account.mjs
```

The reset script removes only records tagged with the demo business ID (`b0000000-0000-4000-8000-000000000001`) and the demo user email.

---

## 5. Generating Forecasts & Testing What-If Simulations

### A. Via the Frontend Application
1. Start the services:
   - Frontend: `http://localhost:3000`
   - Backend: `http://localhost:5000`
   - Python AI Engine: `http://127.0.0.1:8000`
2. Log in using `demo.merchant@cashflowsentinel.local` / `DemoPassword123!`.
3. The dashboard detects 35 days of historical data and displays **"Generate Forecast"** (or displays the active forecast).
4. Click **"Run What-If Simulation"** to launch the interactive simulator modal.
5. Test scenarios:
   - **Delayed Receipt**: Shift a ₹12,000 receivable by 5 days.
   - **Earlier Receipt**: Accelerate an incoming invoice by 5 days.
   - **New Purchase**: Simulate a ₹100,000 capital expense to observe early warning cash-buffer breach detection.
   - **Expense Change**: Increase monthly utility expenses by ₹2,500.
   - **Manual Cash Movement**: Simulate an equity injection of ₹10,000.

### B. Via Backend REST API
```bash
# 1. Login
curl -X POST http://localhost:5000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo.merchant@cashflowsentinel.local","password":"DemoPassword123!"}'

# 2. Generate Real Forecast
curl -X POST http://localhost:5000/api/v1/forecasts/generate \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"horizon_days":30}'

# 3. Run What-If Simulation
curl -X POST http://localhost:5000/api/v1/forecasts/simulate \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "scenario_type": "NEW_PURCHASE",
    "amount": 100000,
    "date": "2026-11-23",
    "description": "Commercial delivery van purchase"
  }'
```

---

## 6. Automated Verification Test Suite

A comprehensive 44-assertion verification suite is available at `backend/tests/demo-data-verification.test.mjs`:

```bash
node backend/tests/demo-data-verification.test.mjs
```

### Coverage:
- Target database safety check
- Complete seed script execution
- PostgreSQL data integrity (36 transactions, 35 calendar days, trigger compliance)
- Demo account authentication (JWT issuance)
- Transaction summaries calculation
- Real forecast generation (Node.js -> Python AI Engine -> PostgreSQL persistence)
- All 5 What-If scenario simulations (delta calculation and cash buffer breach alerts)
- Ledger immutability (transaction count remains strictly 36)
- Multi-tenant isolation (outside users cannot inspect demo forecasts)
