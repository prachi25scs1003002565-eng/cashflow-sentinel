from typing import List, Optional, Literal
from app.compat import BaseModel

class HealthEvidenceInput(BaseModel):
    analysis_evidence_id: str
    forecast_date: str
    certainty: str
    amount_paise: str

class HealthAssessmentRequest(BaseModel):
    contract_version: str = "1"
    request_id: str
    business_id: str
    forecast_run_id: str
    input_completeness: str
    minimum_cash_buffer_paise: str
    points: List[dict]
    overdue_receivable_total_paise: str = "0"
    near_term_obligations_paise: str = "0"
    evidence: List[HealthEvidenceInput] = []

class HealthFactorOutput(BaseModel):
    factor_code: Literal['BUFFER_COVERAGE', 'RECEIVABLE_DELAYS', 'UPCOMING_OBLIGATIONS', 'CASH_VOLATILITY', 'INPUT_FRESHNESS']
    measured_value: str
    measured_amount_paise: Optional[str] = None
    effect_points: int
    explanation: str
    analysis_evidence_ids: List[str] = []

class HealthAssessmentResponse(BaseModel):
    contract_version: str = "1"
    request_id: str
    indicator_version: str = "1.0"
    score: Optional[int] = None
    health_band: Literal['HEALTHY', 'WATCH', 'CRITICAL', 'INSUFFICIENT_DATA']
    input_completeness: str
    explanation: str
    factors: List[HealthFactorOutput]
    is_credit_score: bool = False
