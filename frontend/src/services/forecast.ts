import { frontendEnv } from '../config/env';
import { getAccessToken } from './auth';

export interface ForecastPoint {
  forecast_date: string;
  confirmed_inflow_paise: string;
  confirmed_outflow_paise: string;
  estimated_inflow_paise: string;
  estimated_outflow_paise: string;
  predicted_inflow_paise: string;
  predicted_outflow_paise: string;
  closing_confirmed_paise: string;
  closing_with_estimates_paise: string;
  closing_predicted_paise: string;
  predicted_low_paise?: string;
  predicted_high_paise?: string;
  uncertainty_band: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface RiskAlert {
  id: string;
  alert_type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  status: string;
  projected_date: string;
  threshold_paise: string;
  projected_balance_paise: string;
  title: string;
  explanation: string;
}

export type ExplanationCategory =
  | 'PAYABLE_OBLIGATION'
  | 'EXPECTED_RECEIVABLE'
  | 'BUFFER_BREACH'
  | 'NEGATIVE_CASH'
  | 'INSUFFICIENT_HISTORY'
  | 'CASH_FLOW_IMPROVEMENT'
  | 'NO_MOVEMENTS';

export interface FinancialExplanation {
  id: string;
  category: ExplanationCategory;
  title: string;
  text: string;
  date: string | null;
  amount_paise: string | null;
  certainty: 'CONFIRMED' | 'ESTIMATED' | null;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  source_type: 'PAYABLE' | 'RECEIVABLE' | 'RISK_ALERT' | 'FORECAST_RUN' | 'DATA_REQUIREMENT' | 'BALANCE';
  event_id?: string | null;
}

export interface ForecastRunSummary {
  opening_cash_paise: string;
  projected_closing_paise: string;
  minimum_buffer_paise: string;
  points_count: number;
  has_buffer_breach: boolean;
  earliest_breach_date: string | null;
}

export interface ForecastRun {
  id: string;
  business_id: string;
  business_as_of_date: string;
  requested_at: string;
  horizon_days: number;
  opening_confirmed_paise: string;
  minimum_cash_buffer_paise: string;
  method_name: string;
  method_version: string;
  data_quality: 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';
  points: ForecastPoint[];
  alerts: RiskAlert[];
  explanations?: FinancialExplanation[];
}

export interface InsufficientHistoryData {
  has_sufficient_history: false;
  status: 'INSUFFICIENT_HISTORY';
  calendar_days_coverage: number;
  min_calendar_days_required: number;
  distinct_days_recorded: number;
  min_distinct_days_required: number;
  transaction_count: number;
  min_transactions_required: number;
  earliest_transaction_date?: string;
  latest_transaction_date?: string;
  message: string;
  explanations?: FinancialExplanation[];
}

export interface SufficientForecastData {
  has_sufficient_history: true;
  status: 'SUCCEEDED';
  run: ForecastRun;
  summary: ForecastRunSummary;
  explanations?: FinancialExplanation[];
}

export type ForecastLatestResponse = InsufficientHistoryData | SufficientForecastData;

export interface GenerateForecastParams {
  horizon_days?: number;
  as_of_date?: string;
}

interface ApiResponse<T> {
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

async function authFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  if (!token) {
    throw new Error('You must be signed in to access forecast data.');
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    ...((options.headers as Record<string, string>) || {}),
  };

  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${frontendEnv.API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const payload: ApiResponse<T> = await response.json();

  if (!response.ok || payload.error) {
    const errorMsg = payload.error?.message || `Request failed with status ${response.status}`;
    throw new Error(errorMsg);
  }

  return payload.data;
}

export async function fetchLatestForecast(): Promise<ForecastLatestResponse> {
  return authFetch<ForecastLatestResponse>('/forecasts/latest');
}

export async function generateForecast(
  params?: GenerateForecastParams
): Promise<ForecastLatestResponse> {
  return authFetch<ForecastLatestResponse>('/forecasts/generate', {
    method: 'POST',
    body: JSON.stringify(params || { horizon_days: 30 }),
  });
}

export {
  simulateForecast,
  type ScenarioType,
  type SimulationRequest,
  type SimulationResult,
  type BaselinePointOutput,
  type SimulatedPointOutput,
} from './simulation';
