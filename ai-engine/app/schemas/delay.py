from typing import List, Literal, Optional
from app.compat import BaseModel

class ReceivableDelayInput(BaseModel):
    receivable_id: str
    customer_id: str
    due_date: str
    expected_collection_date: Optional[str] = None
    outstanding_paise: str
    days_overdue: int = 0
    settled_invoice_delays_days: List[int] = []

class PaymentDelayAnalysisRequest(BaseModel):
    contract_version: str = "1"
    request_id: str
    business_id: str
    forecast_run_id: str
    as_of_date: str
    receivables: List[ReceivableDelayInput]

class CustomerDelayAssessment(BaseModel):
    receivable_id: str
    delay_status: Literal['ON_TIME', 'DELAY_RISK', 'INSUFFICIENT_HISTORY']
    expected_delay_days: int
    estimated_collection_date: str
    confidence: Literal['LOW', 'MEDIUM', 'HIGH']
    explanation: str
    evidence: dict

class PaymentDelayAnalysisResponse(BaseModel):
    contract_version: str = "1"
    request_id: str
    forecast_run_id: str
    assessments: List[CustomerDelayAssessment]
