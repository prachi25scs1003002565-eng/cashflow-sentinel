import { Database } from '../../db';
import { env } from '../../config/env';
import { NotFoundError, ServiceUnavailableError, ValidationError } from '../../utils/errors';
import { AuditLogger } from '../../middleware/audit';
import { SimulationInput, ScenarioType } from './simulation.validators';

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

export interface SimulationResponseData {
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

function toIsoDateOnly(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(val).slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function formatRupees(paise: bigint): string {
  const isNeg = paise < 0n;
  const absP = isNeg ? -paise : paise;
  const num = Number(absP) / 100;
  const formatted = num.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return isNeg ? `-₹${formatted}` : `₹${formatted}`;
}

function determineRiskStatus(
  points: Array<{ closing_paise: bigint }>,
  bufferPaise: bigint
): 'PROTECTED' | 'AT_RISK' | 'CRITICAL' {
  if (points.length === 0) return 'PROTECTED';
  const hasNegative = points.some((p) => p.closing_paise < 0n);
  if (hasNegative) return 'CRITICAL';
  if (bufferPaise > 0n) {
    const hasBreach = points.some((p) => p.closing_paise < bufferPaise);
    if (hasBreach) return 'AT_RISK';
  }
  return 'PROTECTED';
}

export class SimulationService {
  /**
   * Dispatches the simulation request to the Python FastAPI analytics engine.
   */
  private static async callPythonSimulation(payload: unknown, timeoutMs: number): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const baseUrl = process.env.ANALYTICS_SERVICE_URL || env.ANALYTICS_SERVICE_URL;
      const response = await fetch(`${baseUrl}/internal/v1/simulations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.ANALYTICS_SERVICE_TOKEN}`,
          'x-request-id': (payload as any).request_id || 'req_simulation',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Python analytics engine error (${response.status}): ${errorText}`);
      }

      return await response.json();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ServiceUnavailableError('Analytics simulation request timed out. Please try again.');
      }
      throw new ServiceUnavailableError(
        'Analytics simulation engine is currently unavailable. Please verify the AI engine service.'
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Executes a What-If simulation against a verified baseline forecast run.
   */
  static async simulate(
    businessId: string,
    userId: string,
    input: SimulationInput,
    requestId = `req_sim_${Date.now()}`
  ): Promise<SimulationResponseData> {
    // 1. Locate and verify baseline forecast run with strict tenant scoping
    let baselineRunId: string;
    let horizonDays: number;

    if (input.baseline_forecast_id) {
      const runRes = await Database.query(
        `SELECT id, business_id, business_as_of_date, horizon_days, opening_confirmed_paise, run_status
         FROM forecast_runs
         WHERE id = $1 AND business_id = $2`,
        [input.baseline_forecast_id, businessId]
      );

      if (runRes.rows.length === 0) {
        throw new NotFoundError(
          'RESOURCE_NOT_FOUND',
          'Baseline forecast run not found for this business.'
        );
      }
      baselineRunId = runRes.rows[0].id;
      horizonDays = runRes.rows[0].horizon_days;
    } else {
      const latestRes = await Database.query(
        `SELECT id, business_id, business_as_of_date, horizon_days, opening_confirmed_paise, run_status
         FROM forecast_runs
         WHERE business_id = $1 AND run_status = 'SUCCEEDED'
         ORDER BY created_at DESC, requested_at DESC
         LIMIT 1`,
        [businessId]
      );

      if (latestRes.rows.length === 0) {
        throw new NotFoundError(
          'RESOURCE_NOT_FOUND',
          'No baseline forecast run found. Please generate a baseline forecast before running simulations.'
        );
      }
      baselineRunId = latestRes.rows[0].id;
      horizonDays = latestRes.rows[0].horizon_days;
    }

    // 2. Load baseline projection points
    const pointsRes = await Database.query(
      `SELECT forecast_date, closing_predicted_paise, closing_with_estimates_paise, closing_confirmed_paise
       FROM forecast_points
       WHERE business_id = $1 AND forecast_run_id = $2
       ORDER BY forecast_date ASC`,
      [businessId, baselineRunId]
    );

    if (pointsRes.rows.length === 0) {
      throw new NotFoundError(
        'RESOURCE_NOT_FOUND',
        'Baseline forecast has no recorded projection points.'
      );
    }

    // 3. Load operating buffer for business
    const bizRes = await Database.query(
      `SELECT minimum_cash_buffer_paise FROM businesses WHERE id = $1`,
      [businessId]
    );
    const minimumBufferPaise = BigInt(bizRes.rows[0]?.minimum_cash_buffer_paise || '0');

    // 4. Resolve amounts and build Python simulation assumptions
    let assumptions: Array<{
      assumption_type: ScenarioType;
      target_id?: string;
      target_type?: string;
      amount_delta_paise?: string;
      date_override?: string;
      assumption_label?: string;
      assumption_snapshot?: Record<string, unknown>;
    }> = [];

    let scenarioSummary = '';

    if (input.assumptions && input.assumptions.length > 0) {
      assumptions = input.assumptions.map((a) => ({
        assumption_type: a.assumption_type,
        target_id: a.target_id,
        target_type: a.target_type,
        amount_delta_paise: a.amount_delta_paise,
        date_override: a.date_override,
        assumption_label: a.assumption_label,
        assumption_snapshot: a.assumption_snapshot || {},
      }));
      scenarioSummary = `Custom scenario with ${assumptions.length} simultaneous assumption(s).`;
    } else {
      let amountPaise = 0n;
      if (input.amount_paise !== undefined) {
        amountPaise = BigInt(Math.round(Number(input.amount_paise)));
      } else if (input.amount !== undefined) {
        const num = typeof input.amount === 'string' ? parseFloat(input.amount) : input.amount;
        amountPaise = BigInt(Math.round(num * 100));
      }

      switch (input.scenario_type) {
        case 'DELAYED_RECEIPT': {
          const origDate = input.original_date!;
          const newDate =
            input.new_date ||
            input.date ||
            (input.delay_days ? addDays(origDate, input.delay_days) : origDate);

          assumptions.push({
            assumption_type: 'DELAYED_RECEIPT',
            target_id: input.target_id,
            target_type: 'RECEIVABLE',
            amount_delta_paise: amountPaise.toString(),
            date_override: newDate,
            assumption_label: input.label || input.description || 'Delayed Customer Payment',
            assumption_snapshot: {
              original_date: origDate,
              amount_paise: amountPaise.toString(),
            },
          });
          const daysLate = Math.max(
            Math.round(
              (new Date(`${newDate}T00:00:00Z`).getTime() -
                new Date(`${origDate}T00:00:00Z`).getTime()) /
                (1000 * 60 * 60 * 24)
            ),
            1
          );
          scenarioSummary = `Customer receipt of ${formatRupees(amountPaise)} delayed by ${daysLate} day(s) from ${origDate} to ${newDate}.`;
          break;
        }

        case 'EARLIER_RECEIPT': {
          const newDate = input.new_date || input.date!;
          const origDate = input.original_date;

          assumptions.push({
            assumption_type: 'EARLIER_RECEIPT',
            target_id: input.target_id,
            target_type: 'RECEIVABLE',
            amount_delta_paise: amountPaise.toString(),
            date_override: newDate,
            assumption_label: input.label || input.description || 'Earlier Customer Payment',
            assumption_snapshot: {
              original_date: origDate,
              amount_paise: amountPaise.toString(),
            },
          });
          scenarioSummary = `Customer receipt of ${formatRupees(amountPaise)} accelerated to ${newDate}${
            origDate ? ` (originally due ${origDate})` : ''
          }.`;
          break;
        }

        case 'NEW_PURCHASE': {
          const purchaseDate = input.date || input.new_date!;
          assumptions.push({
            assumption_type: 'NEW_PURCHASE',
            amount_delta_paise: amountPaise.toString(),
            date_override: purchaseDate,
            assumption_label: input.label || input.description || 'Unplanned Purchase',
            assumption_snapshot: {
              amount_paise: amountPaise.toString(),
            },
          });
          scenarioSummary = `Unplanned business purchase of ${formatRupees(amountPaise)} on ${purchaseDate}.`;
          break;
        }

        case 'EXPENSE_CHANGE': {
          const changeDate = input.date || input.new_date!;
          assumptions.push({
            assumption_type: 'EXPENSE_CHANGE',
            amount_delta_paise: amountPaise.toString(),
            date_override: changeDate,
            assumption_label: input.label || input.description || 'Expense Adjustment',
            assumption_snapshot: {
              amount_paise: amountPaise.toString(),
            },
          });
          const directionWord = amountPaise > 0n ? 'increased' : 'reduced';
          const absAmount = amountPaise < 0n ? -amountPaise : amountPaise;
          scenarioSummary = `Expected expense ${directionWord} by ${formatRupees(absAmount)} starting on ${changeDate}.`;
          break;
        }

        case 'MANUAL_CASH_MOVEMENT': {
          const mDate = input.date || input.new_date!;
          const dir = input.direction || 'INFLOW';
          assumptions.push({
            assumption_type: 'MANUAL_CASH_MOVEMENT',
            amount_delta_paise: amountPaise.toString(),
            date_override: mDate,
            assumption_label: input.label || input.description || 'Manual Cash Adjustment',
            assumption_snapshot: {
              direction: dir,
              amount_paise: amountPaise.toString(),
            },
          });
          scenarioSummary = `Manual ${dir.toLowerCase()} adjustment of ${formatRupees(amountPaise)} on ${mDate}.`;
          break;
        }
      }
    }

    // 5. Prepare Python analytics request payload
    const baselinePointsForPython = pointsRes.rows.map((row) => ({
      forecast_date: toIsoDateOnly(row.forecast_date),
      closing_paise: (
        row.closing_predicted_paise ??
        row.closing_with_estimates_paise ??
        row.closing_confirmed_paise ??
        '0'
      ).toString(),
    }));

    const pythonPayload = {
      contract_version: '1',
      request_id: requestId,
      business_id: businessId,
      baseline_forecast_run_id: baselineRunId,
      minimum_cash_buffer_paise: minimumBufferPaise.toString(),
      baseline_points: baselinePointsForPython,
      assumptions,
    };

    // 6. Invoke Python analytics engine
    const pythonResult = await this.callPythonSimulation(pythonPayload, env.ANALYTICS_TIMEOUT_MS);

    // 7. Format output points and compute risk statuses
    const baselinePoints: BaselinePointOutput[] = baselinePointsForPython.map((bp) => {
      const paiseBig = BigInt(bp.closing_paise);
      return {
        forecast_date: bp.forecast_date,
        closing_paise: bp.closing_paise,
        closing_rupees: Number(paiseBig) / 100,
      };
    });

    const simulatedPoints: SimulatedPointOutput[] = pythonResult.points.map((p: any) => {
      const basePaise = BigInt(p.baseline_closing_paise);
      const scenPaise = BigInt(p.scenario_closing_paise);
      const diffPaise = BigInt(p.difference_paise);

      return {
        forecast_date: p.forecast_date,
        baseline_closing_paise: p.baseline_closing_paise,
        baseline_closing_rupees: Number(basePaise) / 100,
        simulated_closing_paise: p.scenario_closing_paise,
        simulated_closing_rupees: Number(scenPaise) / 100,
        difference_paise: p.difference_paise,
        difference_rupees: Number(diffPaise) / 100,
        buffer_breached: Boolean(p.buffer_breached),
      };
    });

    const lastSimulated = simulatedPoints[simulatedPoints.length - 1];
    const closingDiffPaise = lastSimulated ? lastSimulated.difference_paise : '0';
    const closingDiffRupees = lastSimulated ? lastSimulated.difference_rupees : 0;

    const baselineRiskStatus = determineRiskStatus(
      baselinePoints.map((p) => ({ closing_paise: BigInt(p.closing_paise) })),
      minimumBufferPaise
    );

    const simulatedRiskStatus = determineRiskStatus(
      simulatedPoints.map((p) => ({ closing_paise: BigInt(p.simulated_closing_paise) })),
      minimumBufferPaise
    );

    // 8. Audit log simulation
    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'FORECAST_SIMULATION_COMPLETED',
      entityName: 'forecast_runs',
      entityId: baselineRunId,
      requestId,
      metadata: {
        scenario_type: input.scenario_type,
        assumptions_count: assumptions.length,
        closing_difference_paise: closingDiffPaise,
        baseline_risk_status: baselineRiskStatus,
        simulated_risk_status: simulatedRiskStatus,
      },
    });

    return {
      baseline_forecast_id: baselineRunId,
      scenario_type: input.scenario_type,
      scenario_summary: scenarioSummary,
      baseline_points: baselinePoints,
      simulated_points: simulatedPoints,
      closing_balance_difference_paise: closingDiffPaise,
      closing_balance_difference_rupees: closingDiffRupees,
      baseline_risk_status: baselineRiskStatus,
      simulated_risk_status: simulatedRiskStatus,
      generated_at: new Date().toISOString(),
    };
  }
}
