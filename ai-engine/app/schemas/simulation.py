from typing import List, Optional, Literal
from app.compat import BaseModel

class BaselinePoint(BaseModel):
    forecast_date: str
    closing_paise: str

class SimulationAssumption(BaseModel):
    assumption_type: Literal['DELAYED_RECEIPT', 'EARLIER_RECEIPT', 'EXPENSE_CHANGE', 'NEW_PURCHASE', 'MANUAL_CASH_MOVEMENT']
    target_id: Optional[str] = None
    target_type: Optional[str] = None
    amount_delta_paise: Optional[str] = None
    date_override: Optional[str] = None
    assumption_label: Optional[str] = None
    assumption_snapshot: dict = {}

class SimulationRequest(BaseModel):
    contract_version: str = "1"
    request_id: str
    business_id: str
    baseline_forecast_run_id: str
    minimum_cash_buffer_paise: str
    baseline_points: List[BaselinePoint]
    assumptions: List[SimulationAssumption]

class SimulationPointOutput(BaseModel):
    forecast_date: str
    baseline_closing_paise: str
    scenario_closing_paise: str
    difference_paise: str
    buffer_breached: bool

class SimulationResponse(BaseModel):
    contract_version: str = "1"
    request_id: str
    baseline_forecast_run_id: str
    points: List[SimulationPointOutput]
    hypothetical: bool = True
