-- Cashflow Sentinel — Database Migration 001: Initial Schema
-- Target: PostgreSQL 14+
-- Conforming to: docs/database/DATABASE_SCHEMA.md & docs/api/API_CONTRACT.md

-- Enable UUID extension if available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. Identity, Tenancy & Memberships
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email_verified_at TIMESTAMPTZ NULL,
    account_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE', 'DISABLED', 'PENDING_VERIFICATION')),
    last_login_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    business_type TEXT NULL CHECK (business_type IN ('KIRANA', 'APPAREL', 'WHOLESALE', 'OTHER')),
    city TEXT NULL,
    currency_code CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency_code = 'INR'),
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    minimum_cash_buffer_paise BIGINT NOT NULL DEFAULT 0 CHECK (minimum_cash_buffer_paise >= 0),
    business_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (business_status IN ('ACTIVE', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS business_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
    membership_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (membership_status IN ('ACTIVE', 'INVITED', 'REVOKED')),
    invited_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_business_memberships_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_business_memberships_user UNIQUE (business_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_business_memberships_user_status ON business_memberships (user_id, membership_status);

-- ============================================================================
-- 2. Accounts & Balance Snapshots
-- ============================================================================

CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_type TEXT NOT NULL CHECK (account_type IN ('BANK', 'CASH', 'OTHER')),
    display_name TEXT NOT NULL,
    institution_name TEXT NULL,
    currency_code CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency_code = 'INR'),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_accounts_tenant UNIQUE (business_id, id)
);

CREATE INDEX IF NOT EXISTS idx_accounts_business_type ON accounts (business_id, is_active, account_type);

-- Data sources & provenance
CREATE TABLE IF NOT EXISTS data_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('MANUAL', 'CSV', 'STATEMENT', 'INTEGRATION')),
    display_name TEXT NOT NULL,
    provider_name TEXT NULL,
    source_metadata JSONB NOT NULL DEFAULT '{}',
    source_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (source_status IN ('ACTIVE', 'DISABLED', 'REVOKED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_data_sources_tenant UNIQUE (business_id, id)
);

CREATE TABLE IF NOT EXISTS account_balance_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    account_id UUID NOT NULL,
    snapshot_type TEXT NOT NULL CHECK (snapshot_type IN ('OPENING', 'RECONCILIATION', 'IMPORTED_BALANCE')),
    balance_paise BIGINT NOT NULL,
    as_of_at TIMESTAMPTZ NOT NULL,
    certainty TEXT NOT NULL CHECK (certainty IN ('CONFIRMED', 'ESTIMATED')),
    source_data_source_id UUID NULL,
    entered_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_account_balance_snapshots_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_abs_account FOREIGN KEY (business_id, account_id) REFERENCES accounts(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_abs_source FOREIGN KEY (business_id, source_data_source_id) REFERENCES data_sources(business_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_account_balance_snapshots_latest ON account_balance_snapshots (business_id, account_id, as_of_at DESC);

-- ============================================================================
-- 3. Categories, Imports & Transactions
-- ============================================================================

CREATE TABLE IF NOT EXISTS transaction_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    category_code TEXT NOT NULL,
    display_name TEXT NOT NULL,
    allowed_direction TEXT NOT NULL CHECK (allowed_direction IN ('INFLOW', 'OUTFLOW', 'BOTH')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_categories_code UNIQUE (business_id, category_code),
    CONSTRAINT uq_categories_tenant UNIQUE (business_id, id)
);

CREATE TABLE IF NOT EXISTS import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    data_source_id UUID NOT NULL,
    uploaded_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    original_filename TEXT NULL,
    content_sha256 CHAR(64) NULL,
    status TEXT NOT NULL CHECK (status IN ('UPLOADED', 'PARSING', 'REVIEW_REQUIRED', 'COMPLETED', 'FAILED')),
    row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
    rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    mapping_snapshot JSONB NULL,
    error_summary JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_import_batches_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_import_batches_source FOREIGN KEY (business_id, data_source_id) REFERENCES data_sources(business_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_import_batches_tenant_created ON import_batches (business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS import_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    import_batch_id UUID NOT NULL,
    source_row_number INTEGER NOT NULL CHECK (source_row_number > 0),
    row_fingerprint CHAR(64) NULL,
    parsed_transaction_date DATE NULL,
    parsed_amount_paise BIGINT NULL CHECK (parsed_amount_paise IS NULL OR parsed_amount_paise > 0),
    parsed_direction TEXT NULL CHECK (parsed_direction IN ('INFLOW', 'OUTFLOW')),
    parsed_description TEXT NULL,
    source_reference TEXT NULL,
    review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING', 'ACCEPTED', 'DUPLICATE_CANDIDATE', 'REJECTED')),
    validation_errors JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_import_rows_source UNIQUE (business_id, import_batch_id, source_row_number),
    CONSTRAINT uq_import_rows_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_import_rows_batch FOREIGN KEY (business_id, import_batch_id) REFERENCES import_batches(business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    account_id UUID NOT NULL,
    category_id UUID NULL,
    data_source_id UUID NOT NULL,
    import_row_id UUID NULL,
    source_reference TEXT NULL,
    transaction_date DATE NOT NULL,
    occurred_at TIMESTAMPTZ NULL,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('INFLOW', 'OUTFLOW', 'OWNER_CONTRIBUTION', 'OWNER_DRAW', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT')),
    cash_direction TEXT NOT NULL CHECK (cash_direction IN ('INFLOW', 'OUTFLOW')),
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    description TEXT NULL,
    counterparty_name TEXT NULL,
    record_status TEXT NOT NULL DEFAULT 'POSTED' CHECK (record_status IN ('POSTED', 'REVERSED')),
    reversal_of_transaction_id UUID NULL,
    created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_transactions_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_trans_account FOREIGN KEY (business_id, account_id) REFERENCES accounts(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_trans_category FOREIGN KEY (business_id, category_id) REFERENCES transaction_categories(business_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_trans_source FOREIGN KEY (business_id, data_source_id) REFERENCES data_sources(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_trans_import_row FOREIGN KEY (business_id, import_row_id) REFERENCES import_rows(business_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_trans_reversal FOREIGN KEY (business_id, reversal_of_transaction_id) REFERENCES transactions(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_reversal_not_self CHECK (reversal_of_transaction_id IS NULL OR reversal_of_transaction_id <> id),
    CONSTRAINT chk_direction_type_match CHECK (
        (transaction_type IN ('INFLOW', 'OWNER_CONTRIBUTION', 'TRANSFER_IN') AND cash_direction = 'INFLOW') OR
        (transaction_type IN ('OUTFLOW', 'OWNER_DRAW', 'TRANSFER_OUT') AND cash_direction = 'OUTFLOW') OR
        (transaction_type = 'ADJUSTMENT' AND cash_direction IN ('INFLOW', 'OUTFLOW') AND description IS NOT NULL AND length(trim(description)) > 0)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_import_row ON transactions (business_id, import_row_id) WHERE import_row_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_reversal ON transactions (business_id, reversal_of_transaction_id) WHERE reversal_of_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_source_ref ON transactions (business_id, data_source_id, source_reference) WHERE source_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_date ON transactions (business_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions (business_id, account_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_category_date ON transactions (business_id, category_id, transaction_date DESC);

CREATE TABLE IF NOT EXISTS transaction_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    outgoing_transaction_id UUID NOT NULL,
    incoming_transaction_id UUID NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_transaction_transfers_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_transfers_outgoing UNIQUE (business_id, outgoing_transaction_id),
    CONSTRAINT uq_transfers_incoming UNIQUE (business_id, incoming_transaction_id),
    CONSTRAINT fk_transfer_out FOREIGN KEY (business_id, outgoing_transaction_id) REFERENCES transactions(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_transfer_in FOREIGN KEY (business_id, incoming_transaction_id) REFERENCES transactions(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_transfers_distinct_legs CHECK (outgoing_transaction_id <> incoming_transaction_id)
);

-- ============================================================================
-- 4. Customers, Invoices & Receivables
-- ============================================================================

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    external_reference TEXT NULL,
    contact_hint TEXT NULL,
    record_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (record_status IN ('ACTIVE', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_customers_tenant UNIQUE (business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_external_ref ON customers (business_id, external_reference) WHERE external_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    customer_id UUID NOT NULL,
    invoice_number TEXT NOT NULL,
    issued_date DATE NOT NULL,
    due_date DATE NOT NULL,
    total_paise BIGINT NOT NULL CHECK (total_paise > 0),
    invoice_status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (invoice_status IN ('DRAFT', 'ISSUED', 'VOID')),
    external_reference TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_sales_invoices_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_sales_invoices_number UNIQUE (business_id, invoice_number),
    CONSTRAINT fk_sales_invoices_customer FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_sales_invoices_due_date CHECK (due_date >= issued_date)
);

CREATE INDEX IF NOT EXISTS idx_sales_invoices_customer_due ON sales_invoices (business_id, customer_id, due_date);

CREATE TABLE IF NOT EXISTS receivables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    invoice_id UUID NOT NULL,
    expected_collection_date DATE NULL,
    expected_date_source TEXT NULL CHECK (expected_date_source IN ('CONTRACT_DUE', 'OWNER_ESTIMATE', 'HISTORICAL_PATTERN')),
    expected_certainty TEXT NOT NULL DEFAULT 'ESTIMATED' CHECK (expected_certainty IN ('ESTIMATED', 'CONFIRMED')),
    collection_state TEXT NOT NULL DEFAULT 'OPEN' CHECK (collection_state IN ('OPEN', 'ON_HOLD', 'WRITTEN_OFF', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_receivables_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_receivables_invoice UNIQUE (business_id, invoice_id),
    CONSTRAINT fk_receivables_invoice FOREIGN KEY (business_id, invoice_id) REFERENCES sales_invoices(business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_receivables_expected_date ON receivables (business_id, expected_collection_date, collection_state);

CREATE TABLE IF NOT EXISTS receivable_payment_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    receivable_id UUID NOT NULL,
    transaction_id UUID NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_receivable_allocations_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_receivable_allocations_pair UNIQUE (business_id, receivable_id, transaction_id),
    CONSTRAINT fk_rec_alloc_receivable FOREIGN KEY (business_id, receivable_id) REFERENCES receivables(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_rec_alloc_transaction FOREIGN KEY (business_id, transaction_id) REFERENCES transactions(business_id, id) ON DELETE RESTRICT
);

-- ============================================================================
-- 5. Suppliers, Bills & Payables
-- ============================================================================

CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    external_reference TEXT NULL,
    contact_hint TEXT NULL,
    record_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (record_status IN ('ACTIVE', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_suppliers_tenant UNIQUE (business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_external_ref ON suppliers (business_id, external_reference) WHERE external_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS supplier_bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    supplier_id UUID NOT NULL,
    bill_number TEXT NOT NULL,
    bill_date DATE NOT NULL,
    due_date DATE NOT NULL,
    total_paise BIGINT NOT NULL CHECK (total_paise > 0),
    bill_status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (bill_status IN ('DRAFT', 'RECEIVED', 'VOID')),
    external_reference TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_supplier_bills_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_supplier_bills_number UNIQUE (business_id, bill_number),
    CONSTRAINT fk_supplier_bills_supplier FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_supplier_bills_due_date CHECK (due_date >= bill_date)
);

CREATE INDEX IF NOT EXISTS idx_supplier_bills_due ON supplier_bills (business_id, supplier_id, due_date);

CREATE TABLE IF NOT EXISTS payables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    bill_id UUID NOT NULL,
    expected_payment_date DATE NULL,
    expected_date_source TEXT NULL CHECK (expected_date_source IN ('CONTRACT_DUE', 'OWNER_ESTIMATE')),
    expected_certainty TEXT NOT NULL DEFAULT 'ESTIMATED' CHECK (expected_certainty IN ('ESTIMATED', 'CONFIRMED')),
    payment_state TEXT NOT NULL DEFAULT 'OPEN' CHECK (payment_state IN ('OPEN', 'ON_HOLD', 'DISPUTED', 'WRITTEN_OFF', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_payables_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_payables_bill UNIQUE (business_id, bill_id),
    CONSTRAINT fk_payables_bill FOREIGN KEY (business_id, bill_id) REFERENCES supplier_bills(business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payables_expected_date ON payables (business_id, expected_payment_date, payment_state);

CREATE TABLE IF NOT EXISTS payable_payment_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    payable_id UUID NOT NULL,
    transaction_id UUID NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_payable_allocations_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_payable_allocations_pair UNIQUE (business_id, payable_id, transaction_id),
    CONSTRAINT fk_pay_alloc_payable FOREIGN KEY (business_id, payable_id) REFERENCES payables(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_pay_alloc_transaction FOREIGN KEY (business_id, transaction_id) REFERENCES transactions(business_id, id) ON DELETE RESTRICT
);

-- ============================================================================
-- 6. Recurring Items & Occurrences
-- ============================================================================

CREATE TABLE IF NOT EXISTS recurring_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    category_id UUID NULL,
    counterparty_type TEXT NOT NULL CHECK (counterparty_type IN ('CUSTOMER', 'SUPPLIER', 'OTHER')),
    customer_id UUID NULL,
    supplier_id UUID NULL,
    direction TEXT NOT NULL CHECK (direction IN ('INFLOW', 'OUTFLOW')),
    description TEXT NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    recurrence TEXT NOT NULL CHECK (recurrence IN ('WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'QUARTERLY', 'YEARLY')),
    interval_count SMALLINT NOT NULL DEFAULT 1 CHECK (interval_count > 0),
    day_of_month SMALLINT NULL CHECK (day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 31)),
    start_date DATE NOT NULL,
    end_date DATE NULL,
    next_due_date DATE NOT NULL,
    schedule_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (schedule_status IN ('ACTIVE', 'PAUSED', 'ENDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_recurring_items_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_recurring_category FOREIGN KEY (business_id, category_id) REFERENCES transaction_categories(business_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_recurring_customer FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_recurring_supplier FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_recurring_counterparty CHECK (
        (counterparty_type = 'CUSTOMER' AND customer_id IS NOT NULL AND supplier_id IS NULL AND direction = 'INFLOW') OR
        (counterparty_type = 'SUPPLIER' AND supplier_id IS NOT NULL AND customer_id IS NULL AND direction = 'OUTFLOW') OR
        (counterparty_type = 'OTHER' AND customer_id IS NULL AND supplier_id IS NULL)
    ),
    CONSTRAINT chk_recurring_dates CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS recurring_occurrences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    recurring_item_id UUID NOT NULL,
    period_key DATE NOT NULL,
    expected_date DATE NOT NULL,
    expected_amount_paise BIGINT NOT NULL CHECK (expected_amount_paise > 0),
    certainty TEXT NOT NULL DEFAULT 'ESTIMATED' CHECK (certainty IN ('ESTIMATED', 'CONFIRMED')),
    occurrence_status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (occurrence_status IN ('PLANNED', 'CONFIRMED', 'SETTLED', 'SKIPPED', 'CANCELLED')),
    actual_transaction_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_recurring_occurrences_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_recurring_period UNIQUE (business_id, recurring_item_id, period_key),
    CONSTRAINT fk_recurring_occ_item FOREIGN KEY (business_id, recurring_item_id) REFERENCES recurring_items(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_recurring_occ_trans FOREIGN KEY (business_id, actual_transaction_id) REFERENCES transactions(business_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_occurrence_settled_link CHECK (
        (occurrence_status = 'SETTLED' AND actual_transaction_id IS NOT NULL) OR
        (occurrence_status <> 'SETTLED' AND actual_transaction_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_recurring_occurrences_trans ON recurring_occurrences (business_id, actual_transaction_id) WHERE actual_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recurring_occ_date_status ON recurring_occurrences (business_id, expected_date, occurrence_status);

-- ============================================================================
-- 7. Forecasts, Evidence & Risk Alerts
-- ============================================================================

CREATE TABLE IF NOT EXISTS forecast_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    requested_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ NULL,
    as_of_at TIMESTAMPTZ NOT NULL,
    business_as_of_date DATE NOT NULL,
    opening_confirmed_paise BIGINT NOT NULL,
    opening_estimated_paise BIGINT NOT NULL DEFAULT 0,
    horizon_days SMALLINT NOT NULL CHECK (horizon_days >= 1 AND horizon_days <= 90),
    method_name TEXT NOT NULL,
    method_version TEXT NOT NULL,
    service_version TEXT NULL,
    input_snapshot JSONB NOT NULL,
    input_snapshot_sha256 CHAR(64) NOT NULL,
    data_quality TEXT NOT NULL CHECK (data_quality IN ('SUFFICIENT', 'LIMITED', 'INSUFFICIENT')),
    run_status TEXT NOT NULL CHECK (run_status IN ('REQUESTED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    failure_code TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_forecast_runs_tenant UNIQUE (business_id, id)
);

CREATE INDEX IF NOT EXISTS idx_forecast_runs_requested ON forecast_runs (business_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_runs_status ON forecast_runs (business_id, run_status, requested_at DESC);

CREATE TABLE IF NOT EXISTS forecast_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    forecast_run_id UUID NOT NULL,
    forecast_date DATE NOT NULL,
    confirmed_inflow_paise BIGINT NOT NULL DEFAULT 0 CHECK (confirmed_inflow_paise >= 0),
    confirmed_outflow_paise BIGINT NOT NULL DEFAULT 0 CHECK (confirmed_outflow_paise >= 0),
    estimated_inflow_paise BIGINT NOT NULL DEFAULT 0 CHECK (estimated_inflow_paise >= 0),
    estimated_outflow_paise BIGINT NOT NULL DEFAULT 0 CHECK (estimated_outflow_paise >= 0),
    predicted_inflow_paise BIGINT NOT NULL DEFAULT 0 CHECK (predicted_inflow_paise >= 0),
    predicted_outflow_paise BIGINT NOT NULL DEFAULT 0 CHECK (predicted_outflow_paise >= 0),
    closing_confirmed_paise BIGINT NOT NULL,
    closing_with_estimates_paise BIGINT NOT NULL,
    closing_predicted_paise BIGINT NOT NULL,
    predicted_low_paise BIGINT NULL,
    predicted_high_paise BIGINT NULL,
    uncertainty_band TEXT NOT NULL CHECK (uncertainty_band IN ('LOW', 'MEDIUM', 'HIGH')),
    CONSTRAINT uq_forecast_points_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_forecast_points_date UNIQUE (business_id, forecast_run_id, forecast_date),
    CONSTRAINT fk_forecast_points_run FOREIGN KEY (business_id, forecast_run_id) REFERENCES forecast_runs(business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS analysis_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    forecast_run_id UUID NOT NULL,
    event_id UUID NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('PAYABLE', 'RECEIVABLE', 'RECURRING_OCCURRENCE', 'TRANSACTION_HISTORY', 'MANUAL_ASSUMPTION')),
    certainty TEXT NOT NULL CHECK (certainty IN ('CONFIRMED', 'ESTIMATED', 'PREDICTED')),
    movement_date DATE NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('INFLOW', 'OUTFLOW')),
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    label_snapshot TEXT NOT NULL,
    forecast_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_analysis_evidence_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_analysis_evidence_run FOREIGN KEY (business_id, forecast_run_id) REFERENCES forecast_runs(business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS risk_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    forecast_run_id UUID NOT NULL,
    alert_type TEXT NOT NULL CHECK (alert_type IN ('CASH_BUFFER_BREACH', 'RECEIPT_DELAY_RISK', 'LARGE_UPCOMING_EXPENSE', 'LOW_BUFFER_WARNING')),
    severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED')),
    projected_date DATE NOT NULL,
    threshold_paise BIGINT NOT NULL,
    projected_balance_paise BIGINT NOT NULL,
    deduplication_key TEXT NOT NULL,
    title TEXT NOT NULL,
    explanation TEXT NOT NULL,
    acknowledged_at TIMESTAMPTZ NULL,
    resolved_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_risk_alerts_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_risk_alerts_run FOREIGN KEY (business_id, forecast_run_id) REFERENCES forecast_runs(business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_risk_alerts_status ON risk_alerts (business_id, status, projected_date);

CREATE TABLE IF NOT EXISTS alert_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    forecast_run_id UUID NOT NULL,
    alert_id UUID NOT NULL,
    analysis_evidence_id UUID NOT NULL,
    contribution_paise BIGINT NOT NULL,
    contribution_role TEXT NOT NULL,
    CONSTRAINT uq_alert_evidence_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_alert_evidence_pair UNIQUE (business_id, alert_id, analysis_evidence_id),
    CONSTRAINT fk_alert_evid_run FOREIGN KEY (business_id, forecast_run_id) REFERENCES forecast_runs(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_alert_evid_alert FOREIGN KEY (business_id, alert_id) REFERENCES risk_alerts(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_alert_evid_analysis FOREIGN KEY (business_id, analysis_evidence_id) REFERENCES analysis_evidence(business_id, id) ON DELETE CASCADE
);

-- ============================================================================
-- 8. What-If Simulations
-- ============================================================================

CREATE TABLE IF NOT EXISTS simulations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    baseline_forecast_run_id UUID NOT NULL,
    created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'CALCULATED' CHECK (status IN ('DRAFT', 'CALCULATED', 'ARCHIVED')),
    input_snapshot_sha256 CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_simulations_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_simulations_baseline FOREIGN KEY (business_id, baseline_forecast_run_id) REFERENCES forecast_runs(business_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS scenario_assumptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    simulation_id UUID NOT NULL,
    assumption_type TEXT NOT NULL CHECK (assumption_type IN ('DELAYED_RECEIPT', 'EARLIER_RECEIPT', 'EXPENSE_CHANGE', 'NEW_PURCHASE', 'MANUAL_CASH_MOVEMENT')),
    target_receivable_id UUID NULL,
    target_payable_id UUID NULL,
    target_recurring_occurrence_id UUID NULL,
    amount_delta_paise BIGINT NULL,
    date_override DATE NULL,
    assumption_label TEXT NOT NULL,
    assumption_snapshot JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT uq_scenario_assumptions_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_scenario_assump_sim FOREIGN KEY (business_id, simulation_id) REFERENCES simulations(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_scenario_assump_rec FOREIGN KEY (business_id, target_receivable_id) REFERENCES receivables(business_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_scenario_assump_pay FOREIGN KEY (business_id, target_payable_id) REFERENCES payables(business_id, id) ON DELETE SET NULL,
    CONSTRAINT fk_scenario_assump_occ FOREIGN KEY (business_id, target_recurring_occurrence_id) REFERENCES recurring_occurrences(business_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS simulation_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    simulation_id UUID NOT NULL,
    forecast_date DATE NOT NULL,
    baseline_closing_paise BIGINT NOT NULL,
    scenario_closing_paise BIGINT NOT NULL,
    difference_paise BIGINT NOT NULL,
    buffer_breached BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_simulation_points_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_simulation_points_date UNIQUE (business_id, simulation_id, forecast_date),
    CONSTRAINT fk_sim_points_sim FOREIGN KEY (business_id, simulation_id) REFERENCES simulations(business_id, id) ON DELETE CASCADE
);

-- ============================================================================
-- 9. Explainable Recommendations & Financial Health
-- ============================================================================

CREATE TABLE IF NOT EXISTS recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    forecast_run_id UUID NOT NULL,
    alert_id UUID NULL,
    rule_id TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    rank INTEGER NOT NULL CHECK (rank >= 1),
    title TEXT NOT NULL,
    explanation TEXT NOT NULL,
    expected_effect_paise BIGINT NULL,
    suggested_by_date DATE NULL,
    uncertainty_band TEXT NOT NULL CHECK (uncertainty_band IN ('LOW', 'MEDIUM', 'HIGH')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'USEFUL', 'DISMISSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_recommendations_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_rec_run FOREIGN KEY (business_id, forecast_run_id) REFERENCES forecast_runs(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_rec_alert FOREIGN KEY (business_id, alert_id) REFERENCES risk_alerts(business_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS recommendation_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    forecast_run_id UUID NOT NULL,
    recommendation_id UUID NOT NULL,
    analysis_evidence_id UUID NOT NULL,
    CONSTRAINT uq_recommendation_evidence_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_recommendation_evidence_pair UNIQUE (business_id, recommendation_id, analysis_evidence_id),
    CONSTRAINT fk_rec_evid_run FOREIGN KEY (business_id, forecast_run_id) REFERENCES forecast_runs(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_rec_evid_rec FOREIGN KEY (business_id, recommendation_id) REFERENCES recommendations(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_rec_evid_analysis FOREIGN KEY (business_id, analysis_evidence_id) REFERENCES analysis_evidence(business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS financial_health_assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    forecast_run_id UUID NOT NULL,
    indicator_version TEXT NOT NULL,
    score INTEGER NULL CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
    health_band TEXT NOT NULL CHECK (health_band IN ('HEALTHY', 'WATCH', 'CRITICAL', 'INSUFFICIENT_DATA')),
    input_completeness NUMERIC(5,2) NOT NULL CHECK (input_completeness >= 0 AND input_completeness <= 100),
    explanation TEXT NOT NULL,
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_financial_health_tenant UNIQUE (business_id, id),
    CONSTRAINT uq_financial_health_run UNIQUE (business_id, forecast_run_id),
    CONSTRAINT fk_health_run FOREIGN KEY (business_id, forecast_run_id) REFERENCES forecast_runs(business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS health_assessment_factors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    forecast_run_id UUID NOT NULL,
    assessment_id UUID NOT NULL,
    factor_code TEXT NOT NULL CHECK (factor_code IN ('BUFFER_COVERAGE', 'RECEIVABLE_DELAYS', 'UPCOMING_OBLIGATIONS', 'CASH_VOLATILITY', 'INPUT_FRESHNESS')),
    measured_value TEXT NOT NULL,
    measured_amount_paise BIGINT NULL,
    effect_points INTEGER NOT NULL,
    explanation TEXT NOT NULL,
    CONSTRAINT uq_health_factors_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_health_factors_run FOREIGN KEY (business_id, forecast_run_id) REFERENCES forecast_runs(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_health_factors_assessment FOREIGN KEY (business_id, assessment_id) REFERENCES financial_health_assessments(business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS health_factor_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    forecast_run_id UUID NOT NULL,
    factor_id UUID NOT NULL,
    analysis_evidence_id UUID NOT NULL,
    CONSTRAINT uq_health_factor_evid_tenant UNIQUE (business_id, id),
    CONSTRAINT fk_health_fe_run FOREIGN KEY (business_id, forecast_run_id) REFERENCES forecast_runs(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_health_fe_factor FOREIGN KEY (business_id, factor_id) REFERENCES health_assessment_factors(business_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_health_fe_analysis FOREIGN KEY (business_id, analysis_evidence_id) REFERENCES analysis_evidence(business_id, id) ON DELETE CASCADE
);

-- ============================================================================
-- 10. Audit Events & Idempotency Storage
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NULL REFERENCES businesses(id) ON DELETE CASCADE,
    actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_name TEXT NOT NULL,
    entity_id UUID NULL,
    request_id TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_business ON audit_events (business_id, created_at DESC);

-- Idempotency registry for retryable mutation endpoints
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    request_hash CHAR(64) NOT NULL,
    response_code INTEGER NULL,
    response_body JSONB NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_idempotency_key UNIQUE (business_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys (expires_at);
