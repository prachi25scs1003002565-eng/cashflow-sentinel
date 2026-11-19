import crypto from 'crypto';
import { Database } from '../../db';
import { MovementInput, RiskAlertOutput } from './forecasting.service';

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

export interface InsufficientHistoryExplanationParams {
  calendarDaysCoverage: number;
  minCalendarDays: number;
  distinctDaysRecorded: number;
  minDistinctDays: number;
  transactionCount: number;
  minTransactions: number;
}

export function formatRupees(paise: bigint | string | number): string {
  const p = BigInt(paise);
  const isNeg = p < 0n;
  const absP = isNeg ? -p : p;
  const num = Number(absP) / 100;
  const formatted = num.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return isNeg ? `−${formatted}` : formatted;
}

export class ExplanationService {
  /**
   * Builds explanation for insufficient history.
   */
  static buildInsufficientHistoryExplanation(
    params: InsufficientHistoryExplanationParams
  ): FinancialExplanation {
    const missingItems: string[] = [];
    if (params.calendarDaysCoverage < params.minCalendarDays) {
      missingItems.push(
        `${params.calendarDaysCoverage}/${params.minCalendarDays} calendar days coverage`
      );
    }
    if (params.distinctDaysRecorded < params.minDistinctDays) {
      missingItems.push(
        `${params.distinctDaysRecorded}/${params.minDistinctDays} active transaction days`
      );
    }
    if (params.transactionCount < params.minTransactions) {
      missingItems.push(
        `${params.transactionCount}/${params.minTransactions} posted transactions`
      );
    }

    return {
      id: `exp_insuff_${Date.now()}`,
      category: 'INSUFFICIENT_HISTORY',
      title: 'Historical Transaction Coverage Required',
      text: `Automated forecasting requires at least 14 calendar days of transaction history (currently ${params.calendarDaysCoverage}/14), 7 distinct active transaction days (currently ${params.distinctDaysRecorded}/7), and 7 posted transactions (currently ${params.transactionCount}/7). Missing: ${missingItems.join(', ')}.`,
      date: null,
      amount_paise: null,
      certainty: null,
      severity: 'WARNING',
      source_type: 'DATA_REQUIREMENT',
    };
  }

  /**
   * Generates a comprehensive list of financial explanations for a forecast run.
   */
  static async generateExplanations(params: {
    businessId: string;
    forecastRunId: string;
    asOfDateStr: string;
    openingConfirmedPaise: bigint;
    minimumBufferPaise: bigint;
    points: {
      forecast_date: string;
      closing_confirmed_paise: string;
      closing_with_estimates_paise: string;
      closing_predicted_paise: string;
    }[];
    movements: {
      confirmed: MovementInput[];
      estimated: MovementInput[];
    };
    alerts: RiskAlertOutput[];
  }): Promise<FinancialExplanation[]> {
    const {
      businessId,
      forecastRunId,
      asOfDateStr,
      openingConfirmedPaise,
      minimumBufferPaise,
      points,
      movements,
      alerts,
    } = params;

    const explanations: FinancialExplanation[] = [];
    const allMovements = [
      ...movements.confirmed.map((m) => ({ ...m, certainty: 'CONFIRMED' as const })),
      ...movements.estimated.map((m) => ({ ...m, certainty: 'ESTIMATED' as const })),
    ];

    // 1. Negative Cash Position Detection (Highest Priority)
    let firstNegative: {
      date: string;
      closingPaise: bigint;
    } | null = null;
    let minClosingPaise = openingConfirmedPaise;

    for (const p of points) {
      const closing = BigInt(p.closing_with_estimates_paise);
      if (closing < minClosingPaise) {
        minClosingPaise = closing;
      }
      if (closing < 0n && !firstNegative) {
        firstNegative = {
          date: p.forecast_date,
          closingPaise: closing,
        };
      }
    }

    if (firstNegative) {
      const deficitPaise = -firstNegative.closingPaise;
      explanations.push({
        id: `exp_neg_${forecastRunId}`,
        category: 'NEGATIVE_CASH',
        title: 'Critical Liquidity Deficit: Negative Cash Position',
        text: `Projected cash balance turns negative on ${firstNegative.date}, reaching a deficit of -₹${formatRupees(deficitPaise)} (lowest point -₹${formatRupees(-minClosingPaise)}). Scheduled obligations exceed liquid reserves; payment rescheduling or credit arrangement recommended.`,
        date: firstNegative.date,
        amount_paise: deficitPaise.toString(),
        certainty: 'CONFIRMED',
        severity: 'CRITICAL',
        source_type: 'RISK_ALERT',
      });
    }

    // 2. Cash-Buffer Breach Detection
    const breachAlert = alerts.find((a) => a.alert_type === 'CASH_BUFFER_BREACH');
    if (breachAlert) {
      const projBalance = BigInt(breachAlert.projected_balance_paise);
      const threshold = BigInt(breachAlert.threshold_paise);
      const shortfallPaise = threshold > projBalance ? threshold - projBalance : 0n;

      explanations.push({
        id: `exp_breach_${forecastRunId}`,
        category: 'BUFFER_BREACH',
        title: 'Operating Cash Buffer Breach Expected',
        text: `Projected closing cash dips to ₹${formatRupees(projBalance)} on ${breachAlert.projected_date}, falling ₹${formatRupees(shortfallPaise)} below your required ₹${formatRupees(threshold)} operating cash buffer.`,
        date: breachAlert.projected_date,
        amount_paise: shortfallPaise.toString(),
        certainty: 'CONFIRMED',
        severity: breachAlert.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        source_type: 'RISK_ALERT',
      });
    }

    // 3. Cash-Flow Improvement (Compare with previous forecast run if any)
    try {
      const prevRunRes = await Database.query(
        `SELECT id, opening_confirmed_paise, created_at
         FROM forecast_runs
         WHERE business_id = $1 AND run_status = 'SUCCEEDED' AND id != $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [businessId, forecastRunId]
      );

      if (prevRunRes.rows.length > 0) {
        const prevRun = prevRunRes.rows[0];

        // Fetch previous run's final point
        const prevPointRes = await Database.query(
          `SELECT closing_with_estimates_paise, closing_predicted_paise
           FROM forecast_points
           WHERE business_id = $1 AND forecast_run_id = $2
           ORDER BY forecast_date DESC
           LIMIT 1`,
          [businessId, prevRun.id]
        );

        // Fetch previous run's alert status
        const prevAlertsRes = await Database.query(
          `SELECT COUNT(*) as count, MIN(projected_date) as earliest_date
           FROM risk_alerts
           WHERE business_id = $1 AND forecast_run_id = $2`,
          [businessId, prevRun.id]
        );

        if (prevPointRes.rows.length > 0 && points.length > 0) {
          const prevClosing = BigInt(
            prevPointRes.rows[0].closing_with_estimates_paise || prevPointRes.rows[0].closing_predicted_paise || '0'
          );
          const currClosing = BigInt(
            points[points.length - 1].closing_with_estimates_paise || points[points.length - 1].closing_predicted_paise || '0'
          );
          const prevAlertCount = parseInt(prevAlertsRes.rows[0]?.count || '0', 10);
          const currAlertCount = alerts.length;

          if (currClosing > prevClosing || (prevAlertCount > 0 && currAlertCount === 0)) {
            const diffPaise = currClosing > prevClosing ? currClosing - prevClosing : 0n;

            // Identify which receivables contributed
            const incomingReceivables = allMovements.filter((m) => m.source_type === 'RECEIVABLE');
            let driverNote = '';
            if (incomingReceivables.length > 0) {
              const topRec = incomingReceivables.reduce((prev, curr) =>
                BigInt(curr.amount_paise) > BigInt(prev.amount_paise) ? curr : prev
              );
              driverNote = `, supported by customer receipt of ₹${formatRupees(topRec.amount_paise)} from ${topRec.label_snapshot}`;
            }

            let breachResolvedNote = '';
            if (prevAlertCount > 0 && currAlertCount === 0) {
              breachResolvedNote = ' Previous operating buffer breach has been successfully resolved.';
            }

            explanations.push({
              id: `exp_imp_${forecastRunId}`,
              category: 'CASH_FLOW_IMPROVEMENT',
              title: 'Projected Cash-Flow Improvement',
              text: `Projected 30-day cash position improved by ₹${formatRupees(diffPaise)} (from ₹${formatRupees(prevClosing)} to ₹${formatRupees(currClosing)})${driverNote}.${breachResolvedNote}`,
              date: points[points.length - 1].forecast_date,
              amount_paise: diffPaise.toString(),
              certainty: 'CONFIRMED',
              severity: 'INFO',
              source_type: 'FORECAST_RUN',
            });
          }
        }
      }
    } catch {
      // Non-blocking fallback if previous run comparison query fails
    }

    // 4. Upcoming Payable Obligations
    const payables = allMovements
      .filter((m) => m.source_type === 'PAYABLE')
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const p of payables) {
      const rupees = formatRupees(p.amount_paise);
      const isLarge = BigInt(p.amount_paise) >= minimumBufferPaise && minimumBufferPaise > 0n;

      explanations.push({
        id: `exp_pay_${p.event_id}_${forecastRunId}`,
        category: 'PAYABLE_OBLIGATION',
        title: `Upcoming Payment: ${p.label_snapshot}`,
        text: `${p.certainty === 'CONFIRMED' ? 'Confirmed' : 'Estimated'} payment of ₹${rupees} scheduled for ${p.label_snapshot} on ${p.date} reduces projected cash balance.`,
        date: p.date,
        amount_paise: p.amount_paise,
        certainty: p.certainty,
        severity: isLarge ? 'WARNING' : 'INFO',
        source_type: 'PAYABLE',
        event_id: p.event_id,
      });
    }

    // 5. Expected Receivables
    const receivables = allMovements
      .filter((m) => m.source_type === 'RECEIVABLE')
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const r of receivables) {
      const rupees = formatRupees(r.amount_paise);

      explanations.push({
        id: `exp_rec_${r.event_id}_${forecastRunId}`,
        category: 'EXPECTED_RECEIVABLE',
        title: `Expected Inflow: ${r.label_snapshot}`,
        text: `${r.certainty === 'CONFIRMED' ? 'Confirmed' : 'Estimated'} customer collection of ₹${rupees} expected from ${r.label_snapshot} on ${r.date} supports projected cash reserves.`,
        date: r.date,
        amount_paise: r.amount_paise,
        certainty: r.certainty,
        severity: 'INFO',
        source_type: 'RECEIVABLE',
        event_id: r.event_id,
      });
    }

    // 6. No-Movement Scenario
    if (allMovements.length === 0) {
      explanations.push({
        id: `exp_nomove_${forecastRunId}`,
        category: 'NO_MOVEMENTS',
        title: 'Steady State: No Scheduled Movements',
        text: `Projected cash balance holds constant at opening balance of ₹${formatRupees(openingConfirmedPaise)} across the 30-day forecast horizon. No upcoming customer receivables or supplier payables are currently registered.`,
        date: asOfDateStr,
        amount_paise: openingConfirmedPaise.toString(),
        certainty: 'CONFIRMED',
        severity: 'INFO',
        source_type: 'BALANCE',
      });
    }

    return explanations;
  }
}
