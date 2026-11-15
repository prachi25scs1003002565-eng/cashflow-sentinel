-- Cashflow Sentinel — Demo Seed Dataset: Kavita's Kirana Store (Pune)
-- Realistic synthetic scenario matching Product Blueprint Use Case A & API Contract

-- 1. Create Demo User: Kavita (password: 'password123')
-- Bcrypt hash for 'password123': $2a$10$3euPcmQFCiblsZeEu5s7p.9OVv8s6E4bY10Qc/o5M2/4Fsz2oV4Xq
INSERT INTO users (id, email, password_hash, display_name, account_status)
VALUES (
    '20000000-0000-4000-8000-000000000001',
    'kavita@example.test',
    '$2a$10$3euPcmQFCiblsZeEu5s7p.9OVv8s6E4bY10Qc/o5M2/4Fsz2oV4Xq',
    'Kavita Patil',
    'ACTIVE'
) ON CONFLICT (id) DO NOTHING;

-- 2. Create Demo Business: Shree Laxmi Kirana
INSERT INTO businesses (id, name, business_type, city, currency_code, timezone, minimum_cash_buffer_paise, business_status)
VALUES (
    '10000000-0000-4000-8000-000000000001',
    'Shree Laxmi Kirana Store',
    'KIRANA',
    'Pune',
    'INR',
    'Asia/Kolkata',
    1500000, -- ₹15,000 operating buffer
    'ACTIVE'
) ON CONFLICT (id) DO NOTHING;

-- 3. Business Membership: Kavita as OWNER
INSERT INTO business_memberships (id, business_id, user_id, role, membership_status)
VALUES (
    '21000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'OWNER',
    'ACTIVE'
) ON CONFLICT (id) DO NOTHING;

-- 4. Accounts: Current Account & Shop Cash
INSERT INTO accounts (id, business_id, account_type, display_name, institution_name, currency_code, is_active)
VALUES 
(
    '50000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'BANK',
    'Current Account (Bank of Maharashtra)',
    'Bank of Maharashtra',
    'INR',
    true
),
(
    '50000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'CASH',
    'Shop Cash Drawer',
    NULL,
    'INR',
    true
) ON CONFLICT (id) DO NOTHING;

-- 5. Data Sources: Manual & CSV
INSERT INTO data_sources (id, business_id, source_type, display_name, source_status)
VALUES 
(
    '42000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'MANUAL',
    'Owner Direct Entry',
    'ACTIVE'
),
(
    '42000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'CSV',
    'Bank Statement Upload',
    'ACTIVE'
) ON CONFLICT (id) DO NOTHING;

-- 6. Transaction Categories
INSERT INTO transaction_categories (id, business_id, category_code, display_name, allowed_direction, is_active)
VALUES
(
    '41000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'SALES',
    'Daily Retail & UPI Sales',
    'INFLOW',
    true
),
(
    '41000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'INVENTORY',
    'Stock & Supplier Purchases',
    'OUTFLOW',
    true
),
(
    '41000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'RENT',
    'Shop Rent',
    'OUTFLOW',
    true
),
(
    '41000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    'UTILITIES',
    'Electricity, Water & Internet',
    'OUTFLOW',
    true
),
(
    '41000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'PACKAGING',
    'Bags & Packaging Materials',
    'OUTFLOW',
    true
) ON CONFLICT (id) DO NOTHING;

-- 7. Opening Balance Snapshots: ₹62,000 (Bank) + ₹8,000 (Cash) = ₹70,000 Total
INSERT INTO account_balance_snapshots (id, business_id, account_id, snapshot_type, balance_paise, as_of_at, certainty, source_data_source_id, entered_by_user_id)
VALUES
(
    '51000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'OPENING',
    6200000, -- ₹62,000
    '2026-11-13T18:29:59Z',
    'CONFIRMED',
    '42000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
),
(
    '51000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    'OPENING',
    800000, -- ₹8,000
    '2026-11-13T18:29:59Z',
    'CONFIRMED',
    '42000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
) ON CONFLICT (id) DO NOTHING;

-- 8. Supplier: Deccan Wholesale
INSERT INTO suppliers (id, business_id, display_name, external_reference, record_status)
VALUES (
    '31000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Deccan Wholesale Distributors',
    'SUP-PUNE-01',
    'ACTIVE'
) ON CONFLICT (id) DO NOTHING;

-- 9. Supplier Bill: DW-884 for ₹48,000 due 2026-11-18
INSERT INTO supplier_bills (id, business_id, supplier_id, bill_number, bill_date, due_date, total_paise, bill_status)
VALUES (
    '73000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    'DW-884',
    '2026-11-10',
    '2026-11-18',
    4800000, -- ₹48,000
    'RECEIVED'
) ON CONFLICT (id) DO NOTHING;

-- 10. Payable: Deccan Wholesale ₹48,000 expected on 2026-11-18 (CONFIRMED)
INSERT INTO payables (id, business_id, bill_id, expected_payment_date, expected_date_source, expected_certainty, payment_state)
VALUES (
    '74000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000001',
    '2026-11-18',
    'CONTRACT_DUE',
    'CONFIRMED',
    'OPEN'
) ON CONFLICT (id) DO NOTHING;

-- 11. Customer: Mehta Stores
INSERT INTO customers (id, business_id, display_name, external_reference, record_status)
VALUES (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Mehta Stores (Kothrud)',
    'CUST-104',
    'ACTIVE'
) ON CONFLICT (id) DO NOTHING;

-- 12. Sales Invoice: SLK-2026-104 for ₹30,000 due 2026-11-20
INSERT INTO sales_invoices (id, business_id, customer_id, invoice_number, issued_date, due_date, total_paise, invoice_status)
VALUES (
    '70000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'SLK-2026-104',
    '2026-11-05',
    '2026-11-20',
    3000000, -- ₹30,000
    'ISSUED'
) ON CONFLICT (id) DO NOTHING;

-- 13. Receivable: Mehta Stores ₹20,000 outstanding (₹10,000 settled earlier), expected 2026-11-24 (ESTIMATED)
INSERT INTO receivables (id, business_id, invoice_id, expected_collection_date, expected_date_source, expected_certainty, collection_state)
VALUES (
    '70000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000001',
    '2026-11-24',
    'HISTORICAL_PATTERN',
    'ESTIMATED',
    'OPEN'
) ON CONFLICT (id) DO NOTHING;

-- 14. Partial Payment Transaction: ₹10,000 received on 2026-11-13 (already in opening balance)
INSERT INTO transactions (
    id, business_id, account_id, category_id, data_source_id,
    transaction_date, occurred_at, transaction_type, cash_direction,
    amount_paise, description, counterparty_name, record_status
)
VALUES (
    '60000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '2026-11-13',
    '2026-11-13T10:15:00Z',
    'INFLOW',
    'INFLOW',
    1000000, -- ₹10,000
    'UPI part payment for invoice SLK-2026-104',
    'Mehta Stores',
    'POSTED'
) ON CONFLICT (id) DO NOTHING;

-- 15. Allocate that ₹10,000 to the receivable -> Leaves ₹20,000 outstanding!
INSERT INTO receivable_payment_allocations (id, business_id, receivable_id, transaction_id, amount_paise)
VALUES (
    '71000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000001',
    1000000 -- ₹10,000
) ON CONFLICT (id) DO NOTHING;

-- 16. Recurring Item: Shop Rent of ₹18,000 monthly due on the 21st
INSERT INTO recurring_items (
    id, business_id, category_id, counterparty_type, direction,
    description, amount_paise, recurrence, interval_count, day_of_month,
    start_date, next_due_date, schedule_status
)
VALUES (
    '91000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000003',
    'OTHER',
    'OUTFLOW',
    'Shop Rent - Kothrud Market Complex',
    1800000, -- ₹18,000
    'MONTHLY',
    1,
    21,
    '2026-11-21',
    '2026-11-21',
    'ACTIVE'
) ON CONFLICT (id) DO NOTHING;

-- 17. Recurring Occurrence: November Rent due 2026-11-21 (ESTIMATED)
INSERT INTO recurring_occurrences (
    id, business_id, recurring_item_id, period_key, expected_date,
    expected_amount_paise, certainty, occurrence_status
)
VALUES (
    '90000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    '2026-11-21',
    '2026-11-21',
    1800000, -- ₹18,000
    'ESTIMATED',
    'PLANNED'
) ON CONFLICT (id) DO NOTHING;

-- 18. Audit event recording demo dataset initialization
INSERT INTO audit_events (business_id, actor_user_id, action, entity_name, entity_id, metadata)
VALUES (
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'DEMO_DATASET_INITIALIZED',
    'businesses',
    '10000000-0000-4000-8000-000000000001',
    '{"scenario": "kirana_distributor_payment_use_case_a", "program": "arthaton_2026"}'
);
