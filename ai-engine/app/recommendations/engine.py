from typing import List
from app.schemas.recommendation import (
    RecommendationCandidatesRequest,
    RecommendationCandidatesResponse,
    RecommendationCandidate,
)

class RecommendationEngine:
    @staticmethod
    def generate_candidates(req: RecommendationCandidatesRequest) -> RecommendationCandidatesResponse:
        candidates: List[RecommendationCandidate] = []
        rank = 1

        for sig in req.signals:
            if sig.signal_type == "CASH_BUFFER_BREACH":
                shortfall = int(sig.shortfall_paise)

                # Check eligible actions
                for action in sig.eligible_actions:
                    if action.action_type == "CONFIRM_RECEIVABLE":
                        candidates.append(
                            RecommendationCandidate(
                                rule_id="CONFIRM_LARGE_RECEIPT",
                                rule_version="1.0",
                                rank=rank,
                                title="Follow up & confirm expected customer payment",
                                explanation=(
                                    f"A cash shortfall of ₹{shortfall / 100:,.2f} is projected around {sig.forecast_date}. "
                                    f"Confirming customer receipt timing prior to supplier commitments will safeguard your operating buffer."
                                ),
                                expected_effect_paise=action.potential_effect_paise,
                                suggested_by_date=action.suggested_by_date,
                                uncertainty_band="MEDIUM",
                                analysis_evidence_ids=action.analysis_evidence_ids or sig.evidence_ids,
                            )
                        )
                        rank += 1

                # If no specific action supplied, generate generic buffer protection recommendation
                if not sig.eligible_actions:
                    candidates.append(
                        RecommendationCandidate(
                            rule_id="STAGE_SUPPLIER_PAYMENT",
                            rule_version="1.0",
                            rank=rank,
                            title="Review payment timing for upcoming supplier dues",
                            explanation=(
                                f"Projected balance dips below your buffer on {sig.forecast_date}. "
                                f"Test splitting or staging supplier payments in the What-If simulator to maintain cash resilience."
                            ),
                            expected_effect_paise=str(shortfall),
                            suggested_by_date=sig.forecast_date,
                            uncertainty_band="MEDIUM",
                            analysis_evidence_ids=sig.evidence_ids,
                        )
                    )
                    rank += 1

        return RecommendationCandidatesResponse(
            contract_version=req.contract_version,
            request_id=req.request_id,
            forecast_run_id=req.forecast_run_id,
            candidates=candidates,
        )
