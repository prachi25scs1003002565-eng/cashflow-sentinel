from typing import List
from app.schemas.risk import (
    RiskAnalysisRequest,
    RiskAnalysisResponse,
    AlertCandidate,
    AlertEvidenceCandidate,
)

class RiskAnalysisEngine:
    @staticmethod
    def analyze_risks(req: RiskAnalysisRequest) -> RiskAnalysisResponse:
        buffer_threshold = int(req.minimum_cash_buffer_paise)
        candidates: List[AlertCandidate] = []

        # Find any points where projected closing cash falls below minimum operating buffer
        for p in req.points:
            proj_balance = int(p.closing_with_estimates_paise)

            if proj_balance < buffer_threshold:
                shortfall = buffer_threshold - proj_balance
                severity = "CRITICAL" if proj_balance < 0 else "WARNING"

                # Link evidence items on or before this date that contributed to the outflow
                linked_evidence: List[AlertEvidenceCandidate] = []
                for ev in req.evidence:
                    if ev.forecast_date <= p.forecast_date and ev.direction == "OUTFLOW":
                        linked_evidence.append(
                            AlertEvidenceCandidate(
                                analysis_evidence_id=ev.analysis_evidence_id,
                                contribution_paise=f"-{ev.amount_paise}",
                                contribution_role="OUTFLOW",
                            )
                        )

                candidates.append(
                    AlertCandidate(
                        alert_type="CASH_BUFFER_BREACH",
                        severity=severity,
                        projected_date=p.forecast_date,
                        threshold_paise=req.minimum_cash_buffer_paise,
                        projected_balance_paise=p.closing_with_estimates_paise,
                        deduplication_key=f"BUFFER:{p.forecast_date}",
                        title="Projected cash may breach operating buffer",
                        explanation=(
                            f"Projected cash of ₹{proj_balance / 100:,.2f} on {p.forecast_date} falls "
                            f"₹{shortfall / 100:,.2f} below your ₹{buffer_threshold / 100:,.2f} operating buffer."
                        ),
                        evidence=linked_evidence,
                    )
                )

        return RiskAnalysisResponse(
            contract_version=req.contract_version,
            request_id=req.request_id,
            candidates=candidates,
        )
