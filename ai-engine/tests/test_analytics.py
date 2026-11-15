from app.schemas.forecast import ForecastRequest, MovementInput
from app.forecasting.engine import ForecastingEngine
from app.schemas.risk import RiskAnalysisRequest, RiskPointInput, RiskEvidenceInput
from app.risk_analysis.engine import RiskAnalysisEngine
from app.schemas.delay import PaymentDelayAnalysisRequest, ReceivableDelayInput
from app.payment_delay.engine import PaymentDelayEngine
from app.schemas.simulation import SimulationRequest, BaselinePoint, SimulationAssumption
from app.simulation.engine import SimulationEngine
from app.schemas.health import HealthAssessmentRequest
from app.health.engine import FinancialHealthEngine

def test_deterministic_forecast_roll_forward():
    # Setup Kavita's Kirana Store Use Case A:
    # Confirmed cash: ₹70,000 (7,000,000 paise)
    # Supplier bill: ₹48,000 (4,800,000 paise) due 2026-11-18
    # Rent: ₹18,000 (1,800,000 paise) due 2026-11-21
    # Customer receipt: ₹20,000 (2,000,000 paise) expected 2026-11-24
    req = ForecastRequest(
        request_id="req_test_01",
        business_id="10000000-0000-4000-8000-000000000001",
        forecast_run_id="a0000000-0000-4000-8000-000000000001",
        as_of_at="2026-11-13T18:29:59Z",
        business_as_of_date="2026-11-13",
        horizon_days=30,
        opening_confirmed_paise="7000000",
        opening_estimated_paise="0",
        minimum_cash_buffer_paise="1500000",
        confirmed_movements=[
            MovementInput(
                event_id="73000000-0000-4000-8000-000000000001",
                source_type="PAYABLE",
                date="2026-11-18",
                direction="OUTFLOW",
                amount_paise="4800000",
                label_snapshot="Deccan Wholesale Supplier Bill",
            )
        ],
        estimated_movements=[
            MovementInput(
                event_id="90000000-0000-4000-8000-000000000001",
                source_type="RECURRING_OCCURRENCE",
                date="2026-11-21",
                direction="OUTFLOW",
                amount_paise="1800000",
                label_snapshot="Monthly Shop Rent",
            ),
            MovementInput(
                event_id="70000000-0000-4000-8000-000000000002",
                source_type="RECEIVABLE",
                date="2026-11-24",
                direction="INFLOW",
                amount_paise="2000000",
                label_snapshot="Mehta Stores Receivable",
            ),
        ],
    )

    res = ForecastingEngine.compute_forecast(req)

    assert len(res.points) == 30
    assert res.points[0].forecast_date == "2026-11-14"

    # Check Nov 18: After supplier payment ₹48,000, balance is ₹22,000
    p_nov18 = next(p for p in res.points if p.forecast_date == "2026-11-18")
    assert p_nov18.closing_confirmed_paise == "2200000"
    assert p_nov18.closing_with_estimates_paise == "2200000"

    # Check Nov 21: After rent ₹18,000, balance dips to ₹4,000 (breach of ₹15,000 buffer!)
    p_nov21 = next(p for p in res.points if p.forecast_date == "2026-11-21")
    assert p_nov21.closing_with_estimates_paise == "400000"

    # Check Nov 24: After customer receipt ₹20,000, balance recovers to ₹24,000
    p_nov24 = next(p for p in res.points if p.forecast_date == "2026-11-24")
    assert p_nov24.closing_with_estimates_paise == "2400000"

def test_risk_analysis_buffer_breach():
    req = RiskAnalysisRequest(
        request_id="req_test_02",
        business_id="10000000-0000-4000-8000-000000000001",
        forecast_run_id="a0000000-0000-4000-8000-000000000001",
        minimum_cash_buffer_paise="1500000",  # ₹15,000
        points=[
            RiskPointInput(
                forecast_date="2026-11-21",
                closing_with_estimates_paise="400000",  # ₹4,000 -> breach!
                closing_predicted_paise="400000",
                uncertainty_band="MEDIUM",
            ),
            RiskPointInput(
                forecast_date="2026-11-24",
                closing_with_estimates_paise="2400000",  # ₹24,000 -> safe
                closing_predicted_paise="2400000",
                uncertainty_band="MEDIUM",
            ),
        ],
        evidence=[
            RiskEvidenceInput(
                analysis_evidence_id="a1100000-0000-4000-8000-000000000001",
                forecast_date="2026-11-21",
                source_type="RECURRING_OCCURRENCE",
                certainty="ESTIMATED",
                direction="OUTFLOW",
                amount_paise="1800000",
                label_snapshot="Shop rent",
            )
        ],
    )

    res = RiskAnalysisEngine.analyze_risks(req)
    assert len(res.candidates) == 1
    c = res.candidates[0]
    assert c.alert_type == "CASH_BUFFER_BREACH"
    assert c.severity == "WARNING"
    assert c.projected_date == "2026-11-21"
    assert len(c.evidence) == 1

def test_payment_delay_insufficient_history_boundary():
    # Only 2 prior invoices -> Must return INSUFFICIENT_HISTORY
    req = PaymentDelayAnalysisRequest(
        request_id="req_test_03",
        business_id="10000000-0000-4000-8000-000000000001",
        forecast_run_id="a0000000-0000-4000-8000-000000000001",
        as_of_date="2026-11-13",
        receivables=[
            ReceivableDelayInput(
                receivable_id="70000000-0000-4000-8000-000000000002",
                customer_id="30000000-0000-4000-8000-000000000001",
                due_date="2026-11-20",
                outstanding_paise="2000000",
                settled_invoice_delays_days=[2, 4],  # < 3
            )
        ],
    )

    res = PaymentDelayEngine.analyze_delays(req)
    assert len(res.assessments) == 1
    assert res.assessments[0].delay_status == "INSUFFICIENT_HISTORY"

def test_payment_delay_with_sufficient_history():
    # 4 prior invoices with delays [2, 4, 6, 4] -> median is 4
    req = PaymentDelayAnalysisRequest(
        request_id="req_test_04",
        business_id="10000000-0000-4000-8000-000000000001",
        forecast_run_id="a0000000-0000-4000-8000-000000000001",
        as_of_date="2026-11-13",
        receivables=[
            ReceivableDelayInput(
                receivable_id="70000000-0000-4000-8000-000000000002",
                customer_id="30000000-0000-4000-8000-000000000001",
                due_date="2026-11-20",
                outstanding_paise="2000000",
                settled_invoice_delays_days=[2, 4, 6, 4],
            )
        ],
    )

    res = PaymentDelayEngine.analyze_delays(req)
    assert len(res.assessments) == 1
    a = res.assessments[0]
    assert a.delay_status == "DELAY_RISK"
    assert a.expected_delay_days == 4
    assert a.estimated_collection_date == "2026-11-24"

def test_what_if_simulation_early_receipt():
    # Moving customer receipt from Nov 24 to Nov 19 fixes the Nov 21 rent crunch!
    req = SimulationRequest(
        request_id="req_test_05",
        business_id="10000000-0000-4000-8000-000000000001",
        baseline_forecast_run_id="a0000000-0000-4000-8000-000000000001",
        minimum_cash_buffer_paise="1500000",  # ₹15,000 buffer
        baseline_points=[
            BaselinePoint(forecast_date="2026-11-18", closing_paise="2200000"),
            BaselinePoint(forecast_date="2026-11-21", closing_paise="400000"),   # Crunch!
            BaselinePoint(forecast_date="2026-11-24", closing_paise="2400000"),
        ],
        assumptions=[
            SimulationAssumption(
                assumption_type="EARLIER_RECEIPT",
                date_override="2026-11-19",
                amount_delta_paise="2000000",
                assumption_snapshot={"original_date": "2026-11-24", "amount_paise": "2000000"},
            )
        ],
    )

    res = SimulationEngine.compute_simulation(req)
    nov21_point = next(p for p in res.points if p.forecast_date == "2026-11-21")
    assert nov21_point.baseline_closing_paise == "400000"
    assert nov21_point.scenario_closing_paise == "2400000"  # ₹24,000
    assert nov21_point.difference_paise == "2000000"
    assert nov21_point.buffer_breached is False  # Crunch averted!
