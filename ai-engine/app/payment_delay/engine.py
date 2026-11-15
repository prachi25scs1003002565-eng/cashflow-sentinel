from datetime import datetime, timedelta
import numpy as np
from typing import List
from app.schemas.delay import (
    PaymentDelayAnalysisRequest,
    PaymentDelayAnalysisResponse,
    CustomerDelayAssessment,
)

class PaymentDelayEngine:
    @staticmethod
    def analyze_delays(req: PaymentDelayAnalysisRequest) -> PaymentDelayAnalysisResponse:
        assessments: List[CustomerDelayAssessment] = []

        for rec in req.receivables:
            history = rec.settled_invoice_delays_days

            if not history or len(history) < 3:
                # Insufficient history boundary
                assessments.append(
                    CustomerDelayAssessment(
                        receivable_id=rec.receivable_id,
                        delay_status="INSUFFICIENT_HISTORY",
                        expected_delay_days=0,
                        estimated_collection_date=rec.expected_collection_date or rec.due_date,
                        confidence="LOW",
                        explanation="Fewer than 3 prior settled invoices available. Cannot reliably predict customer delay pattern.",
                        evidence={
                            "settled_invoice_count": len(history) if history else 0,
                            "days_overdue": rec.days_overdue,
                        },
                    )
                )
            else:
                median_delay = int(np.median(history))
                due_dt = datetime.strptime(rec.due_date, "%Y-%m-%d")
                estimated_dt = due_dt + timedelta(days=max(median_delay, 0))
                estimated_date_str = estimated_dt.strftime("%Y-%m-%d")

                status = "DELAY_RISK" if median_delay > 0 else "ON_TIME"
                confidence = "HIGH" if len(history) >= 6 else "MEDIUM"
                explanation = (
                    f"Customer's prior {len(history)} settled invoices were paid a median of "
                    f"{median_delay} days after due date."
                )

                assessments.append(
                    CustomerDelayAssessment(
                        receivable_id=rec.receivable_id,
                        delay_status=status,
                        expected_delay_days=median_delay,
                        estimated_collection_date=estimated_date_str,
                        confidence=confidence,
                        explanation=explanation,
                        evidence={
                            "settled_invoice_count": len(history),
                            "historical_median_days_late": median_delay,
                            "days_overdue": rec.days_overdue,
                        },
                    )
                )

        return PaymentDelayAnalysisResponse(
            contract_version=req.contract_version,
            request_id=req.request_id,
            forecast_run_id=req.forecast_run_id,
            assessments=assessments,
        )
