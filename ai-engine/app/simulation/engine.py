from typing import List, Dict
from app.schemas.simulation import (
    SimulationRequest,
    SimulationResponse,
    SimulationPointOutput,
)

class SimulationEngine:
    @staticmethod
    def compute_simulation(req: SimulationRequest) -> SimulationResponse:
        buffer_threshold = int(req.minimum_cash_buffer_paise)

        # Map dates to baseline closing balances
        dates: List[str] = [p.forecast_date for p in req.baseline_points]
        baseline_map: Dict[str, int] = {
            p.forecast_date: int(p.closing_paise) for p in req.baseline_points
        }

        # Daily cumulative delta applied to the baseline
        # A change on date D affects all dates >= D
        daily_delta: Dict[str, int] = {d: 0 for d in dates}

        for assump in req.assumptions:
            atype = assump.assumption_type
            snap = assump.assumption_snapshot or {}

            if atype == "EARLIER_RECEIPT":
                # Movement moved from original date to earlier date
                new_date = assump.date_override
                orig_date = snap.get("original_date")
                amount = int(assump.amount_delta_paise or snap.get("amount_paise", "0"))

                if new_date and amount > 0:
                    for d in dates:
                        # If date is on/after new_date and before original date, cash is higher by amount
                        if orig_date:
                            if new_date <= d < orig_date:
                                daily_delta[d] += amount
                        else:
                            if d >= new_date:
                                daily_delta[d] += amount

            elif atype == "DELAYED_RECEIPT":
                # Movement delayed to later date
                new_date = assump.date_override
                orig_date = snap.get("original_date")
                amount = int(assump.amount_delta_paise or snap.get("amount_paise", "0"))

                if orig_date and new_date and amount > 0:
                    for d in dates:
                        # Cash is lower between original date and new date
                        if orig_date <= d < new_date:
                            daily_delta[d] -= amount

            elif atype == "EXPENSE_CHANGE":
                change_date = assump.date_override or dates[0]
                delta = int(assump.amount_delta_paise or "0")
                for d in dates:
                    if d >= change_date:
                        # If expense increases (positive delta), cash balance decreases
                        daily_delta[d] -= delta

            elif atype == "NEW_PURCHASE":
                purchase_date = assump.date_override or dates[0]
                cost = int(assump.amount_delta_paise or snap.get("amount_paise", "0"))
                for d in dates:
                    if d >= purchase_date:
                        daily_delta[d] -= abs(cost)

            elif atype == "MANUAL_CASH_MOVEMENT":
                mdate = assump.date_override or dates[0]
                direction = snap.get("direction", "INFLOW")
                amt = int(assump.amount_delta_paise or snap.get("amount_paise", "0"))
                signed_amt = amt if direction == "INFLOW" else -amt
                for d in dates:
                    if d >= mdate:
                        daily_delta[d] += signed_amt

        # Construct simulation points
        sim_points: List[SimulationPointOutput] = []
        for d in dates:
            base_val = baseline_map[d]
            scen_val = base_val + daily_delta[d]
            diff = scen_val - base_val

            sim_points.append(
                SimulationPointOutput(
                    forecast_date=d,
                    baseline_closing_paise=str(base_val),
                    scenario_closing_paise=str(scen_val),
                    difference_paise=str(diff),
                    buffer_breached=(scen_val < buffer_threshold),
                )
            )

        return SimulationResponse(
            contract_version=req.contract_version,
            request_id=req.request_id,
            baseline_forecast_run_id=req.baseline_forecast_run_id,
            points=sim_points,
            hypothetical=True,
        )
