from datetime import datetime, timedelta
from typing import Dict, List, Tuple
from app.schemas.forecast import (
    ForecastRequest,
    ForecastResponse,
    ForecastPointOutput,
    EvidenceOutput,
)

class ForecastingEngine:
    @staticmethod
    def compute_forecast(req: ForecastRequest) -> ForecastResponse:
        as_of_dt = datetime.strptime(req.business_as_of_date, "%Y-%m-%d")
        horizon = req.horizon_days

        opening_confirmed = int(req.opening_confirmed_paise)
        opening_estimated = int(req.opening_estimated_paise)
        buffer_threshold = int(req.minimum_cash_buffer_paise)

        # Generate consecutive horizon dates
        forecast_dates: List[str] = [
            (as_of_dt + timedelta(days=i + 1)).strftime("%Y-%m-%d")
            for i in range(horizon)
        ]

        # Group confirmed movements by date
        conf_in: Dict[str, int] = {d: 0 for d in forecast_dates}
        conf_out: Dict[str, int] = {d: 0 for d in forecast_dates}
        evidence_list: List[EvidenceOutput] = []

        for m in req.confirmed_movements:
            amt = int(m.amount_paise)
            d = m.date
            if d in conf_in:
                if m.direction == "INFLOW":
                    conf_in[d] += amt
                else:
                    conf_out[d] += amt

                evidence_list.append(
                    EvidenceOutput(
                        event_id=m.event_id,
                        source_type=m.source_type,
                        certainty="CONFIRMED",
                        movement_date=m.date,
                        direction=m.direction,
                        amount_paise=m.amount_paise,
                        label_snapshot=m.label_snapshot or f"Confirmed {m.source_type}",
                        forecast_date=d,
                    )
                )

        # Group estimated movements by date
        est_in: Dict[str, int] = {d: 0 for d in forecast_dates}
        est_out: Dict[str, int] = {d: 0 for d in forecast_dates}

        for m in req.estimated_movements:
            amt = int(m.amount_paise)
            d = m.date
            if d in est_in:
                if m.direction == "INFLOW":
                    est_in[d] += amt
                else:
                    est_out[d] += amt

                evidence_list.append(
                    EvidenceOutput(
                        event_id=m.event_id,
                        source_type=m.source_type,
                        certainty="ESTIMATED",
                        movement_date=m.date,
                        direction=m.direction,
                        amount_paise=m.amount_paise,
                        label_snapshot=m.label_snapshot or f"Estimated {m.source_type}",
                        forecast_date=d,
                    )
                )

        # Day by day roll-forward
        curr_conf = opening_confirmed
        curr_est = opening_confirmed + opening_estimated

        points: List[ForecastPointOutput] = []
        for d in forecast_dates:
            ci = conf_in[d]
            co = conf_out[d]
            ei = est_in[d]
            eo = est_out[d]

            curr_conf = curr_conf + ci - co
            curr_est = curr_est + ci + ei - co - eo
            curr_pred = curr_est  # MVP: no model residual added unless justified

            # Uncertainty band evaluation
            est_vol = abs(ei) + abs(eo)
            conf_vol = abs(ci) + abs(co)
            if est_vol == 0 and conf_vol >= 0:
                band = "LOW"
            elif est_vol <= conf_vol:
                band = "MEDIUM"
            else:
                band = "HIGH"

            points.append(
                ForecastPointOutput(
                    forecast_date=d,
                    confirmed_inflow_paise=str(ci),
                    confirmed_outflow_paise=str(co),
                    estimated_inflow_paise=str(ei),
                    estimated_outflow_paise=str(eo),
                    predicted_inflow_paise="0",
                    predicted_outflow_paise="0",
                    closing_confirmed_paise=str(curr_conf),
                    closing_with_estimates_paise=str(curr_est),
                    closing_predicted_paise=str(curr_pred),
                    uncertainty_band=band,
                )
            )

        data_quality = "SUFFICIENT"
        if len(req.confirmed_movements) == 0 and len(req.estimated_movements) == 0:
            data_quality = "LIMITED"

        return ForecastResponse(
            contract_version=req.contract_version,
            request_id=req.request_id,
            forecast_run_id=req.forecast_run_id,
            method_name="DETERMINISTIC_ROLL_FORWARD",
            method_version="1.0",
            service_version="1.0.0",
            data_quality=data_quality,
            points=points,
            evidence=evidence_list,
        )
