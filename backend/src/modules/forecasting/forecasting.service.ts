import crypto from 'crypto';
import { Database } from '../../db';
import { env } from '../../config/env';
import { AccountsService } from '../accounts/accounts.service';
import { AuditLogger } from '../../middleware/audit';
import { ExplanationService, FinancialExplanation } from './explanation.service';

function toIsoDateOnly(val: any): string {
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

export interface DataSufficiencyResult {
  has_sufficient_history: boolean;
  status: 'SUFFICIENT_HISTORY' | 'INSUFFICIENT_HISTORY';
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

export interface MovementInput {
  event_id: string;
  source_type: 'PAYABLE' | 'RECEIVABLE' | 'RECURRING_OCCURRENCE' | 'MANUAL_ASSUMPTION';
  date: string;
  direction: 'INFLOW' | 'OUTFLOW';
  amount_paise: string;
  label_snapshot: string;
}

export interface HistoryPoint {
  date: string;
  inflow_paise: string;
  outflow_paise: string;
}

export interface ForecastPointOutput {
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

export interface RiskAlertOutput {
  id: string;
  alert_type: string;
  severity: string;
  status: string;
  projected_date: string;
  threshold_paise: string;
  projected_balance_paise: string;
  title: string;
  explanation: string;
}

export class ForecastingService {
  /**
   * Evaluates historical coverage and transaction density.
   * Requires:
   * 1. At least 14 calendar days of usable historical coverage (span between earliest and latest transaction).
   * 2. Sufficient actual transaction data (at least 7 active transaction days and at least 7 transactions).
   */
  static async checkDataSufficiency(
    businessId: string,
    asOfDateStr: string
  ): Promise<DataSufficiencyResult> {
    const res = await Database.query(
      `SELECT 
        COUNT(DISTINCT transaction_date) as distinct_days_recorded,
        MIN(transaction_date) as earliest_transaction_date,
        MAX(transaction_date) as latest_transaction_date,
        COUNT(*) as transaction_count
       FROM transactions
       WHERE business_id = $1 
         AND record_status = 'POSTED'
         AND transaction_date <= $2`,
      [businessId, asOfDateStr]
    );

    const row = res.rows[0];
    const transactionCount = parseInt(row.transaction_count || '0', 10);
    const distinctDaysRecorded = parseInt(row.distinct_days_recorded || '0', 10);

    const MIN_CALENDAR_DAYS_REQUIRED = 14;
    const MIN_DISTINCT_DAYS_REQUIRED = 7;
    const MIN_TRANSACTIONS_REQUIRED = 7;

    if (transactionCount === 0 || !row.earliest_transaction_date || !row.latest_transaction_date) {
      const explanation = ExplanationService.buildInsufficientHistoryExplanation({
        calendarDaysCoverage: 0,
        minCalendarDays: MIN_CALENDAR_DAYS_REQUIRED,
        distinctDaysRecorded: 0,
        minDistinctDays: MIN_DISTINCT_DAYS_REQUIRED,
        transactionCount: 0,
        minTransactions: MIN_TRANSACTIONS_REQUIRED,
      });

      return {
        has_sufficient_history: false,
        status: 'INSUFFICIENT_HISTORY',
        calendar_days_coverage: 0,
        min_calendar_days_required: MIN_CALENDAR_DAYS_REQUIRED,
        distinct_days_recorded: 0,
        min_distinct_days_required: MIN_DISTINCT_DAYS_REQUIRED,
        transaction_count: 0,
        min_transactions_required: MIN_TRANSACTIONS_REQUIRED,
        message:
          'No posted transactions found. At least 14 calendar days of usable historical coverage and sufficient actual transaction data are required.',
        explanations: [explanation],
      };
    }

    const earliestStr = toIsoDateOnly(row.earliest_transaction_date);
    const latestStr = toIsoDateOnly(row.latest_transaction_date);

    const earliestDate = new Date(`${earliestStr}T00:00:00Z`);
    const latestDate = new Date(`${latestStr}T00:00:00Z`);

    const calendarDaysCoverage =
      Math.floor((latestDate.getTime() - earliestDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    const hasSufficientCoverage = calendarDaysCoverage >= MIN_CALENDAR_DAYS_REQUIRED;
    const hasSufficientDensity =
      distinctDaysRecorded >= MIN_DISTINCT_DAYS_REQUIRED &&
      transactionCount >= MIN_TRANSACTIONS_REQUIRED;

    const isSufficient = hasSufficientCoverage && hasSufficientDensity;

    if (!isSufficient) {
      const explanation = ExplanationService.buildInsufficientHistoryExplanation({
        calendarDaysCoverage,
        minCalendarDays: MIN_CALENDAR_DAYS_REQUIRED,
        distinctDaysRecorded,
        minDistinctDays: MIN_DISTINCT_DAYS_REQUIRED,
        transactionCount,
        minTransactions: MIN_TRANSACTIONS_REQUIRED,
      });

      return {
        has_sufficient_history: false,
        status: 'INSUFFICIENT_HISTORY',
        calendar_days_coverage: calendarDaysCoverage,
        min_calendar_days_required: MIN_CALENDAR_DAYS_REQUIRED,
        distinct_days_recorded: distinctDaysRecorded,
        min_distinct_days_required: MIN_DISTINCT_DAYS_REQUIRED,
        transaction_count: transactionCount,
        min_transactions_required: MIN_TRANSACTIONS_REQUIRED,
        earliest_transaction_date: earliestStr,
        latest_transaction_date: latestStr,
        message: `At least 14 calendar days of usable historical coverage and sufficient actual transaction data are required. Current coverage: ${calendarDaysCoverage} calendar day(s) across ${distinctDaysRecorded} active transaction day(s) (${transactionCount} transactions).`,
        explanations: [explanation],
      };
    }

    return {
      has_sufficient_history: true,
      status: 'SUFFICIENT_HISTORY',
      calendar_days_coverage: calendarDaysCoverage,
      min_calendar_days_required: MIN_CALENDAR_DAYS_REQUIRED,
      distinct_days_recorded: distinctDaysRecorded,
      min_distinct_days_required: MIN_DISTINCT_DAYS_REQUIRED,
      transaction_count: transactionCount,
      min_transactions_required: MIN_TRANSACTIONS_REQUIRED,
      earliest_transaction_date: earliestStr,
      latest_transaction_date: latestStr,
      message: 'Sufficient historical coverage available for cash-flow forecasting.',
    };
  }

  /**
   * Retrieves aggregated historical daily inflows and outflows.
   */
  static async getHistoricalDailyPoints(
    businessId: string,
    asOfDateStr: string
  ): Promise<HistoryPoint[]> {
    const res = await Database.query(
      `SELECT 
        transaction_date,
        COALESCE(SUM(CASE WHEN cash_direction = 'INFLOW' THEN amount_paise ELSE 0 END), 0) as daily_inflow_paise,
        COALESCE(SUM(CASE WHEN cash_direction = 'OUTFLOW' THEN amount_paise ELSE 0 END), 0) as daily_outflow_paise
       FROM transactions
       WHERE business_id = $1 
         AND record_status = 'POSTED'
         AND transaction_date <= $2
       GROUP BY transaction_date
       ORDER BY transaction_date ASC`,
      [businessId, asOfDateStr]
    );

    return res.rows.map((row) => ({
      date: toIsoDateOnly(row.transaction_date),
      inflow_paise: row.daily_inflow_paise.toString(),
      outflow_paise: row.daily_outflow_paise.toString(),
    }));
  }

  /**
   * Retrieves ONLY genuine, verified, persisted scheduled movements (payables and receivables).
   * Does not fabricate synthetic scheduled movements.
   */
  static async getVerifiedScheduledMovements(
    businessId: string,
    startDateStr: string,
    endDateStr: string
  ): Promise<{ confirmed: MovementInput[]; estimated: MovementInput[] }> {
    const confirmed: MovementInput[] = [];
    const estimated: MovementInput[] = [];

    // 1. Verified payables
    const payablesRes = await Database.query(
      `SELECT 
        p.id as event_id,
        p.expected_payment_date as movement_date,
        p.expected_certainty as certainty,
        (sb.total_paise - COALESCE(alloc.allocated_paise, 0)) as remaining_paise,
        COALESCE(s.display_name, 'Supplier Bill') as label_snapshot
       FROM payables p
       JOIN supplier_bills sb ON sb.business_id = p.business_id AND sb.id = p.bill_id
       LEFT JOIN suppliers s ON s.business_id = p.business_id AND s.id = sb.supplier_id
       LEFT JOIN (
         SELECT business_id, payable_id, SUM(amount_paise) as allocated_paise
         FROM payable_payment_allocations
         GROUP BY business_id, payable_id
       ) alloc ON alloc.business_id = p.business_id AND alloc.payable_id = p.id
       WHERE p.business_id = $1
         AND p.payment_state = 'OPEN'
         AND p.expected_payment_date >= $2
         AND p.expected_payment_date <= $3
         AND (sb.total_paise - COALESCE(alloc.allocated_paise, 0)) > 0`,
      [businessId, startDateStr, endDateStr]
    );

    for (const row of payablesRes.rows) {
      const dateStr = toIsoDateOnly(row.movement_date);

      const m: MovementInput = {
        event_id: row.event_id,
        source_type: 'PAYABLE',
        date: dateStr,
        direction: 'OUTFLOW',
        amount_paise: row.remaining_paise.toString(),
        label_snapshot: row.label_snapshot,
      };

      if (row.certainty === 'CONFIRMED') {
        confirmed.push(m);
      } else {
        estimated.push(m);
      }
    }

    // 2. Verified receivables
    const receivablesRes = await Database.query(
      `SELECT 
        r.id as event_id,
        r.expected_collection_date as movement_date,
        r.expected_certainty as certainty,
        (si.total_paise - COALESCE(alloc.allocated_paise, 0)) as remaining_paise,
        COALESCE(c.display_name, 'Customer Invoice') as label_snapshot
       FROM receivables r
       JOIN sales_invoices si ON si.business_id = r.business_id AND si.id = r.invoice_id
       LEFT JOIN customers c ON c.business_id = r.business_id AND c.id = si.customer_id
       LEFT JOIN (
         SELECT business_id, receivable_id, SUM(amount_paise) as allocated_paise
         FROM receivable_payment_allocations
         GROUP BY business_id, receivable_id
       ) alloc ON alloc.business_id = r.business_id AND alloc.receivable_id = r.id
       WHERE r.business_id = $1
         AND r.collection_state = 'OPEN'
         AND r.expected_collection_date >= $2
         AND r.expected_collection_date <= $3
         AND (si.total_paise - COALESCE(alloc.allocated_paise, 0)) > 0`,
      [businessId, startDateStr, endDateStr]
    );

    for (const row of receivablesRes.rows) {
      const dateStr = toIsoDateOnly(row.movement_date);

      const m: MovementInput = {
        event_id: row.event_id,
        source_type: 'RECEIVABLE',
        date: dateStr,
        direction: 'INFLOW',
        amount_paise: row.remaining_paise.toString(),
        label_snapshot: row.label_snapshot,
      };

      if (row.certainty === 'CONFIRMED') {
        confirmed.push(m);
      } else {
        estimated.push(m);
      }
    }

    return { confirmed, estimated };
  }

  /**
   * Calls the primary Python analytics engine.
   */
  private static async callPythonEngine(payload: any, timeoutMs: number): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${env.ANALYTICS_SERVICE_URL}/internal/v1/forecasts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.ANALYTICS_SERVICE_TOKEN}`,
          'x-request-id': payload.request_id || 'req_forecast',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Python analytics engine responded with status ${response.status}: ${errorText}`
        );
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Explicit baseline statistical projection.
   * Transparently roll forward verified confirmed and estimated cash movements.
   * Does not fabricate artificial AI confidence scores or synthetic movements.
   */
  static computeBaselineStatisticalProjection(params: {
    asOfDateStr: string;
    horizonDays: number;
    openingConfirmedPaise: bigint;
    openingEstimatedPaise: bigint;
    confirmedMovements: MovementInput[];
    estimatedMovements: MovementInput[];
  }): {
    method_name: string;
    method_version: string;
    service_version: string;
    data_quality: 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';
    points: ForecastPointOutput[];
  } {
    const {
      asOfDateStr,
      horizonDays,
      openingConfirmedPaise,
      openingEstimatedPaise,
      confirmedMovements,
      estimatedMovements,
    } = params;

    const asOfDate = new Date(`${asOfDateStr}T00:00:00Z`);
    const forecastDates: string[] = [];

    for (let i = 1; i <= horizonDays; i++) {
      const d = new Date(asOfDate.getTime() + i * 24 * 60 * 60 * 1000);
      forecastDates.push(d.toISOString().slice(0, 10));
    }

    const confIn: Record<string, bigint> = {};
    const confOut: Record<string, bigint> = {};
    const estIn: Record<string, bigint> = {};
    const estOut: Record<string, bigint> = {};

    for (const d of forecastDates) {
      confIn[d] = 0n;
      confOut[d] = 0n;
      estIn[d] = 0n;
      estOut[d] = 0n;
    }

    for (const m of confirmedMovements) {
      if (confIn[m.date] !== undefined) {
        const amt = BigInt(m.amount_paise);
        if (m.direction === 'INFLOW') {
          confIn[m.date] += amt;
        } else {
          confOut[m.date] += amt;
        }
      }
    }

    for (const m of estimatedMovements) {
      if (estIn[m.date] !== undefined) {
        const amt = BigInt(m.amount_paise);
        if (m.direction === 'INFLOW') {
          estIn[m.date] += amt;
        } else {
          estOut[m.date] += amt;
        }
      }
    }

    let currConf = openingConfirmedPaise;
    let currEst = openingConfirmedPaise + openingEstimatedPaise;

    const points: ForecastPointOutput[] = [];

    for (const d of forecastDates) {
      const ci = confIn[d];
      const co = confOut[d];
      const ei = estIn[d];
      const eo = estOut[d];

      currConf = currConf + ci - co;
      currEst = currEst + ci + ei - co - eo;
      const currPred = currEst;

      // Transparent uncertainty classification based on verified movement volume
      const estVol = (ei < 0n ? -ei : ei) + (eo < 0n ? -eo : eo);
      const confVol = (ci < 0n ? -ci : ci) + (co < 0n ? -co : co);

      let band: 'LOW' | 'MEDIUM' | 'HIGH';
      if (estVol === 0n && confVol >= 0n) {
        band = 'LOW';
      } else if (estVol <= confVol) {
        band = 'MEDIUM';
      } else {
        band = 'HIGH';
      }

      points.push({
        forecast_date: d,
        confirmed_inflow_paise: ci.toString(),
        confirmed_outflow_paise: co.toString(),
        estimated_inflow_paise: ei.toString(),
        estimated_outflow_paise: eo.toString(),
        predicted_inflow_paise: '0',
        predicted_outflow_paise: '0',
        closing_confirmed_paise: currConf.toString(),
        closing_with_estimates_paise: currEst.toString(),
        closing_predicted_paise: currPred.toString(),
        uncertainty_band: band,
      });
    }

    const dataQuality: 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT' =
      confirmedMovements.length === 0 && estimatedMovements.length === 0 ? 'LIMITED' : 'SUFFICIENT';

    return {
      method_name: 'BASELINE_STATISTICAL_ROLL_FORWARD',
      method_version: '1.0',
      service_version: '1.0.0',
      data_quality: dataQuality,
      points,
    };
  }

  /**
   * Generates a 30-day forecast.
   * Primary implementation: Python AI Engine.
   * Fallback: Transparent Baseline Statistical Projection.
   */
  static async generateForecast(
    businessId: string,
    userId: string,
    horizonDays = 30,
    asOfDateOverride?: string,
    requestId = `req_fc_${Date.now()}`
  ) {
    const asOfDateStr = asOfDateOverride || new Date().toISOString().slice(0, 10);
    const nowIso = new Date().toISOString();
    const asOfAtIso = asOfDateOverride
      ? `${asOfDateOverride}T23:59:59.999Z`
      : nowIso;

    // 1. Check data sufficiency (Requires >= 14 calendar days coverage and sufficient actual data)
    const sufficiency = await this.checkDataSufficiency(businessId, asOfDateStr);
    if (!sufficiency.has_sufficient_history) {
      return sufficiency;
    }

    // 2. Fetch business parameters (minimum cash buffer, timezone)
    const bizRes = await Database.query(
      `SELECT id, name, minimum_cash_buffer_paise, timezone, currency_code 
       FROM businesses 
       WHERE id = $1 AND business_status = 'ACTIVE'`,
      [businessId]
    );

    if (bizRes.rows.length === 0) {
      throw new Error('Business not found or inactive.');
    }

    const biz = bizRes.rows[0];
    const minimumBufferPaise = BigInt(biz.minimum_cash_buffer_paise || '0');
    const timezone = biz.timezone || 'Asia/Kolkata';

    // 3. Opening cash position from verified accounts
    const balanceInfo = await AccountsService.getBalances(businessId, asOfAtIso, asOfDateStr);
    const openingConfirmedPaise = BigInt(balanceInfo.total_balance_paise || '0');
    const openingEstimatedPaise = 0n;

    // 4. Historical daily points
    const historyPoints = await this.getHistoricalDailyPoints(businessId, asOfDateStr);

    // 5. Genuine, verified scheduled movements for the horizon
    const horizonEndDate = new Date(
      new Date(`${asOfDateStr}T00:00:00Z`).getTime() + horizonDays * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10);

    const movements = await this.getVerifiedScheduledMovements(
      businessId,
      asOfDateStr,
      horizonEndDate
    );

    const forecastRunId = crypto.randomUUID();

    const requestPayload = {
      contract_version: '1',
      request_id: requestId,
      business_id: businessId,
      forecast_run_id: forecastRunId,
      as_of_at: asOfAtIso,
      business_as_of_date: asOfDateStr,
      timezone,
      horizon_days: horizonDays,
      opening_confirmed_paise: openingConfirmedPaise.toString(),
      opening_estimated_paise: openingEstimatedPaise.toString(),
      minimum_cash_buffer_paise: minimumBufferPaise.toString(),
      history: historyPoints,
      confirmed_movements: movements.confirmed,
      estimated_movements: movements.estimated,
    };

    let forecastResult: {
      method_name: string;
      method_version: string;
      service_version?: string;
      data_quality: 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';
      points: ForecastPointOutput[];
    };

    // 6. Primary implementation: Call Python AI engine
    try {
      forecastResult = await this.callPythonEngine(requestPayload, env.ANALYTICS_TIMEOUT_MS);
    } catch {
      // 7. Transparent Fallback: Baseline statistical roll-forward
      forecastResult = this.computeBaselineStatisticalProjection({
        asOfDateStr,
        horizonDays,
        openingConfirmedPaise,
        openingEstimatedPaise,
        confirmedMovements: movements.confirmed,
        estimatedMovements: movements.estimated,
      });
    }

    // 8. Persist forecast run and points within a transaction
    const snapshotJson = JSON.stringify(requestPayload);
    const snapshotHash = crypto.createHash('sha256').update(snapshotJson).digest('hex');

    await Database.withTransaction(async (client) => {
      // Insert forecast_runs
      await client.query(
        `INSERT INTO forecast_runs (
          id, business_id, requested_by_user_id, requested_at, completed_at, as_of_at, business_as_of_date,
          opening_confirmed_paise, opening_estimated_paise, horizon_days,
          method_name, method_version, service_version,
          input_snapshot, input_snapshot_sha256, data_quality, run_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'SUCCEEDED')`,
        [
          forecastRunId,
          businessId,
          userId,
          nowIso,
          nowIso,
          asOfAtIso,
          asOfDateStr,
          openingConfirmedPaise.toString(),
          openingEstimatedPaise.toString(),
          horizonDays,
          forecastResult.method_name,
          forecastResult.method_version,
          forecastResult.service_version || '1.0.0',
          snapshotJson,
          snapshotHash,
          forecastResult.data_quality,
        ]
      );

      // Insert forecast_points
      for (const p of forecastResult.points) {
        await client.query(
          `INSERT INTO forecast_points (
            business_id, forecast_run_id, forecast_date,
            confirmed_inflow_paise, confirmed_outflow_paise,
            estimated_inflow_paise, estimated_outflow_paise,
            predicted_inflow_paise, predicted_outflow_paise,
            closing_confirmed_paise, closing_with_estimates_paise, closing_predicted_paise,
            uncertainty_band
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            businessId,
            forecastRunId,
            p.forecast_date,
            p.confirmed_inflow_paise,
            p.confirmed_outflow_paise,
            p.estimated_inflow_paise,
            p.estimated_outflow_paise,
            p.predicted_inflow_paise || '0',
            p.predicted_outflow_paise || '0',
            p.closing_confirmed_paise,
            p.closing_with_estimates_paise,
            p.closing_predicted_paise,
            p.uncertainty_band,
          ]
        );
      }

      // 9. Evaluate real buffer breaches and persist risk alerts (Requirement 6)
      if (minimumBufferPaise > 0n) {
        let firstBreach: {
          date: string;
          closingPaise: bigint;
          shortfallPaise: bigint;
        } | null = null;

        for (const p of forecastResult.points) {
          const closingPaise = BigInt(p.closing_with_estimates_paise);
          if (closingPaise < minimumBufferPaise) {
            firstBreach = {
              date: p.forecast_date,
              closingPaise,
              shortfallPaise: minimumBufferPaise - closingPaise,
            };
            break; // Identify the first breach date and avoid duplicate alerts for the same risk event
          }
        }

        if (firstBreach) {
          const isNegative = firstBreach.closingPaise < 0n;
          const severity = isNegative ? 'CRITICAL' : 'WARNING';
          const deduplicationKey = `${businessId}_${forecastRunId}_buffer_breach`;
          const title = `Projected buffer breach on ${firstBreach.date}`;
          const explanation = `Projected balance of ₹${(Number(firstBreach.closingPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} falls ₹${(Number(firstBreach.shortfallPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} below the required operating buffer of ₹${(Number(minimumBufferPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`;

          const existingAlert = await client.query(
            `SELECT id FROM risk_alerts WHERE business_id = $1 AND deduplication_key = $2 LIMIT 1`,
            [businessId, deduplicationKey]
          );

          if (existingAlert.rows.length === 0) {
            await client.query(
              `INSERT INTO risk_alerts (
                business_id, forecast_run_id, alert_type, severity, status,
                projected_date, threshold_paise, projected_balance_paise,
                deduplication_key, title, explanation
              )
              VALUES ($1, $2, 'CASH_BUFFER_BREACH', $3, 'OPEN', $4, $5, $6, $7, $8, $9)`,
              [
                businessId,
                forecastRunId,
                severity,
                firstBreach.date,
                minimumBufferPaise.toString(),
                firstBreach.closingPaise.toString(),
                deduplicationKey,
                title,
                explanation,
              ]
            );
          }
        }
      }
    });

    await AuditLogger.log({
      businessId,
      actorUserId: userId,
      action: 'FORECAST_RUN_COMPLETED',
      entityName: 'forecast_runs',
      entityId: forecastRunId,
      requestId,
      metadata: {
        method_name: forecastResult.method_name,
        points_count: forecastResult.points.length,
        data_quality: forecastResult.data_quality,
      },
    });

    // Fetch generated alerts
    const alertsRes = await Database.query(
      `SELECT id, alert_type, severity, status, projected_date, threshold_paise, projected_balance_paise, title, explanation
       FROM risk_alerts
       WHERE business_id = $1 AND forecast_run_id = $2
       ORDER BY projected_date ASC`,
      [businessId, forecastRunId]
    );

    const formattedAlerts = alertsRes.rows.map((r) => ({
      ...r,
      projected_date: toIsoDateOnly(r.projected_date),
      threshold_paise: r.threshold_paise.toString(),
      projected_balance_paise: r.projected_balance_paise.toString(),
    }));

    const explanations = await ExplanationService.generateExplanations({
      businessId,
      forecastRunId,
      asOfDateStr,
      openingConfirmedPaise,
      minimumBufferPaise,
      points: forecastResult.points,
      movements,
      alerts: formattedAlerts,
    });

    return {
      has_sufficient_history: true,
      status: 'SUCCEEDED',
      run: {
        id: forecastRunId,
        business_id: businessId,
        business_as_of_date: asOfDateStr,
        requested_at: asOfAtIso,
        horizon_days: horizonDays,
        opening_confirmed_paise: openingConfirmedPaise.toString(),
        minimum_cash_buffer_paise: minimumBufferPaise.toString(),
        method_name: forecastResult.method_name,
        method_version: forecastResult.method_version,
        data_quality: forecastResult.data_quality,
        points: forecastResult.points,
        alerts: formattedAlerts,
        explanations,
      },
      summary: {
        opening_cash_paise: openingConfirmedPaise.toString(),
        projected_closing_paise:
          forecastResult.points[forecastResult.points.length - 1]?.closing_predicted_paise ||
          openingConfirmedPaise.toString(),
        minimum_buffer_paise: minimumBufferPaise.toString(),
        points_count: forecastResult.points.length,
        has_buffer_breach: formattedAlerts.length > 0,
        earliest_breach_date: formattedAlerts[0]?.projected_date || null,
      },
      explanations,
    };
  }

  /**
   * Retrieves the latest forecast for the business.
   * If history is insufficient, returns the data sufficiency status.
   */
  static async getLatestForecast(businessId: string, userId: string) {
    const todayStr = new Date().toISOString().slice(0, 10);

    // 1. Data sufficiency check
    const sufficiency = await this.checkDataSufficiency(businessId, todayStr);
    if (!sufficiency.has_sufficient_history) {
      return sufficiency;
    }

    // 2. Query latest successful run
    const runRes = await Database.query(
      `SELECT id, business_id, business_as_of_date, requested_at, horizon_days,
              opening_confirmed_paise, method_name, method_version, data_quality
       FROM forecast_runs
       WHERE business_id = $1 AND run_status = 'SUCCEEDED'
       ORDER BY created_at DESC, requested_at DESC
       LIMIT 1`,
      [businessId]
    );

    if (runRes.rows.length === 0) {
      // No forecast run computed yet; generate one
      return this.generateForecast(businessId, userId, 30, todayStr);
    }

    const run = runRes.rows[0];

    // Load points
    const pointsRes = await Database.query(
      `SELECT forecast_date, confirmed_inflow_paise, confirmed_outflow_paise,
              estimated_inflow_paise, estimated_outflow_paise,
              predicted_inflow_paise, predicted_outflow_paise,
              closing_confirmed_paise, closing_with_estimates_paise, closing_predicted_paise,
              uncertainty_band
       FROM forecast_points
       WHERE business_id = $1 AND forecast_run_id = $2
       ORDER BY forecast_date ASC`,
      [businessId, run.id]
    );

    // Load alerts
    const alertsRes = await Database.query(
      `SELECT id, alert_type, severity, status, projected_date, threshold_paise, projected_balance_paise, title, explanation
       FROM risk_alerts
       WHERE business_id = $1 AND forecast_run_id = $2
       ORDER BY projected_date ASC`,
      [businessId, run.id]
    );

    const formattedAlerts = alertsRes.rows.map((r) => ({
      ...r,
      projected_date: toIsoDateOnly(r.projected_date),
      threshold_paise: r.threshold_paise.toString(),
      projected_balance_paise: r.projected_balance_paise.toString(),
    }));

    const bizRes = await Database.query(
      `SELECT minimum_cash_buffer_paise FROM businesses WHERE id = $1`,
      [businessId]
    );
    const minimumBufferPaise = bizRes.rows[0]?.minimum_cash_buffer_paise?.toString() || '0';

    const runAsOfDateStr =
      run.business_as_of_date instanceof Date
        ? run.business_as_of_date.toISOString().slice(0, 10)
        : String(run.business_as_of_date).slice(0, 10);

    const horizonEndDate = new Date(
      new Date(`${runAsOfDateStr}T00:00:00Z`).getTime() + run.horizon_days * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10);

    const movements = await this.getVerifiedScheduledMovements(
      businessId,
      runAsOfDateStr,
      horizonEndDate
    );

    const mappedPoints = pointsRes.rows.map((p) => ({
      ...p,
      forecast_date:
        p.forecast_date instanceof Date
          ? p.forecast_date.toISOString().slice(0, 10)
          : String(p.forecast_date).slice(0, 10),
      confirmed_inflow_paise: p.confirmed_inflow_paise.toString(),
      confirmed_outflow_paise: p.confirmed_outflow_paise.toString(),
      estimated_inflow_paise: p.estimated_inflow_paise.toString(),
      estimated_outflow_paise: p.estimated_outflow_paise.toString(),
      predicted_inflow_paise: p.predicted_inflow_paise.toString(),
      predicted_outflow_paise: p.predicted_outflow_paise.toString(),
      closing_confirmed_paise: p.closing_confirmed_paise.toString(),
      closing_with_estimates_paise: p.closing_with_estimates_paise.toString(),
      closing_predicted_paise: p.closing_predicted_paise.toString(),
    }));

    const explanations = await ExplanationService.generateExplanations({
      businessId,
      forecastRunId: run.id,
      asOfDateStr: runAsOfDateStr,
      openingConfirmedPaise: BigInt(run.opening_confirmed_paise),
      minimumBufferPaise: BigInt(minimumBufferPaise),
      points: mappedPoints,
      movements,
      alerts: formattedAlerts,
    });

    return {
      has_sufficient_history: true,
      status: 'SUCCEEDED',
      run: {
        id: run.id,
        business_id: run.business_id,
        business_as_of_date: runAsOfDateStr,
        requested_at: run.requested_at,
        horizon_days: run.horizon_days,
        opening_confirmed_paise: run.opening_confirmed_paise.toString(),
        minimum_cash_buffer_paise: minimumBufferPaise,
        method_name: run.method_name,
        method_version: run.method_version,
        data_quality: run.data_quality,
        points: mappedPoints,
        alerts: formattedAlerts,
        explanations,
      },
      summary: {
        opening_cash_paise: run.opening_confirmed_paise.toString(),
        projected_closing_paise:
          pointsRes.rows[pointsRes.rows.length - 1]?.closing_predicted_paise?.toString() ||
          run.opening_confirmed_paise.toString(),
        minimum_buffer_paise: minimumBufferPaise,
        points_count: pointsRes.rows.length,
        has_buffer_breach: formattedAlerts.length > 0,
        earliest_breach_date: formattedAlerts[0]?.projected_date || null,
      },
      explanations,
    };
  }
}
