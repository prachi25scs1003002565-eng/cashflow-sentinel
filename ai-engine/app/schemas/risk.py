from typing import List, Literal, Optional
from app.compat import BaseModel

class RiskPointInput(BaseModel):
    forecast_date: str
    closing_with_estimates_paise: str
    closing_predicted_paise: str
    uncertainty_band: Literal['LOW', 'MEDIUM', 'HIGH']

class RiskEvidenceInput(BaseModel):
    analysis_evidence_id: str
    forecast_date: str
    source_type: str
    certainty: str
    direction: Literal['INFLOW', 'OUTFLOW']
    amount_paise: str
    label_snapshot: str

class RiskAnalysisRequest(BaseModel):
    contract_version: str = "1"
    request_id: str
    business_id: str
    forecast_run_id: str
    minimum_cash_buffer_paise: str
    points: List[RiskPointInput]
    evidence: List[RiskEvidenceInput] = []

class AlertEvidenceCandidate(BaseModel):
    analysis_evidence_id: str
    contribution_paise: str
    contribution_role: str

class AlertCandidate(BaseModel):
    alert_type: Literal['CASH_BUFFER_BREACH', 'RECEIPT_DELAY_RISK', 'LARGE_UPCOMING_EXPENSE', 'LOW_BUFFER_WARNING']
    severity: Literal['INFO', 'WARNING', 'CRITICAL']
    projected_date: str
    threshold_paise: str
    projected_balance_paise: str
    deduplication_key: str
    title: str
    explanation: str
    evidence: List[AlertEvidenceCandidate] = []

class RiskAnalysisResponse(BaseModel):
    contract_version: str = "1"
    request_id: str
    candidates: List[AlertCandidate]
