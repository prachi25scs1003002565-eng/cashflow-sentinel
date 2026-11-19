import { frontendEnv } from '../config/env';
import { getAccessToken } from './auth';

export type ScenarioType =
  | 'DELAYED_RECEIPT'
  | 'EARLIER_RECEIPT'
  | 'NEW_PURCHASE'
  | 'EXPENSE_CHANGE'
  | 'MANUAL_CASH_MOVEMENT';

export interface SimulationRequest {
  baseline_forecast_id?: string;
  scenario_type: ScenarioType;
  amount?: number | string;
  amount_paise?: string | number;
  date?: string;
  original_date?: string;
  new_date?: string;
  delay_days?: number;
  direction?: 'INFLOW' | 'OUTFLOW';
  description?: string;
  label?: string;
  target_id?: string;
}

export interface BaselinePointOutput {
  forecast_date: string;
  closing_paise: string;
  closing_rupees: number;
}

export interface SimulatedPointOutput {
  forecast_date: string;
  baseline_closing_paise: string;
  baseline_closing_rupees: number;
  simulated_closing_paise: string;
  simulated_closing_rupees: number;
  difference_paise: string;
  difference_rupees: number;
  buffer_breached: boolean;
}

export interface SimulationResult {
  baseline_forecast_id: string;
  scenario_type: ScenarioType;
  scenario_summary: string;
  baseline_points: BaselinePointOutput[];
  simulated_points: SimulatedPointOutput[];
  closing_balance_difference_paise: string;
  closing_balance_difference_rupees: number;
  baseline_risk_status: 'PROTECTED' | 'AT_RISK' | 'CRITICAL';
  simulated_risk_status: 'PROTECTED' | 'AT_RISK' | 'CRITICAL';
  generated_at: string;
}

interface ApiResponse<T> {
  success?: boolean;
  data: T;
  meta?: {
    request_id?: string;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Dispatches a What-If simulation request to the backend.
 */
export async function simulateForecast(params: SimulationRequest): Promise<SimulationResult> {
  const token = getAccessToken();
  if (!token) {
    throw new Error('You must be signed in to run What-If simulations.');
  }

  const response = await fetch(`${frontendEnv.API_BASE_URL}/forecasts/simulate`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
  });

  const payload: ApiResponse<SimulationResult> = await response.json();

  if (!response.ok || payload.error) {
    const errorMsg = payload.error?.message || `Simulation failed with status ${response.status}`;
    throw new Error(errorMsg);
  }

  return payload.data;
}
