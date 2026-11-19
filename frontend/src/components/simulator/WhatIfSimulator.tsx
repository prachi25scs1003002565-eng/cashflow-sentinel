import { useState, useMemo, useEffect, type FormEvent } from 'react';
import {
  Sparkles,
  Clock3,
  ArrowUpRight,
  Plus,
  Pencil,
  RotateCcw,
  AlertTriangle,
  AlertOctagon,
  ShieldCheck,
  LoaderCircle,
  LockKeyhole,
  Info,
  CheckCircle2,
} from 'lucide-react';
import {
  simulateForecast,
  type ScenarioType,
  type SimulationResult,
  type ForecastLatestResponse,
  type ForecastRun,
} from '../../services/forecast';

export interface WhatIfSimulatorProps {
  forecastData: ForecastLatestResponse | null;
  demoMode: boolean;
  onSwitchToDemo?: () => void;
  onRefreshForecast?: () => Promise<void>;
}

interface ScenarioConfig {
  type: ScenarioType;
  title: string;
  tagline: string;
  description: string;
  icon: typeof Clock3;
  defaultAmount: number;
}

const SCENARIOS: ScenarioConfig[] = [
  {
    type: 'DELAYED_RECEIPT',
    title: 'Delayed Customer Receipt',
    tagline: 'Expected payment is postponed',
    description:
      'Simulate the liquidity gap when an expected customer invoice or receivable arrives later than scheduled.',
    icon: Clock3,
    defaultAmount: 10000,
  },
  {
    type: 'EARLIER_RECEIPT',
    title: 'Accelerated Inflow',
    tagline: 'Customer settles invoice early',
    description:
      'Model an unexpected early collection or accelerated receivable to see how it strengthens cash reserves.',
    icon: ArrowUpRight,
    defaultAmount: 15000,
  },
  {
    type: 'NEW_PURCHASE',
    title: 'Unplanned Capital Purchase',
    tagline: 'Unexpected equipment or inventory outlay',
    description:
      'Assess whether an urgent capital purchase, equipment repair, or bulk inventory buy will breach your buffer.',
    icon: Plus,
    defaultAmount: 25000,
  },
  {
    type: 'EXPENSE_CHANGE',
    title: 'Recurring Expense Adjustment',
    tagline: 'Higher or lower operating costs',
    description:
      'Test the cumulative effect of an ongoing operational expense adjustment, such as a rent, utility, or supply rate shift.',
    icon: Pencil,
    defaultAmount: 5000,
  },
  {
    type: 'MANUAL_CASH_MOVEMENT',
    title: 'Manual Cash Movement',
    tagline: 'Owner capital injection or draw',
    description:
      'Simulate a one-time cash injection from partners/owners or an owner dividend withdrawal from the business.',
    icon: RotateCcw,
    defaultAmount: 20000,
  },
];

const AMOUNT_PRESETS = [5000, 10000, 25000, 50000, 100000];

function formatRupees(amount: number): string {
  const isNeg = amount < 0;
  const abs = Math.abs(amount);
  const formatted = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(abs);
  return `${isNeg ? '-' : ''}₹${formatted}`;
}

function formatPaiseString(paiseStr: string): string {
  try {
    const paise = BigInt(paiseStr);
    const isNeg = paise < 0n;
    const abs = isNeg ? -paise : paise;
    const rupees = Number(abs) / 100;
    const formatted = new Intl.NumberFormat('en-IN', {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(rupees);
    return `${isNeg ? '-' : ''}₹${formatted}`;
  } catch {
    return `₹${paiseStr}`;
  }
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysToIso(baseDate: string, days: number): string {
  const dt = new Date(`${baseDate}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function formatDateLabel(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
    }).format(dt);
  } catch {
    return dateStr;
  }
}

export function WhatIfSimulator({
  forecastData,
  demoMode,
  onSwitchToDemo,
}: WhatIfSimulatorProps) {
  const hasRealBaseline = Boolean(forecastData && forecastData.has_sufficient_history);
  const baselineRun: ForecastRun | null = hasRealBaseline && forecastData && 'run' in forecastData
    ? forecastData.run
    : null;

  // Derive active date bounds from baseline run or current date
  const todayStr = useMemo(() => toIsoDate(new Date()), []);
  const baselineDates = useMemo(() => {
    if (baselineRun && baselineRun.points.length > 0) {
      return baselineRun.points.map((p) => p.forecast_date);
    }
    // Fallback: 30 days starting today
    return Array.from({ length: 30 }, (_, i) => addDaysToIso(todayStr, i));
  }, [baselineRun, todayStr]);

  const minDate = baselineDates[0];
  const maxDate = baselineDates[baselineDates.length - 1];

  // Scenario form state
  const [selectedScenario, setSelectedScenario] = useState<ScenarioType>('DELAYED_RECEIPT');
  const [amount, setAmount] = useState<string>('10000');
  const [originalDate, setOriginalDate] = useState<string>(
    () => baselineDates[Math.min(4, baselineDates.length - 1)] || addDaysToIso(todayStr, 5)
  );
  const [newDate, setNewDate] = useState<string>(
    () => baselineDates[Math.min(9, baselineDates.length - 1)] || addDaysToIso(todayStr, 10)
  );
  const [delayDays, setDelayDays] = useState<number>(5);
  const [eventDate, setEventDate] = useState<string>(
    () => baselineDates[Math.min(4, baselineDates.length - 1)] || addDaysToIso(todayStr, 5)
  );
  const [expenseDirection, setExpenseDirection] = useState<'INCREASE' | 'DECREASE'>('INCREASE');
  const [cashDirection, setCashDirection] = useState<'INFLOW' | 'OUTFLOW'>('INFLOW');
  const [description, setDescription] = useState<string>('');

  // Execution state
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Update default dates when baseline changes
  useEffect(() => {
    if (baselineDates.length > 0) {
      const day5 = baselineDates[Math.min(4, baselineDates.length - 1)];
      const day10 = baselineDates[Math.min(9, baselineDates.length - 1)];
      setOriginalDate(day5);
      setNewDate(day10);
      setEventDate(day5);
    }
  }, [baselineDates]);

  // Scenario switch handler
  const handleSelectScenario = (type: ScenarioType) => {
    setSelectedScenario(type);
    const cfg = SCENARIOS.find((s) => s.type === type);
    if (cfg) {
      setAmount(String(cfg.defaultAmount));
    }
    setSimulationError(null);
  };

  // Execute simulation
  const handleRunSimulation = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    setSimulationError(null);

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setSimulationError('Please enter a valid amount greater than zero.');
      return;
    }

    setIsSimulating(true);

    try {
      if (hasRealBaseline && baselineRun) {
        // Real baseline simulation via backend API
        let requestPayload: any = {
          baseline_forecast_id: baselineRun.id,
          scenario_type: selectedScenario,
        };

        switch (selectedScenario) {
          case 'DELAYED_RECEIPT': {
            const calculatedNewDate = newDate || addDaysToIso(originalDate, delayDays);
            if (calculatedNewDate <= originalDate) {
              throw new Error('New receipt date must be after the original expected date.');
            }
            requestPayload = {
              ...requestPayload,
              amount: parsedAmount,
              original_date: originalDate,
              new_date: calculatedNewDate,
              delay_days: delayDays,
              description: description || 'Delayed Customer Payment',
            };
            break;
          }

          case 'EARLIER_RECEIPT': {
            if (newDate >= originalDate) {
              throw new Error('Accelerated receipt date must be earlier than the original date.');
            }
            requestPayload = {
              ...requestPayload,
              amount: parsedAmount,
              original_date: originalDate,
              new_date: newDate,
              date: newDate,
              description: description || 'Accelerated Invoice Collection',
            };
            break;
          }

          case 'NEW_PURCHASE': {
            requestPayload = {
              ...requestPayload,
              amount: parsedAmount,
              date: eventDate,
              description: description || 'Unplanned Purchase',
            };
            break;
          }

          case 'EXPENSE_CHANGE': {
            // Positive delta increases expense (lowers cash), negative delta reduces expense
            const signedAmount = expenseDirection === 'INCREASE' ? parsedAmount : -parsedAmount;
            requestPayload = {
              ...requestPayload,
              amount: signedAmount,
              date: eventDate,
              description:
                description ||
                (expenseDirection === 'INCREASE' ? 'Expense Increase' : 'Expense Reduction'),
            };
            break;
          }

          case 'MANUAL_CASH_MOVEMENT': {
            requestPayload = {
              ...requestPayload,
              amount: parsedAmount,
              direction: cashDirection,
              date: eventDate,
              description:
                description ||
                (cashDirection === 'INFLOW' ? 'Capital Inflow' : 'Owner Withdrawal'),
            };
            break;
          }
        }

        const result = await simulateForecast(requestPayload);
        setSimulationResult(result);
      } else if (demoMode) {
        // Illustrative demo client-side simulation based on standard demo curve
        const demoBufferPaise = 2500000n; // ₹25,000

        // Build 30 demo points
        const basePoints = baselineDates.map((date, idx) => {
          let bal = 62000;
          if (idx >= 5 && idx < 6) bal = 14000;
          else if (idx >= 6 && idx < 8) bal = 36000;
          else if (idx >= 8) bal = 18000;

          const paise = BigInt(bal * 100);
          return {
            forecast_date: date,
            closing_paise: paise.toString(),
            closing_rupees: bal,
          };
        });

        // Compute simulated delta
        let scenarioSummary = '';
        const simulatedPoints = basePoints.map((bp) => {
          const dt = bp.forecast_date;
          let deltaRupees = 0;

          switch (selectedScenario) {
            case 'DELAYED_RECEIPT': {
              const effNewDate = newDate || addDaysToIso(originalDate, delayDays);
              if (dt >= originalDate && dt < effNewDate) {
                deltaRupees = -parsedAmount;
              }
              scenarioSummary = `[Demo] Customer payment of ${formatRupees(
                parsedAmount
              )} delayed from ${originalDate} to ${effNewDate}.`;
              break;
            }
            case 'EARLIER_RECEIPT': {
              if (dt >= newDate && dt < originalDate) {
                deltaRupees = parsedAmount;
              }
              scenarioSummary = `[Demo] Customer payment of ${formatRupees(
                parsedAmount
              )} received early on ${newDate} instead of ${originalDate}.`;
              break;
            }
            case 'NEW_PURCHASE': {
              if (dt >= eventDate) {
                deltaRupees = -parsedAmount;
              }
              scenarioSummary = `[Demo] Unplanned business purchase of ${formatRupees(
                parsedAmount
              )} on ${eventDate}.`;
              break;
            }
            case 'EXPENSE_CHANGE': {
              const sign = expenseDirection === 'INCREASE' ? -1 : 1;
              if (dt >= eventDate) {
                deltaRupees = sign * parsedAmount;
              }
              scenarioSummary = `[Demo] Ongoing expense ${
                expenseDirection === 'INCREASE' ? 'increased' : 'reduced'
              } by ${formatRupees(parsedAmount)} starting ${eventDate}.`;
              break;
            }
            case 'MANUAL_CASH_MOVEMENT': {
              const sign = cashDirection === 'INFLOW' ? 1 : -1;
              if (dt >= eventDate) {
                deltaRupees = sign * parsedAmount;
              }
              scenarioSummary = `[Demo] Manual ${cashDirection.toLowerCase()} adjustment of ${formatRupees(
                parsedAmount
              )} on ${eventDate}.`;
              break;
            }
          }

          const simClosingRupees = bp.closing_rupees + deltaRupees;
          const simClosingPaise = BigInt(Math.round(simClosingRupees * 100));
          const diffPaise = BigInt(Math.round(deltaRupees * 100));
          const bufferBreached = simClosingPaise < demoBufferPaise;

          return {
            forecast_date: dt,
            baseline_closing_paise: bp.closing_paise,
            baseline_closing_rupees: bp.closing_rupees,
            simulated_closing_paise: simClosingPaise.toString(),
            simulated_closing_rupees: simClosingRupees,
            difference_paise: diffPaise.toString(),
            difference_rupees: deltaRupees,
            buffer_breached: bufferBreached,
          };
        });

        const lastSim = simulatedPoints[simulatedPoints.length - 1];
        const hasNegative = simulatedPoints.some((p) => p.simulated_closing_rupees < 0);
        const hasBreach = simulatedPoints.some((p) => p.buffer_breached);
        const riskStatus: 'PROTECTED' | 'AT_RISK' | 'CRITICAL' = hasNegative
          ? 'CRITICAL'
          : hasBreach
          ? 'AT_RISK'
          : 'PROTECTED';

        setSimulationResult({
          baseline_forecast_id: 'demo-baseline-run',
          scenario_type: selectedScenario,
          scenario_summary: scenarioSummary,
          baseline_points: basePoints,
          simulated_points: simulatedPoints,
          closing_balance_difference_paise: lastSim.difference_paise,
          closing_balance_difference_rupees: lastSim.difference_rupees,
          baseline_risk_status: 'AT_RISK',
          simulated_risk_status: riskStatus,
          generated_at: new Date().toISOString(),
        });
      } else {
        throw new Error(
          'Live What-If simulation requires a baseline forecast with 14+ days of transaction history. Switch to Demo Preview to explore with illustrative data.'
        );
      }
    } catch (err) {
      setSimulationError(err instanceof Error ? err.message : 'Simulation failed. Please try again.');
    } finally {
      setIsSimulating(false);
    }
  };

  const handleResetSimulation = () => {
    setSimulationResult(null);
    setSimulationError(null);
    setHoveredIndex(null);
  };

  // Chart computation
  const chartData = useMemo(() => {
    if (!simulationResult || simulationResult.simulated_points.length === 0) {
      return null;
    }

    const points = simulationResult.simulated_points;
    const bufferPaise = baselineRun
      ? BigInt(baselineRun.minimum_cash_buffer_paise || '0')
      : 2500000n; // ₹25,000 for demo
    const bufferRupees = Number(bufferPaise) / 100;

    const allValues = [
      ...points.map((p) => p.baseline_closing_rupees),
      ...points.map((p) => p.simulated_closing_rupees),
      bufferRupees,
      0,
    ];

    let maxVal = Math.max(...allValues);
    let minVal = Math.min(...allValues);

    if (maxVal === minVal) {
      maxVal += 1000;
    }
    // Add 10% breathing room to chart limits
    const span = maxVal - minVal;
    maxVal = maxVal + span * 0.08;
    minVal = minVal - span * 0.05;
    const range = maxVal - minVal;

    const width = 720;
    const left = 62;
    const right = 702;
    const top = 26;
    const bottom = 188;
    const chartWidth = right - left;
    const chartHeight = bottom - top;

    const getX = (idx: number) => left + (idx / (points.length - 1)) * chartWidth;
    const getY = (val: number) => bottom - ((val - minVal) / range) * chartHeight;

    const coords = points.map((p, idx) => ({
      idx,
      date: p.forecast_date,
      x: getX(idx),
      yBase: getY(p.baseline_closing_rupees),
      ySim: getY(p.simulated_closing_rupees),
      baseRupees: p.baseline_closing_rupees,
      simRupees: p.simulated_closing_rupees,
      diffRupees: p.difference_rupees,
      bufferBreached: p.buffer_breached,
    }));

    const baselinePath = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.yBase.toFixed(1)}`)
      .join(' ');

    const simulatedPath = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.ySim.toFixed(1)}`)
      .join(' ');

    const simulatedArea = `${simulatedPath} L ${coords[coords.length - 1].x.toFixed(
      1
    )} ${bottom} L ${coords[0].x.toFixed(1)} ${bottom} Z`;

    const bufferY = getY(bufferRupees);
    const zeroY = getY(0);

    // Generate 4 clean grid levels
    const gridLevels = [0, 0.33, 0.66, 1].map((pct) => {
      const val = minVal + pct * range;
      const y = bottom - pct * chartHeight;
      return { val, y };
    });

    return {
      width,
      height: 236,
      left,
      right,
      top,
      bottom,
      coords,
      baselinePath,
      simulatedPath,
      simulatedArea,
      bufferY,
      bufferRupees,
      zeroY,
      gridLevels,
      minVal,
      maxVal,
    };
  }, [simulationResult, baselineRun]);

  const activeHoverPoint =
    chartData && hoveredIndex !== null && chartData.coords[hoveredIndex]
      ? chartData.coords[hoveredIndex]
      : null;

  return (
    <section className="lower-grid" id="simulator" style={{ marginTop: 28 }}>
      <article className="panel simulator-panel" style={{ gridColumn: '1 / -1', padding: '24px 28px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <div className="simulator-art" style={{ margin: 0 }}>
                <Sparkles size={20} aria-hidden="true" />
              </div>
              <div>
                <p className="eyebrow" style={{ margin: 0 }}>
                  DECISION SUPPORT ENGINE
                </p>
                <h2 style={{ margin: 0, fontSize: 20 }}>Interactive What-If Cashflow Simulator</h2>
              </div>
            </div>
            <p className="simulator-description" style={{ maxWidth: 640, margin: '6px 0 0', fontSize: 13, color: '#6b7280' }}>
              Model hypothetical business decisions—delays in client receivables, inventory investments, or expense
              surges—to see whether they will breach your operating buffer or trigger a cash deficit, without touching your ledger.
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            {hasRealBaseline ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 11px',
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 600,
                  background: '#ecfdf5',
                  color: '#065f46',
                  border: '1px solid #a7f3d0',
                }}
              >
                <CheckCircle2 size={13} aria-hidden="true" />
                Live Baseline Active (₹
                {new Intl.NumberFormat('en-IN').format(
                  Number(BigInt(baselineRun?.minimum_cash_buffer_paise || '0')) / 100
                )}{' '}
                buffer)
              </span>
            ) : demoMode ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 11px',
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 600,
                  background: '#fffbeb',
                  color: '#92400e',
                  border: '1px solid #fde68a',
                }}
              >
                <Info size={13} aria-hidden="true" />
                Demo Preview Mode (₹25,000 buffer)
              </span>
            ) : (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 11px',
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 600,
                  background: '#f3f4f6',
                  color: '#4b5563',
                  border: '1px solid #e5e7eb',
                }}
              >
                <LockKeyhole size={13} aria-hidden="true" />
                Calibrating Baseline (14+ Days Needed)
              </span>
            )}
          </div>
        </div>

        {/* Insufficient History Notice (Live Mode only) */}
        {!hasRealBaseline && !demoMode && (
          <div
            style={{
              marginTop: 18,
              padding: '14px 16px',
              borderRadius: 10,
              background: '#f0fdf4',
              border: '1px solid #bbf7d0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Info size={18} style={{ color: '#16a34a', flexShrink: 0 }} aria-hidden="true" />
              <span style={{ fontSize: 13, color: '#166534', lineHeight: 1.5 }}>
                What-If simulations require at least 14 days of recorded transactions to generate a validated baseline.
                You can try the simulator right now using the illustrative demo mode.
              </span>
            </div>
            {onSwitchToDemo && (
              <button
                type="button"
                className="button button--primary"
                style={{ fontSize: 12, padding: '7px 14px', whiteSpace: 'nowrap' }}
                onClick={onSwitchToDemo}
              >
                Switch to Demo Preview
              </button>
            )}
          </div>
        )}

        {/* Scenario Selection Tabs */}
        <div style={{ marginTop: 22 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#4b5563', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            1. Select Scenario
          </label>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 10,
            }}
          >
            {SCENARIOS.map((sc) => {
              const Icon = sc.icon;
              const isSelected = selectedScenario === sc.type;
              return (
                <button
                  key={sc.type}
                  type="button"
                  onClick={() => handleSelectScenario(sc.type)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    padding: '12px 14px',
                    borderRadius: 10,
                    border: isSelected ? '2px solid #238866' : '1px solid #e5e7eb',
                    background: isSelected ? '#f0fdf4' : '#ffffff',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s ease-in-out',
                    boxShadow: isSelected ? '0 2px 8px rgba(35, 136, 102, 0.15)' : 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <div
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        display: 'grid',
                        placeItems: 'center',
                        background: isSelected ? '#238866' : '#f3f4f6',
                        color: isSelected ? '#ffffff' : '#6b7280',
                      }}
                    >
                      <Icon size={14} aria-hidden="true" />
                    </div>
                    <strong style={{ fontSize: 13, color: isSelected ? '#15803d' : '#1f2937' }}>
                      {sc.title}
                    </strong>
                  </div>
                  <small style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.3 }}>
                    {sc.tagline}
                  </small>
                </button>
              );
            })}
          </div>
        </div>

        {/* Dynamic Scenario Form */}
        <form onSubmit={handleRunSimulation} style={{ marginTop: 22 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#4b5563', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            2. Configure Scenario Parameters
          </label>

          <div
            style={{
              padding: '18px 20px',
              borderRadius: 12,
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              display: 'grid',
              gap: 16,
            }}
          >
            {/* Amount and Presets */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
              <div>
                <label htmlFor="sim-amount" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                  Scenario Amount (₹) *
                </label>
                <div style={{ position: 'relative' }}>
                  <span
                    style={{
                      position: 'absolute',
                      left: 12,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: '#6b7280',
                      fontWeight: 600,
                    }}
                  >
                    ₹
                  </span>
                  <input
                    id="sim-amount"
                    type="number"
                    step="0.01"
                    min="1"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="e.g. 10000"
                    disabled={isSimulating}
                    style={{
                      width: '100%',
                      padding: '9px 12px 9px 28px',
                      borderRadius: 8,
                      border: '1px solid #d1d5db',
                      fontSize: 14,
                      fontWeight: 600,
                      color: '#111827',
                      background: '#ffffff',
                    }}
                  />
                </div>
                {/* Fast Preset Chips */}
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {AMOUNT_PRESETS.map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setAmount(String(val))}
                      style={{
                        padding: '3px 8px',
                        borderRadius: 12,
                        fontSize: 11,
                        background: amount === String(val) ? '#238866' : '#e5e7eb',
                        color: amount === String(val) ? '#ffffff' : '#374151',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 500,
                      }}
                    >
                      ₹{new Intl.NumberFormat('en-IN').format(val)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Scenario-specific Inputs */}
              {selectedScenario === 'DELAYED_RECEIPT' && (
                <>
                  <div>
                    <label htmlFor="sim-orig-date" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Original Expected Date *
                    </label>
                    <input
                      id="sim-orig-date"
                      type="date"
                      required
                      min={minDate}
                      max={maxDate}
                      value={originalDate}
                      onChange={(e) => setOriginalDate(e.target.value)}
                      disabled={isSimulating}
                      style={{
                        width: '100%',
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid #d1d5db',
                        fontSize: 13,
                        background: '#ffffff',
                      }}
                    />
                  </div>
                  <div>
                    <label htmlFor="sim-delay-days" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Delay (Days) *
                    </label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        id="sim-delay-days"
                        type="number"
                        min="1"
                        max="60"
                        required
                        value={delayDays}
                        onChange={(e) => {
                          const d = parseInt(e.target.value, 10) || 1;
                          setDelayDays(d);
                          setNewDate(addDaysToIso(originalDate, d));
                        }}
                        disabled={isSimulating}
                        style={{
                          width: 80,
                          padding: '9px 12px',
                          borderRadius: 8,
                          border: '1px solid #d1d5db',
                          fontSize: 13,
                          background: '#ffffff',
                        }}
                      />
                      <span style={{ fontSize: 12, color: '#6b7280' }}>
                        → Arrives on <strong>{addDaysToIso(originalDate, delayDays)}</strong>
                      </span>
                    </div>
                  </div>
                </>
              )}

              {selectedScenario === 'EARLIER_RECEIPT' && (
                <>
                  <div>
                    <label htmlFor="sim-orig-date-early" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Originally Due Date *
                    </label>
                    <input
                      id="sim-orig-date-early"
                      type="date"
                      required
                      min={minDate}
                      max={maxDate}
                      value={originalDate}
                      onChange={(e) => setOriginalDate(e.target.value)}
                      disabled={isSimulating}
                      style={{
                        width: '100%',
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid #d1d5db',
                        fontSize: 13,
                        background: '#ffffff',
                      }}
                    />
                  </div>
                  <div>
                    <label htmlFor="sim-new-date-early" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Accelerated Collection Date *
                    </label>
                    <input
                      id="sim-new-date-early"
                      type="date"
                      required
                      min={minDate}
                      max={maxDate}
                      value={newDate}
                      onChange={(e) => setNewDate(e.target.value)}
                      disabled={isSimulating}
                      style={{
                        width: '100%',
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid #d1d5db',
                        fontSize: 13,
                        background: '#ffffff',
                      }}
                    />
                    <small style={{ fontSize: 11, color: '#6b7280' }}>Must be prior to {originalDate}</small>
                  </div>
                </>
              )}

              {selectedScenario === 'NEW_PURCHASE' && (
                <>
                  <div>
                    <label htmlFor="sim-event-date-purchase" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Purchase Outlay Date *
                    </label>
                    <input
                      id="sim-event-date-purchase"
                      type="date"
                      required
                      min={minDate}
                      max={maxDate}
                      value={eventDate}
                      onChange={(e) => setEventDate(e.target.value)}
                      disabled={isSimulating}
                      style={{
                        width: '100%',
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid #d1d5db',
                        fontSize: 13,
                        background: '#ffffff',
                      }}
                    />
                  </div>
                  <div>
                    <label htmlFor="sim-desc-purchase" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Item or Reason (Optional)
                    </label>
                    <input
                      id="sim-desc-purchase"
                      type="text"
                      placeholder="e.g. Storage racks, Emergency generator repair"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      disabled={isSimulating}
                      style={{
                        width: '100%',
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid #d1d5db',
                        fontSize: 13,
                        background: '#ffffff',
                      }}
                    />
                  </div>
                </>
              )}

              {selectedScenario === 'EXPENSE_CHANGE' && (
                <>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Expense Change Direction *
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => setExpenseDirection('INCREASE')}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          borderRadius: 8,
                          border: expenseDirection === 'INCREASE' ? '2px solid #dc2626' : '1px solid #d1d5db',
                          background: expenseDirection === 'INCREASE' ? '#fef2f2' : '#ffffff',
                          color: expenseDirection === 'INCREASE' ? '#991b1b' : '#374151',
                          fontWeight: 600,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        + Increase Cost
                      </button>
                      <button
                        type="button"
                        onClick={() => setExpenseDirection('DECREASE')}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          borderRadius: 8,
                          border: expenseDirection === 'DECREASE' ? '2px solid #16a34a' : '1px solid #d1d5db',
                          background: expenseDirection === 'DECREASE' ? '#f0fdf4' : '#ffffff',
                          color: expenseDirection === 'DECREASE' ? '#166534' : '#374151',
                          fontWeight: 600,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        - Reduce Cost
                      </button>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="sim-event-date-expense" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Effective Date *
                    </label>
                    <input
                      id="sim-event-date-expense"
                      type="date"
                      required
                      min={minDate}
                      max={maxDate}
                      value={eventDate}
                      onChange={(e) => setEventDate(e.target.value)}
                      disabled={isSimulating}
                      style={{
                        width: '100%',
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid #d1d5db',
                        fontSize: 13,
                        background: '#ffffff',
                      }}
                    />
                  </div>
                </>
              )}

              {selectedScenario === 'MANUAL_CASH_MOVEMENT' && (
                <>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Movement Direction *
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => setCashDirection('INFLOW')}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          borderRadius: 8,
                          border: cashDirection === 'INFLOW' ? '2px solid #16a34a' : '1px solid #d1d5db',
                          background: cashDirection === 'INFLOW' ? '#f0fdf4' : '#ffffff',
                          color: cashDirection === 'INFLOW' ? '#166534' : '#374151',
                          fontWeight: 600,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        Inflow (+)
                      </button>
                      <button
                        type="button"
                        onClick={() => setCashDirection('OUTFLOW')}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          borderRadius: 8,
                          border: cashDirection === 'OUTFLOW' ? '2px solid #dc2626' : '1px solid #d1d5db',
                          background: cashDirection === 'OUTFLOW' ? '#fef2f2' : '#ffffff',
                          color: cashDirection === 'OUTFLOW' ? '#991b1b' : '#374151',
                          fontWeight: 600,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        Outflow (-)
                      </button>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="sim-event-date-movement" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Movement Date *
                    </label>
                    <input
                      id="sim-event-date-movement"
                      type="date"
                      required
                      min={minDate}
                      max={maxDate}
                      value={eventDate}
                      onChange={(e) => setEventDate(e.target.value)}
                      disabled={isSimulating}
                      style={{
                        width: '100%',
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid #d1d5db',
                        fontSize: 13,
                        background: '#ffffff',
                      }}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Error Banner */}
            {simulationError && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: '#fef2f2',
                  border: '1px solid #fecaca',
                  color: '#991b1b',
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
                <span>{simulationError}</span>
              </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6b7280' }}>
                <LockKeyhole size={13} aria-hidden="true" />
                <span>What-If simulations are computed in-memory and never modify real ledger transactions.</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {simulationResult && (
                  <button
                    type="button"
                    onClick={handleResetSimulation}
                    disabled={isSimulating}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 8,
                      border: '1px solid #d1d5db',
                      background: '#ffffff',
                      fontSize: 13,
                      fontWeight: 500,
                      color: '#4b5563',
                      cursor: 'pointer',
                    }}
                  >
                    Reset
                  </button>
                )}
                <button
                  type="submit"
                  disabled={isSimulating || (!hasRealBaseline && !demoMode)}
                  className="button button--primary"
                  style={{
                    padding: '9px 20px',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  {isSimulating ? (
                    <>
                      <LoaderCircle size={15} className="spin" aria-hidden="true" />
                      <span>Simulating Scenario...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={15} aria-hidden="true" />
                      <span>Run What-If Simulation</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </form>

        {/* Simulation Results Section */}
        {simulationResult && chartData && (
          <div style={{ marginTop: 28, animation: 'fadeIn 0.25s ease-in-out' }}>
            {/* Scenario Summary Banner */}
            <div
              style={{
                padding: '14px 18px',
                borderRadius: 10,
                background:
                  simulationResult.simulated_risk_status === 'CRITICAL'
                    ? '#fef2f2'
                    : simulationResult.simulated_risk_status === 'AT_RISK'
                    ? '#fffbeb'
                    : '#f0fdf4',
                border:
                  simulationResult.simulated_risk_status === 'CRITICAL'
                    ? '1px solid #fca5a5'
                    : simulationResult.simulated_risk_status === 'AT_RISK'
                    ? '1px solid #fde68a'
                    : '1px solid #bbf7d0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
                marginBottom: 18,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {simulationResult.simulated_risk_status === 'CRITICAL' ? (
                  <AlertOctagon size={20} style={{ color: '#dc2626', flexShrink: 0 }} aria-hidden="true" />
                ) : simulationResult.simulated_risk_status === 'AT_RISK' ? (
                  <AlertTriangle size={20} style={{ color: '#d97706', flexShrink: 0 }} aria-hidden="true" />
                ) : (
                  <ShieldCheck size={20} style={{ color: '#16a34a', flexShrink: 0 }} aria-hidden="true" />
                )}
                <div>
                  <strong style={{ fontSize: 14, color: '#111827', display: 'block' }}>
                    {simulationResult.scenario_summary}
                  </strong>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    Compared against 30-day baseline forecast • Simulated at{' '}
                    {new Date(simulationResult.generated_at).toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                </div>
              </div>

              {/* Status Badge */}
              <div>
                {simulationResult.simulated_risk_status === 'CRITICAL' ? (
                  <span
                    style={{
                      padding: '6px 12px',
                      borderRadius: 20,
                      background: '#fee2e2',
                      color: '#991b1b',
                      fontSize: 12,
                      fontWeight: 700,
                      border: '1px solid #f87171',
                    }}
                  >
                    DEFICIT TRIGGERED
                  </span>
                ) : simulationResult.simulated_risk_status === 'AT_RISK' ? (
                  <span
                    style={{
                      padding: '6px 12px',
                      borderRadius: 20,
                      background: '#fef3c7',
                      color: '#92400e',
                      fontSize: 12,
                      fontWeight: 700,
                      border: '1px solid #f59e0b',
                    }}
                  >
                    BUFFER BREACHED
                  </span>
                ) : (
                  <span
                    style={{
                      padding: '6px 12px',
                      borderRadius: 20,
                      background: '#dcfce7',
                      color: '#166534',
                      fontSize: 12,
                      fontWeight: 700,
                      border: '1px solid #4ade80',
                    }}
                  >
                    BUFFER PROTECTED
                  </span>
                )}
              </div>
            </div>

            {/* Impact Metric Cards */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                gap: 14,
                marginBottom: 20,
              }}
            >
              {/* Card 1: Baseline Ending Cash */}
              <div
                style={{
                  padding: '16px 18px',
                  borderRadius: 12,
                  background: '#ffffff',
                  border: '1px solid #e5e7eb',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Baseline 30-Day Closing
                </span>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#111827', marginTop: 4 }}>
                  {formatPaiseString(
                    simulationResult.baseline_points[simulationResult.baseline_points.length - 1]
                      ?.closing_paise || '0'
                  )}
                </div>
                <small style={{ fontSize: 11, color: '#9ca3af' }}>Unadjusted projected cash</small>
              </div>

              {/* Card 2: Simulated Ending Cash */}
              <div
                style={{
                  padding: '16px 18px',
                  borderRadius: 12,
                  background: '#ffffff',
                  border: '1px solid #e5e7eb',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Simulated 30-Day Closing
                </span>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 800,
                    color:
                      simulationResult.simulated_points[simulationResult.simulated_points.length - 1]
                        ?.simulated_closing_rupees < 0
                        ? '#dc2626'
                        : '#111827',
                    marginTop: 4,
                  }}
                >
                  {formatPaiseString(
                    simulationResult.simulated_points[simulationResult.simulated_points.length - 1]
                      ?.simulated_closing_paise || '0'
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color:
                        simulationResult.closing_balance_difference_rupees > 0
                          ? '#16a34a'
                          : simulationResult.closing_balance_difference_rupees < 0
                          ? '#dc2626'
                          : '#6b7280',
                    }}
                  >
                    {simulationResult.closing_balance_difference_rupees > 0 ? '+' : ''}
                    {formatRupees(simulationResult.closing_balance_difference_rupees)} net delta
                  </span>
                </div>
              </div>

              {/* Card 3: Operating Buffer & Safety */}
              <div
                style={{
                  padding: '16px 18px',
                  borderRadius: 12,
                  background: '#ffffff',
                  border: '1px solid #e5e7eb',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Buffer Threshold (₹{new Intl.NumberFormat('en-IN').format(chartData.bufferRupees)})
                </span>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', marginTop: 4 }}>
                  {simulationResult.simulated_risk_status === 'CRITICAL' ? (
                    <span style={{ color: '#dc2626' }}>Deficit Triggered</span>
                  ) : simulationResult.simulated_risk_status === 'AT_RISK' ? (
                    <span style={{ color: '#d97706' }}>Buffer Breached</span>
                  ) : (
                    <span style={{ color: '#16a34a' }}>Safely Protected</span>
                  )}
                </div>
                <small style={{ fontSize: 11, color: '#6b7280' }}>
                  {simulationResult.simulated_points.filter((p) => p.buffer_breached).length} of 30 days
                  projected below buffer
                </small>
              </div>
            </div>

            {/* Comparative Dual-Trajectory Chart */}
            <div
              style={{
                background: '#ffffff',
                borderRadius: 14,
                border: '1px solid #e5e7eb',
                padding: '20px 22px 14px',
                position: 'relative',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#111827' }}>
                    Comparative Trajectory Projection
                  </h3>
                  <small style={{ fontSize: 12, color: '#6b7280' }}>
                    Solid violet line shows simulated balance; dashed green line is your baseline forecast
                  </small>
                </div>

                {/* Point Inspector Badge */}
                {activeHoverPoint && (
                  <div
                    style={{
                      background: '#f3f4f6',
                      padding: '4px 10px',
                      borderRadius: 8,
                      fontSize: 11,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span>
                      <strong>{formatDateLabel(activeHoverPoint.date)}</strong>
                    </span>
                    <span>Base: {formatRupees(activeHoverPoint.baseRupees)}</span>
                    <span>
                      Sim: <strong>{formatRupees(activeHoverPoint.simRupees)}</strong>
                    </span>
                    <span
                      style={{
                        fontWeight: 700,
                        color: activeHoverPoint.diffRupees < 0 ? '#dc2626' : '#16a34a',
                      }}
                    >
                      ({activeHoverPoint.diffRupees > 0 ? '+' : ''}
                      {formatRupees(activeHoverPoint.diffRupees)})
                    </span>
                  </div>
                )}
              </div>

              {/* SVG Chart */}
              <div className="chart-wrap" style={{ position: 'relative' }}>
                <svg
                  viewBox={`0 0 ${chartData.width} ${chartData.height}`}
                  style={{ width: '100%', height: 'auto', display: 'block' }}
                  role="img"
                  aria-label="What-If Simulation comparative chart"
                >
                  <defs>
                    <linearGradient id="sim-area" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.22" />
                      <stop offset="100%" stopColor="#7c3aed" stopOpacity="0.01" />
                    </linearGradient>
                  </defs>

                  {/* Horizontal Grid Lines */}
                  {chartData.gridLevels.map((gl, i) => (
                    <g key={i}>
                      <line
                        x1={chartData.left}
                        x2={chartData.right}
                        y1={gl.y}
                        y2={gl.y}
                        stroke="#f1f5f9"
                        strokeWidth="1"
                      />
                      <text
                        x="0"
                        y={gl.y + 4}
                        fontSize="10"
                        fill="#94a3b8"
                        fontFamily="inherit"
                      >
                        ₹
                        {Math.abs(gl.val) >= 1000
                          ? `${Math.round(gl.val / 1000)}k`
                          : Math.round(gl.val)}
                      </text>
                    </g>
                  ))}

                  {/* Zero Balance Line (Deficit Line) if within range */}
                  {chartData.minVal < 0 && (
                    <g>
                      <line
                        x1={chartData.left}
                        x2={chartData.right}
                        y1={chartData.zeroY}
                        y2={chartData.zeroY}
                        stroke="#ef4444"
                        strokeWidth="1.5"
                        strokeDasharray="4 3"
                      />
                      <text
                        x={chartData.right - 4}
                        y={chartData.zeroY - 5}
                        textAnchor="end"
                        fontSize="10"
                        fill="#ef4444"
                        fontWeight="600"
                      >
                        Zero Cash Deficit Line
                      </text>
                    </g>
                  )}

                  {/* Minimum Buffer Threshold Line */}
                  {chartData.bufferRupees > 0 && (
                    <g>
                      <line
                        x1={chartData.left}
                        x2={chartData.right}
                        y1={chartData.bufferY}
                        y2={chartData.bufferY}
                        stroke="#f59e0b"
                        strokeWidth="1.5"
                        strokeDasharray="5 4"
                      />
                      <text
                        x={chartData.right - 4}
                        y={chartData.bufferY - 5}
                        textAnchor="end"
                        fontSize="10"
                        fill="#d97706"
                        fontWeight="600"
                      >
                        Minimum Buffer · ₹{Math.round(chartData.bufferRupees / 1000)}k
                      </text>
                    </g>
                  )}

                  {/* Baseline Line (Green dashed) */}
                  <path
                    d={chartData.baselinePath}
                    fill="none"
                    stroke="#238866"
                    strokeWidth="2"
                    strokeDasharray="5 4"
                    opacity="0.85"
                  />

                  {/* Simulated Area Fill */}
                  <path d={chartData.simulatedArea} fill="url(#sim-area)" />

                  {/* Simulated Line (Violet solid) */}
                  <path
                    d={chartData.simulatedPath}
                    fill="none"
                    stroke="#7c3aed"
                    strokeWidth="2.8"
                  />

                  {/* Points and Breach Markers */}
                  {chartData.coords.map((c, i) => (
                    <g key={i}>
                      {c.bufferBreached && (
                        <circle
                          cx={c.x}
                          cy={c.ySim}
                          r="5"
                          fill="#ef4444"
                          stroke="#ffffff"
                          strokeWidth="2"
                        />
                      )}
                      {/* Interactive Hover Target */}
                      <circle
                        cx={c.x}
                        cy={c.ySim}
                        r="8"
                        fill="transparent"
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={() => setHoveredIndex(i)}
                      />
                    </g>
                  ))}

                  {/* Active Hover Crosshair */}
                  {activeHoverPoint && (
                    <g>
                      <line
                        x1={activeHoverPoint.x}
                        x2={activeHoverPoint.x}
                        y1={chartData.top}
                        y2={chartData.bottom}
                        stroke="#64748b"
                        strokeWidth="1"
                        strokeDasharray="3 3"
                      />
                      <circle
                        cx={activeHoverPoint.x}
                        cy={activeHoverPoint.yBase}
                        r="4"
                        fill="#238866"
                        stroke="#ffffff"
                        strokeWidth="2"
                      />
                      <circle
                        cx={activeHoverPoint.x}
                        cy={activeHoverPoint.ySim}
                        r="5"
                        fill="#7c3aed"
                        stroke="#ffffff"
                        strokeWidth="2"
                      />
                    </g>
                  )}

                  {/* X-Axis Date Ticks */}
                  {[0, 7, 14, 21, 29].map((idx) => {
                    if (!chartData.coords[idx]) return null;
                    const c = chartData.coords[idx];
                    return (
                      <text
                        key={idx}
                        x={c.x}
                        y="218"
                        textAnchor={idx === 0 ? 'start' : idx === 29 ? 'end' : 'middle'}
                        fontSize="10"
                        fill="#64748b"
                      >
                        {idx === 0 ? 'Day 1' : `Day ${idx + 1}`} ({formatDateLabel(c.date)})
                      </text>
                    );
                  })}
                </svg>

                {/* Chart Legend */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 20,
                    marginTop: 14,
                    fontSize: 11,
                    color: '#475569',
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        width: 16,
                        height: 3,
                        background: '#7c3aed',
                        borderRadius: 2,
                        display: 'inline-block',
                      }}
                    />
                    <strong>Simulated Trajectory</strong>
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        width: 16,
                        height: 2,
                        background: '#238866',
                        borderTop: '2px dashed #238866',
                        display: 'inline-block',
                      }}
                    />
                    <span>Baseline Forecast</span>
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        width: 16,
                        height: 2,
                        background: '#f59e0b',
                        borderTop: '2px dashed #f59e0b',
                        display: 'inline-block',
                      }}
                    />
                    <span>Operating Buffer</span>
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: '#ef4444',
                        display: 'inline-block',
                      }}
                    />
                    <span>Buffer Breach</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </article>
    </section>
  );
}
