-- Cashflow Sentinel — Database Migration 002: Triggers and Integrity Functions
-- Target: PostgreSQL 14+
-- Conforming to: docs/database/DATABASE_SCHEMA.md

-- ============================================================================
-- 1. Category Direction Enforcement
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_check_transaction_category_direction()
RETURNS TRIGGER AS $$
DECLARE
    v_allowed_direction TEXT;
BEGIN
    IF NEW.category_id IS NOT NULL THEN
        SELECT allowed_direction INTO v_allowed_direction
        FROM transaction_categories
        WHERE business_id = NEW.business_id AND id = NEW.category_id;

        IF v_allowed_direction IS NOT NULL AND v_allowed_direction <> 'BOTH' THEN
            IF v_allowed_direction <> NEW.cash_direction THEN
                RAISE EXCEPTION 'Category direction (%) does not match transaction cash_direction (%)',
                    v_allowed_direction, NEW.cash_direction;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_transaction_category_direction ON transactions;
CREATE TRIGGER trg_check_transaction_category_direction
    BEFORE INSERT OR UPDATE OF category_id, cash_direction ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION fn_check_transaction_category_direction();

-- ============================================================================
-- 2. Document Immutability (Invoices & Bills)
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_protect_sales_invoice_total()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.invoice_status = 'ISSUED' AND NEW.total_paise <> OLD.total_paise THEN
        RAISE EXCEPTION 'Issued invoice total_paise cannot be modified in place. Use void and replace workflow.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_sales_invoice_total ON sales_invoices;
CREATE TRIGGER trg_protect_sales_invoice_total
    BEFORE UPDATE OF total_paise ON sales_invoices
    FOR EACH ROW
    EXECUTE FUNCTION fn_protect_sales_invoice_total();

CREATE OR REPLACE FUNCTION fn_protect_supplier_bill_total()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.bill_status = 'RECEIVED' AND NEW.total_paise <> OLD.total_paise THEN
        RAISE EXCEPTION 'Received supplier bill total_paise cannot be modified in place. Use void and replace workflow.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_supplier_bill_total ON supplier_bills;
CREATE TRIGGER trg_protect_supplier_bill_total
    BEFORE UPDATE OF total_paise ON supplier_bills
    FOR EACH ROW
    EXECUTE FUNCTION fn_protect_supplier_bill_total();

-- ============================================================================
-- 3. Allocation Capacity & Caps
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_check_receivable_allocation_caps()
RETURNS TRIGGER AS $$
DECLARE
    v_trans_amount BIGINT;
    v_trans_dir TEXT;
    v_trans_status TEXT;
    v_trans_allocated BIGINT;
    v_invoice_total BIGINT;
    v_invoice_status TEXT;
    v_rec_allocated BIGINT;
BEGIN
    -- Verify transaction
    SELECT amount_paise, cash_direction, record_status
    INTO v_trans_amount, v_trans_dir, v_trans_status
    FROM transactions
    WHERE business_id = NEW.business_id AND id = NEW.transaction_id;

    IF v_trans_status <> 'POSTED' OR v_trans_dir <> 'INFLOW' THEN
        RAISE EXCEPTION 'Only POSTED INFLOW transactions can be allocated to receivables.';
    END IF;

    -- Calculate total already allocated from this transaction
    SELECT COALESCE(SUM(amount_paise), 0) INTO v_trans_allocated
    FROM receivable_payment_allocations
    WHERE business_id = NEW.business_id AND transaction_id = NEW.transaction_id AND id <> NEW.id;

    IF (v_trans_allocated + NEW.amount_paise) > v_trans_amount THEN
        RAISE EXCEPTION 'Allocation exceeds transaction available amount. Available: %, Requested: %',
            (v_trans_amount - v_trans_allocated), NEW.amount_paise;
    END IF;

    -- Verify receivable and invoice capacity
    SELECT si.total_paise, si.invoice_status
    INTO v_invoice_total, v_invoice_status
    FROM receivables r
    JOIN sales_invoices si ON si.business_id = r.business_id AND si.id = r.invoice_id
    WHERE r.business_id = NEW.business_id AND r.id = NEW.receivable_id;

    IF v_invoice_status <> 'ISSUED' THEN
        RAISE EXCEPTION 'Receivable invoice must be in ISSUED status to receive allocations.';
    END IF;

    SELECT COALESCE(SUM(amount_paise), 0) INTO v_rec_allocated
    FROM receivable_payment_allocations
    WHERE business_id = NEW.business_id AND receivable_id = NEW.receivable_id AND id <> NEW.id;

    IF (v_rec_allocated + NEW.amount_paise) > v_invoice_total THEN
        RAISE EXCEPTION 'Allocation exceeds receivable outstanding amount. Outstanding: %, Requested: %',
            (v_invoice_total - v_rec_allocated), NEW.amount_paise;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_receivable_allocation_caps ON receivable_payment_allocations;
CREATE TRIGGER trg_check_receivable_allocation_caps
    BEFORE INSERT OR UPDATE OF amount_paise, transaction_id, receivable_id ON receivable_payment_allocations
    FOR EACH ROW
    EXECUTE FUNCTION fn_check_receivable_allocation_caps();

CREATE OR REPLACE FUNCTION fn_check_payable_allocation_caps()
RETURNS TRIGGER AS $$
DECLARE
    v_trans_amount BIGINT;
    v_trans_dir TEXT;
    v_trans_status TEXT;
    v_trans_allocated BIGINT;
    v_bill_total BIGINT;
    v_bill_status TEXT;
    v_pay_allocated BIGINT;
BEGIN
    -- Verify transaction
    SELECT amount_paise, cash_direction, record_status
    INTO v_trans_amount, v_trans_dir, v_trans_status
    FROM transactions
    WHERE business_id = NEW.business_id AND id = NEW.transaction_id;

    IF v_trans_status <> 'POSTED' OR v_trans_dir <> 'OUTFLOW' THEN
        RAISE EXCEPTION 'Only POSTED OUTFLOW transactions can be allocated to payables.';
    END IF;

    -- Calculate total already allocated from this transaction
    SELECT COALESCE(SUM(amount_paise), 0) INTO v_trans_allocated
    FROM payable_payment_allocations
    WHERE business_id = NEW.business_id AND transaction_id = NEW.transaction_id AND id <> NEW.id;

    IF (v_trans_allocated + NEW.amount_paise) > v_trans_amount THEN
        RAISE EXCEPTION 'Allocation exceeds transaction available amount. Available: %, Requested: %',
            (v_trans_amount - v_trans_allocated), NEW.amount_paise;
    END IF;

    -- Verify payable and bill capacity
    SELECT sb.total_paise, sb.bill_status
    INTO v_bill_total, v_bill_status
    FROM payables p
    JOIN supplier_bills sb ON sb.business_id = p.business_id AND sb.id = p.bill_id
    WHERE p.business_id = NEW.business_id AND p.id = NEW.payable_id;

    IF v_bill_status <> 'RECEIVED' THEN
        RAISE EXCEPTION 'Payable supplier bill must be in RECEIVED status to receive allocations.';
    END IF;

    SELECT COALESCE(SUM(amount_paise), 0) INTO v_pay_allocated
    FROM payable_payment_allocations
    WHERE business_id = NEW.business_id AND payable_id = NEW.payable_id AND id <> NEW.id;

    IF (v_pay_allocated + NEW.amount_paise) > v_bill_total THEN
        RAISE EXCEPTION 'Allocation exceeds payable outstanding amount. Outstanding: %, Requested: %',
            (v_bill_total - v_pay_allocated), NEW.amount_paise;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_payable_allocation_caps ON payable_payment_allocations;
CREATE TRIGGER trg_check_payable_allocation_caps
    BEFORE INSERT OR UPDATE OF amount_paise, transaction_id, payable_id ON payable_payment_allocations
    FOR EACH ROW
    EXECUTE FUNCTION fn_check_payable_allocation_caps();
