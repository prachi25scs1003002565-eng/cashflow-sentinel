from typing import List, Optional
import numpy as np
from app.schemas.health import (
    HealthAssessmentRequest,
    HealthAssessmentResponse,
    HealthFactorOutput,
)

class FinancialHealthEngine:
    @staticmethod
    def assess_health(req: HealthAssessmentRequest) -> HealthAssessmentResponse:
        completeness = float(req.input_completeness)
        buffer_threshold = int(req.minimum_cash_buffer_paise)

        # Insufficient data rule
        if completeness < 40.0 or not req.points:
            return HealthAssessmentResponse(
                contract_version=req.contract_version,
                request_id=req.request_id,
                indicator_version="1.0",
                score=None,
                health_band="INSUFFICIENT_DATA",
                input_completeness=req.input_completeness,
                explanation="Input data is too sparse or fresh records are insufficient to compute a reliable cash-flow health indicator.",
                factors=[],
                is_credit_score=False,
            )

        factors: List[HealthFactorOutput] = []
        total_score = 70  # start from neutral baseline

        # 1. Buffer Coverage Factor (max impact: +/- 25 points)
        closing_balances = [int(p.get("closing_with_estimates_paise", "0")) for p in req.points]
        min_balance = min(closing_balances) if closing_balances else 0

        buffer_coverage_ratio = (
            (min_balance / buffer_threshold) if buffer_threshold > 0 else 1.0
        )

        if buffer_coverage_ratio >= 1.5:
            bc_effect = 15
            bc_expl = "Projected minimum balance maintains a comfortable margin above your operating buffer."
        elif buffer_coverage_ratio >= 1.0:
            bc_effect = 5
            bc_expl = "Projected cash remains above operating buffer throughout the 30-day horizon."
        elif buffer_coverage_ratio >= 0.0:
            bc_effect = -15
            bc_expl = "Projected cash dips below your minimum operating buffer on one or more dates."
        else:
            bc_effect = -25
            bc_expl = "Projected cash falls into negative territory. Immediate liquidity risk detected."

        total_score += bc_effect
        factors.append(
            HealthFactorOutput(
                factor_code="BUFFER_COVERAGE",
                measured_value=f"{buffer_coverage_ratio:.2f}",
                measured_amount_paise=str(min_balance),
                effect_points=bc_effect,
                explanation=bc_expl,
                analysis_evidence_ids=[ev.analysis_evidence_id for ev in req.evidence[:2]],
            )
        )

        # 2. Overdue Receivables Factor (impact: 0 to -15 points)
        overdue_paise = int(req.overdue_receivable_total_paise)
        if overdue_paise > 0:
            rec_effect = -10
            rec_expl = f"Overdue customer payments of ₹{overdue_paise / 100:,.2f} are tying up usable cash."
        else:
            rec_effect = 5
            rec_expl = "No overdue customer invoices. Payment collection is on schedule."

        total_score += rec_effect
        factors.append(
            HealthFactorOutput(
                factor_code="RECEIVABLE_DELAYS",
                measured_value=f"₹{overdue_paise / 100:,.2f}",
                measured_amount_paise=str(overdue_paise),
                effect_points=rec_effect,
                explanation=rec_expl,
                analysis_evidence_ids=[],
            )
        )

        # 3. Upcoming Obligations (impact: +/- 10 points)
        obligations_paise = int(req.near_term_obligations_paise)
        if obligations_paise > 0 and min_balance < obligations_paise:
            ob_effect = -8
            ob_expl = "Near-term commitments (rent, supplier bills) represent a high share of available liquidity."
        else:
            ob_effect = 5
            ob_expl = "Near-term commitments are well-proportioned to expected cash."

        total_score += ob_effect
        factors.append(
            HealthFactorOutput(
                factor_code="UPCOMING_OBLIGATIONS",
                measured_value=f"₹{obligations_paise / 100:,.2f}",
                measured_amount_paise=str(obligations_paise),
                effect_points=ob_effect,
                explanation=ob_expl,
                analysis_evidence_ids=[],
            )
        )

        # 4. Input Freshness
        if completeness >= 80.0:
            fresh_effect = 5
            fresh_expl = "High record completeness. Forecast accuracy and evidence coverage are strong."
        else:
            fresh_effect = -5
            fresh_expl = "Moderate record completeness. Updating balances will improve resilience insights."

        total_score += fresh_effect
        factors.append(
            HealthFactorOutput(
                factor_code="INPUT_FRESHNESS",
                measured_value=f"{completeness:.1f}%",
                measured_amount_paise=None,
                effect_points=fresh_effect,
                explanation=fresh_expl,
                analysis_evidence_ids=[],
            )
        )

        final_score = max(0, min(100, total_score))

        if final_score >= 75:
            band = "HEALTHY"
            summary_expl = "Operational cash flow is stable with healthy buffer coverage across the planning horizon."
        elif final_score >= 50:
            band = "WATCH"
            summary_expl = "Near-term commitments or payment timing require active attention to avoid buffer breaches."
        else:
            band = "CRITICAL"
            summary_expl = "High liquidity risk detected. Projected cash falls significantly below your minimum operating buffer."

        return HealthAssessmentResponse(
            contract_version=req.contract_version,
            request_id=req.request_id,
            indicator_version="1.0",
            score=final_score,
            health_band=band,
            input_completeness=req.input_completeness,
            explanation=summary_expl,
            factors=factors,
            is_credit_score=False,
        )
