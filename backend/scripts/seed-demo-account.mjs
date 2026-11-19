import dotenv from 'dotenv';
import { Pool } from 'pg';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment configuration
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DEFAULT_TARGET_DB = 'cashflow_sentinel_migration_test';
const PROTECTED_DB = 'cashflow_sentinel';

if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'CRITICAL SECURITY VIOLATION: Demo data operations are forbidden in production (NODE_ENV=production)!'
  );
}

// Allow target database to be configured via DEMO_TARGET_DB ONLY IF ALLOW_DEMO_SEED=true
let TARGET_DB = DEFAULT_TARGET_DB;
if (process.env.DEMO_TARGET_DB) {
  if (process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      'CRITICAL SECURITY VIOLATION: DEMO_TARGET_DB is set but ALLOW_DEMO_SEED is not "true". Demo seeding blocked.'
    );
  }
  TARGET_DB = process.env.DEMO_TARGET_DB;
}

function assertSafety(dbName) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CRITICAL SECURITY VIOLATION: Demo data operations are forbidden in production (NODE_ENV=production)!'
    );
  }
  if (dbName.toLowerCase().includes('prod')) {
    throw new Error(
      `CRITICAL SECURITY VIOLATION: Target database "${dbName}" contains "prod" or "production"! Demo operations are forbidden.`
    );
  }
  if (dbName === PROTECTED_DB) {
    throw new Error(
      `CRITICAL SECURITY VIOLATION: Attempted access to protected database "${PROTECTED_DB}"! Halting immediately.`
    );
  }
  if (dbName !== TARGET_DB) {
    throw new Error(
      `CRITICAL SECURITY VIOLATION: Target database "${dbName}" is not the approved target database "${TARGET_DB}"! Halting immediately.`
    );
  }
}

// Deterministic UUIDs for demo entity isolation
export const DEMO_IDS = {
  USER_ID: 'a0000000-0000-4000-8000-000000000001',
  BUSINESS_ID: 'b0000000-0000-4000-8000-000000000001',
  MEMBERSHIP_ID: 'c0000000-0000-4000-8000-000000000001',
  BANK_ACCOUNT_ID: 'd0000000-0000-4000-8000-000000000001',
  CASH_ACCOUNT_ID: 'd0000000-0000-4000-8000-000000000002',
  DATA_SOURCE_MANUAL_ID: 'e0000000-0000-4000-8000-000000000001',
  DATA_SOURCE_CSV_ID: 'e0000000-0000-4000-8000-000000000002',
  CATEGORIES: {
    SALES: 'f0000000-0000-4000-8000-000000000001',
    OTHER_INFLOW: 'f0000000-0000-4000-8000-000000000002',
    INVENTORY: 'f0000000-0000-4000-8000-000000000003',
    RENT: 'f0000000-0000-4000-8000-000000000004',
    UTILITIES: 'f0000000-0000-4000-8000-000000000005',
    SALARY: 'f0000000-0000-4000-8000-000000000006',
    LOGISTICS: 'f0000000-0000-4000-8000-000000000007',
    OTHER_OUTFLOW: 'f0000000-0000-4000-8000-000000000008',
  },
};

export const DEMO_CREDENTIALS = {
  email: process.env.DEMO_USER_EMAIL || 'demo.merchant@cashflowsentinel.local',
  password: process.env.DEMO_USER_PASSWORD || 'DemoPassword123!',
  displayName: 'Demo Merchant (Kirana)',
  businessName: 'Shree Balaji Traders (Demo)',
  operatingBufferRupees: 25000,
  operatingBufferPaise: '2500000',
};

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function subDays(baseDate, days) {
  const dt = new Date(baseDate);
  dt.setDate(dt.getDate() - days);
  return dt;
}

export async function seedDemoAccount(targetPool = null) {
  const pool =
    targetPool ||
    new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: TARGET_DB,
    });

  // 1. Verify safety against protected DB
  const safetyRes = await pool.query('SELECT current_database() as db');
  const currentDb = safetyRes.rows[0].db;
  assertSafety(currentDb);
  console.log(`[SAFETY CHECK PASSED] Seeding demo account into "${currentDb}"`);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 2. Upsert Demo User
    const passwordHash = await bcrypt.hash(DEMO_CREDENTIALS.password, 10);
    await client.query(
      `INSERT INTO users (id, email, password_hash, display_name, account_status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         display_name = EXCLUDED.display_name,
         account_status = 'ACTIVE',
         updated_at = now()`,
      [
        DEMO_IDS.USER_ID,
        DEMO_CREDENTIALS.email,
        passwordHash,
        DEMO_CREDENTIALS.displayName,
      ]
    );

    // 3. Upsert Demo Business
    await client.query(
      `INSERT INTO businesses (
         id, name, business_type, city, currency_code, timezone, minimum_cash_buffer_paise, business_status
       )
       VALUES ($1, $2, 'KIRANA', 'Pune', 'INR', 'Asia/Kolkata', $3, 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         business_type = EXCLUDED.business_type,
         city = EXCLUDED.city,
         currency_code = EXCLUDED.currency_code,
         timezone = EXCLUDED.timezone,
         minimum_cash_buffer_paise = EXCLUDED.minimum_cash_buffer_paise,
         business_status = 'ACTIVE',
         updated_at = now()`,
      [
        DEMO_IDS.BUSINESS_ID,
        DEMO_CREDENTIALS.businessName,
        DEMO_CREDENTIALS.operatingBufferPaise,
      ]
    );

    // 4. Upsert Business Membership (OWNER)
    await client.query(
      `INSERT INTO business_memberships (id, business_id, user_id, role, membership_status)
       VALUES ($1, $2, $3, 'OWNER', 'ACTIVE')
       ON CONFLICT (business_id, user_id) DO UPDATE SET
         role = 'OWNER',
         membership_status = 'ACTIVE',
         updated_at = now()`,
      [DEMO_IDS.MEMBERSHIP_ID, DEMO_IDS.BUSINESS_ID, DEMO_IDS.USER_ID]
    );

    // 5. Upsert Accounts
    await client.query(
      `INSERT INTO accounts (id, business_id, account_type, display_name, institution_name, currency_code, is_active)
       VALUES
         ($1, $2, 'BANK', 'Current Account (HDFC Bank Demo)', 'HDFC Bank', 'INR', true),
         ($3, $2, 'CASH', 'Shop Cash Drawer (Demo)', NULL, 'INR', true)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         institution_name = EXCLUDED.institution_name,
         is_active = true,
         updated_at = now()`,
      [
        DEMO_IDS.BANK_ACCOUNT_ID,
        DEMO_IDS.BUSINESS_ID,
        DEMO_IDS.CASH_ACCOUNT_ID,
      ]
    );

    // 6. Upsert Data Sources
    await client.query(
      `INSERT INTO data_sources (id, business_id, source_type, display_name, source_status)
       VALUES
         ($1, $2, 'MANUAL', 'Owner Direct Entry', 'ACTIVE'),
         ($3, $2, 'CSV', 'Bank Statement Upload', 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET
         source_status = 'ACTIVE',
         updated_at = now()`,
      [
        DEMO_IDS.DATA_SOURCE_MANUAL_ID,
        DEMO_IDS.BUSINESS_ID,
        DEMO_IDS.DATA_SOURCE_CSV_ID,
      ]
    );

    // 7. Upsert Categories
    const categories = [
      { id: DEMO_IDS.CATEGORIES.SALES, code: 'SALES', name: 'Daily Retail & UPI Sales', dir: 'INFLOW' },
      { id: DEMO_IDS.CATEGORIES.OTHER_INFLOW, code: 'OTHER_INFLOW', name: 'Wholesale Client Inflow', dir: 'INFLOW' },
      { id: DEMO_IDS.CATEGORIES.INVENTORY, code: 'INVENTORY', name: 'Stock & Supplier Purchases', dir: 'OUTFLOW' },
      { id: DEMO_IDS.CATEGORIES.RENT, code: 'RENT', name: 'Shop Rent', dir: 'OUTFLOW' },
      { id: DEMO_IDS.CATEGORIES.UTILITIES, code: 'UTILITIES', name: 'Electricity, Water & Internet', dir: 'OUTFLOW' },
      { id: DEMO_IDS.CATEGORIES.SALARY, code: 'SALARY', name: 'Staff & Helper Wages', dir: 'OUTFLOW' },
      { id: DEMO_IDS.CATEGORIES.LOGISTICS, code: 'LOGISTICS', name: 'Transportation & Delivery', dir: 'OUTFLOW' },
      { id: DEMO_IDS.CATEGORIES.OTHER_OUTFLOW, code: 'OTHER_OUTFLOW', name: 'General Operational Expense', dir: 'OUTFLOW' },
    ];

    for (const c of categories) {
      await client.query(
        `INSERT INTO transaction_categories (id, business_id, category_code, display_name, allowed_direction, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (business_id, category_code) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           allowed_direction = EXCLUDED.allowed_direction,
           is_active = true,
           updated_at = now()`,
        [c.id, DEMO_IDS.BUSINESS_ID, c.code, c.name, c.dir]
      );
    }

    // 8. Generate 35 Days of Realistic Dynamic Historical Transactions
    // Calculate dates relative to today
    const now = new Date();
    const todayStr = toIsoDate(now);

    const transactionTemplates = [
      // Day -35
      { daysAgo: 35, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 1250000, desc: 'UPI and Cash Counter Sales', party: 'Retail Walk-in Customers' },
      // Day -34
      { daysAgo: 34, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 840000, desc: 'Daily Counter Collection', party: 'Retail Walk-in Customers' },
      // Day -33
      { daysAgo: 33, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'INVENTORY', amt: 1820000, desc: 'Grain & pulses bulk purchase', party: 'Deccan Wholesale Distributors' },
      // Day -32
      { daysAgo: 32, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 985000, desc: 'Daily retail receipts & QR payments', party: 'Retail Walk-in Customers' },
      // Day -31
      { daysAgo: 31, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 720000, desc: 'Evening retail sales batch', party: 'Retail Walk-in Customers' },
      // Day -30
      { daysAgo: 30, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'RENT', amt: 1500000, desc: 'Monthly shop premise rent', party: 'Kothrud Commercial Complex' },
      // Day -29
      { daysAgo: 29, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'UTILITIES', amt: 365000, desc: 'Monthly commercial electricity bill', party: 'MSEDCL Power' },
      // Day -28
      { daysAgo: 28, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 1120000, desc: 'Weekend retail rush receipts', party: 'Retail Walk-in Customers' },
      // Day -27
      { daysAgo: 27, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 1045000, desc: 'Daily counter receipts', party: 'Retail Walk-in Customers' },
      // Day -26
      { daysAgo: 26, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'INVENTORY', amt: 1480000, desc: 'Edible oils and ghee restock', party: 'Patil Agro Supplies' },
      // Day -25
      { daysAgo: 25, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 760000, desc: 'Daily retail receipts', party: 'Retail Walk-in Customers' },
      // Day -24
      { daysAgo: 24, dir: 'INFLOW', type: 'INFLOW', cat: 'OTHER_INFLOW', amt: 1400000, desc: 'Bulk party order settlement', party: 'Kothrud Caterers' },
      // Day -23
      { daysAgo: 23, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'LOGISTICS', amt: 240000, desc: 'Tempo transport freight charges', party: 'Pune Local Freight' },
      // Day -22
      { daysAgo: 22, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 1050000, desc: 'Daily retail receipts', party: 'Retail Walk-in Customers' },
      // Day -21
      { daysAgo: 21, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 910000, desc: 'UPI and cash receipts', party: 'Retail Walk-in Customers' },
      // Day -20
      { daysAgo: 20, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'INVENTORY', amt: 1650000, desc: 'Spices and packaged food restocking', party: 'Deccan Wholesale Distributors' },
      // Day -19
      { daysAgo: 19, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'SALARY', amt: 1200000, desc: 'Monthly staff helper wages', party: 'Ramesh Helper & Staff' },
      // Day -18
      { daysAgo: 18, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 920000, desc: 'Daily sales & UPI QR settlement', party: 'Retail Walk-in Customers' },
      // Day -17
      { daysAgo: 17, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 810000, desc: 'Daily retail collection', party: 'Retail Walk-in Customers' },
      // Day -16
      { daysAgo: 16, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'OTHER_OUTFLOW', amt: 185000, desc: 'Packaging paper bags and carton rolls', party: 'Swastik Packaging' },
      // Day -15
      { daysAgo: 15, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 1340000, desc: 'Festive weekend sales rush', party: 'Retail Walk-in Customers' },
      // Day -14
      { daysAgo: 14, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'INVENTORY', amt: 1920000, desc: 'Beverages and dairy inventory replenishment', party: 'Metro Cash & Carry' },
      // Day -13
      { daysAgo: 13, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 1180000, desc: 'Daily counter retail sales', party: 'Retail Walk-in Customers' },
      // Day -12
      { daysAgo: 12, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'OTHER_OUTFLOW', amt: 210000, desc: 'Pest control and store sanitization', party: 'City Pest Care' },
      // Day -11
      { daysAgo: 11, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 890000, desc: 'Daily retail sales & UPI receipts', party: 'Retail Walk-in Customers' },
      // Day -10
      { daysAgo: 10, dir: 'INFLOW', type: 'INFLOW', cat: 'OTHER_INFLOW', amt: 1600000, desc: 'Commercial restaurant supply invoice settlement', party: 'Shree Ram Sweet Mart' },
      // Day -9
      { daysAgo: 9, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'INVENTORY', amt: 1560000, desc: 'Sugar, tea and dry grocery restocking', party: 'Deccan Wholesale Distributors' },
      // Day -8
      { daysAgo: 8, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 1025000, desc: 'Daily counter sales', party: 'Retail Walk-in Customers' },
      // Day -7
      { daysAgo: 7, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 1210000, desc: 'Weekly counter collection', party: 'Retail Walk-in Customers' },
      // Day -6
      { daysAgo: 6, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'UTILITIES', amt: 390000, desc: 'Fiber internet and software billing', party: 'Airtel & Billing POS' },
      // Day -5
      { daysAgo: 5, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 975000, desc: 'Daily retail collection', party: 'Retail Walk-in Customers' },
      // Day -4
      { daysAgo: 4, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'INVENTORY', amt: 1350000, desc: 'Packaged snack goods & biscuits restock', party: 'Patil Agro Supplies' },
      // Day -3
      { daysAgo: 3, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 1140000, desc: 'Daily retail counter sales', party: 'Retail Walk-in Customers' },
      // Day -2
      { daysAgo: 2, dir: 'OUTFLOW', type: 'OUTFLOW', cat: 'LOGISTICS', amt: 165000, desc: 'Store local delivery tempo expenses', party: 'Quick Delivery Express' },
      // Day -1
      { daysAgo: 1, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 1480000, desc: 'Pre-weekend sales receipts', party: 'Retail Walk-in Customers' },
      // Day 0 (Today)
      { daysAgo: 0, dir: 'INFLOW', type: 'INFLOW', cat: 'SALES', amt: 850000, desc: 'Morning retail counter cash & UPI', party: 'Retail Walk-in Customers' },
    ];

    let seededCount = 0;
    for (let idx = 0; idx < transactionTemplates.length; idx++) {
      const t = transactionTemplates[idx];
      const txDate = toIsoDate(subDays(now, t.daysAgo));
      const txId = `11111111-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`;
      const categoryId = DEMO_IDS.CATEGORIES[t.cat];
      const accountId = t.dir === 'INFLOW' ? DEMO_IDS.BANK_ACCOUNT_ID : DEMO_IDS.BANK_ACCOUNT_ID;

      await client.query(
        `INSERT INTO transactions (
           id, business_id, account_id, category_id, data_source_id,
           transaction_date, occurred_at, transaction_type, cash_direction,
           amount_paise, description, counterparty_name, record_status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'POSTED')
         ON CONFLICT (id) DO UPDATE SET
           transaction_date = EXCLUDED.transaction_date,
           occurred_at = EXCLUDED.occurred_at,
           amount_paise = EXCLUDED.amount_paise,
           description = EXCLUDED.description,
           counterparty_name = EXCLUDED.counterparty_name,
           record_status = 'POSTED',
           updated_at = now()`,
        [
          txId,
          DEMO_IDS.BUSINESS_ID,
          accountId,
          categoryId,
          DEMO_IDS.DATA_SOURCE_MANUAL_ID,
          txDate,
          `${txDate}T12:00:00Z`,
          t.type,
          t.dir,
          t.amt,
          t.desc,
          t.party,
        ]
      );
      seededCount++;
    }

    await client.query('COMMIT');
    console.log(`[SUCCESS] Seeded/updated ${seededCount} realistic transactions spanning 35 days for demo account.`);

    return {
      success: true,
      businessId: DEMO_IDS.BUSINESS_ID,
      userId: DEMO_IDS.USER_ID,
      email: DEMO_CREDENTIALS.email,
      password: DEMO_CREDENTIALS.password,
      transactionCount: seededCount,
      asOfDate: todayStr,
      bufferPaise: DEMO_CREDENTIALS.operatingBufferPaise,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SEEDING FAILED]:', err);
    throw err;
  } finally {
    client.release();
    if (!targetPool) {
      await pool.end();
    }
  }
}

// Allow direct execution from CLI
if (process.argv[1] && process.argv[1].endsWith('seed-demo-account.mjs')) {
  seedDemoAccount()
    .then((res) => {
      console.log('\n======================================================');
      console.log('DEMO ACCOUNT SEEDING COMPLETE');
      console.log('======================================================');
      console.log(`Email:        ${res.email}`);
      console.log(`Password:     ${res.password}`);
      console.log(`Business ID:  ${res.businessId}`);
      console.log(`Transactions: ${res.transactionCount} transactions (35 days of history)`);
      console.log(`As-Of-Date:   ${res.asOfDate}`);
      console.log('======================================================\n');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed execution aborted:', err);
      process.exit(1);
    });
}
