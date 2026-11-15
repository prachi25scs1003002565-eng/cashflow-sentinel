from typing import List, Optional, Literal
from app.compat import BaseModel

class SignalAction(BaseModel):
    action_type: str
    target_id: Optional[str] = None
    potential_effect_paise: Optional[str] = None
    suggested_by_date: Optional[str] = None
    analysis_evidence_ids: List[str] = []

class RecommendationSignal(BaseModel):
    signal_type: str
    forecast_date: str
    shortfall_paise: str
    evidence_ids: List[str] = []
    eligible_actions: List[SignalAction] = []

class RecommendationCandidatesRequest(BaseModel):
    contract_version: str = "1"
    request_id: str
    business_id: str
    forecast_run_id: str
    ruleset_version: str = "1.0"
    allowed_rule_ids: List[str] = []
    signals: List[RecommendationSignal] = []

class RecommendationCandidate(BaseModel):
    rule_id: str
    rule_version: str = "1.0"
    rank: int
    title: str
    explanation: str
    expected_effect_paise: Optional[str] = None
    suggested_by_date: Optional[str] = None
    uncertainty_band: Literal['LOW', 'MEDIUM', 'HIGH']
    analysis_evidence_ids: List[str] = []

class RecommendationCandidatesResponse(BaseModel):
    contract_version: str = "1"
    request_id: str
    forecast_run_id: str
    candidates: List[RecommendationCandidate]
