from typing import List, Optional, Literal
from app.compat import BaseModel, Field

class MovementInput(BaseModel):
    event_id: str
    source_type: Literal['PAYABLE', 'RECEIVABLE', 'RECURRING_OCCURRENCE', 'MANUAL_ASSUMPTION']
    date: str
    direction: Literal['INFLOW', 'OUTFLOW']
    amount_paise: str
    label_snapshot: Optional[str] = None

class HistoryPoint(BaseModel):
    date: str
    inflow_paise: str
    outflow_paise: str

class ForecastRequest(BaseModel):
    contract_version: str = "1"
    request_id: str
    business_id: str
    forecast_run_id: str
    as_of_at: str
    business_as_of_date: str
    timezone: str = "Asia/Kolkata"
    horizon_days: int = Field(default=30, ge=1, le=90)
    opening_confirmed_paise: str
    opening_estimated_paise: str = "0"
    minimum_cash_buffer_paise: str = "0"
    history: List[HistoryPoint] = []
    confirmed_movements: List[MovementInput] = []
    estimated_movements: List[MovementInput] = []

class ForecastPointOutput(BaseModel):
    forecast_date: str
    confirmed_inflow_paise: str
    confirmed_outflow_paise: str
    estimated_inflow_paise: str
    estimated_outflow_paise: str
    predicted_inflow_paise: str = "0"
    predicted_outflow_paise: str = "0"
    closing_confirmed_paise: str
    closing_with_estimates_paise: str
    closing_predicted_paise: str
    predicted_low_paise: Optional[str] = None
    predicted_high_paise: Optional[str] = None
    uncertainty_band: Literal['LOW', 'MEDIUM', 'HIGH']

class EvidenceOutput(BaseModel):
    event_id: str
    source_type: str
    certainty: Literal['CONFIRMED', 'ESTIMATED', 'PREDICTED']
    movement_date: str
    direction: Literal['INFLOW', 'OUTFLOW']
    amount_paise: str
    label_snapshot: str
    forecast_date: str

class ForecastResponse(BaseModel):
    contract_version: str = "1"
    request_id: str
    forecast_run_id: str
    method_name: str = "DETERMINISTIC_ROLL_FORWARD"
    method_version: str = "1.0"
    service_version: str = "1.0.0"
    data_quality: Literal['SUFFICIENT', 'LIMITED', 'INSUFFICIENT']
    points: List[ForecastPointOutput]
    evidence: List[EvidenceOutput]
