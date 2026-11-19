import { useEffect, useState, useCallback, useMemo, useRef, type FormEvent } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  Info,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Monitor,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
  Sun,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { checkApiHealth } from '../services/dashboard';
import {
  fetchTransactionSummary,
  fetchPaginatedTransactions,
  fetchCategories,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  type TransactionItem,
  type TransactionSummary,
  type TransactionCategory,
  type PaginationInfo,
} from '../services/transactions';
import { type AuthUser } from '../services/auth';
import {
  fetchLatestForecast,
  generateForecast,
  type ForecastLatestResponse,
  type ForecastRun,
  type InsufficientHistoryData,
  type RiskAlert,
  type FinancialExplanation,
} from '../services/forecast';
import { WhatIfSimulator } from '../components/simulator/WhatIfSimulator';
import { useTheme } from '../context/ThemeContext';

type ApiHealth =
  | { state: 'checking' }
  | { state: 'online'; service: string }
  | { state: 'offline'; message: string };

interface DashboardPageProps {
  user?: AuthUser;
  onLogout?: () => void;
}

const demoData = {
  openingBalancePaise: 6_200_000n,
  expectedReceiptsPaise: 2_200_000n,
  supplierBillPaise: 4_800_000n,
  rentPaise: 1_800_000n,
  bufferPaise: 2_500_000n,
  closingCashPaise: 1_800_000n,
  points: [
    { day: 0, balancePaise: 6_200_000n },
    { day: 5, balancePaise: 1_400_000n },
    { day: 6, balancePaise: 3_600_000n },
    { day: 8, balancePaise: 1_800_000n },
    { day: 30, balancePaise: 1_800_000n },
  ],
};

function formatPaise(paise: bigint): string {
  const isNegative = paise < 0n;
  const absolutePaise = isNegative ? -paise : paise;
  const rupees = absolutePaise / 100n;
  const cents = (absolutePaise % 100n).toString().padStart(2, '0');
  const formattedRupees = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 0,
  }).format(rupees);

  return `${isNegative ? '-' : ''}₹${formattedRupees}.${cents}`;
}

function formatDate(dateStr: string): string {
  try {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      const d = new Date(year, month, day);
      return new Intl.DateTimeFormat('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(d);
    }
    return dateStr;
  } catch {
    return dateStr;
  }
}

function ApiStatus({ health }: { health: ApiHealth }) {
  if (health.state === 'checking') {
    return (
      <span className="api-status api-status--checking">
        <LoaderCircle size={14} className="spin" aria-hidden="true" />
        Checking API
      </span>
    );
  }

  if (health.state === 'online') {
    return (
      <span className="api-status api-status--online">
        <span className="status-dot" aria-hidden="true" />
        API connected
      </span>
    );
  }

  return (
    <span className="api-status api-status--offline" title={health.message}>
      <span className="status-dot" aria-hidden="true" />
      API unavailable
    </span>
  );
}

function DemoForecastChart() {
  const width = 720;
  const left = 54;
  const right = 704;
  const top = 18;
  const bottom = 194;
  const maximumBalancePaise = 6_500_000n;
  const chartHeight = BigInt(bottom - top);
  const chartWidth = right - left;

  const points = demoData.points.map(({ day, balancePaise }) => {
    const x = left + (day / 30) * chartWidth;
    const boundedBalance = balancePaise > maximumBalancePaise
      ? maximumBalancePaise
      : balancePaise;
    const y = bottom - Number((boundedBalance * chartHeight) / maximumBalancePaise);
    return { x, y };
  });

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${bottom} L ${points[0].x} ${bottom} Z`;
  const bufferY = bottom - Number((demoData.bufferPaise * chartHeight) / maximumBalancePaise);

  return (
    <div className="chart-wrap">
      <svg
        className="forecast-chart"
        viewBox={`0 0 ${width} 236`}
        role="img"
        aria-label="Demo forecast: opening cash of 62,000 rupees, falling to 14,000 on day five, recovering to 36,000 on day six, then ending at 18,000."
      >
        <defs>
          <linearGradient id="cash-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#27966f" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#27966f" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {[0, 2, 4, 6].map((thousands) => {
          const y = bottom - (thousands * 1_000_000 / 100) * (bottom - top) / 65_000;
          return (
            <g key={thousands}>
              <line x1={left} x2={right} y1={y} y2={y} className="chart-grid" />
              <text x="0" y={y + 4} className="chart-label">
                ₹{thousands === 0 ? '0' : `${thousands}0`}k
              </text>
            </g>
          );
        })}
        <line x1={left} x2={right} y1={bufferY} y2={bufferY} className="chart-buffer" />
        <text x={right - 4} y={bufferY - 7} textAnchor="end" className="chart-buffer-label">
          Demo buffer · ₹25k
        </text>
        <path d={areaPath} fill="url(#cash-area)" />
        <path d={linePath} className="chart-line" />
        {points.map((point, index) => (
          <circle
            key={demoData.points[index].day}
            cx={point.x}
            cy={point.y}
            r={index === 1 ? 5 : 3.5}
            className={index === 1 ? 'chart-point chart-point--risk' : 'chart-point'}
          />
        ))}
        {[
          { day: 0, label: 'Today' },
          { day: 5, label: 'Day 5' },
          { day: 8, label: 'Day 8' },
          { day: 30, label: 'Day 30' },
        ].map(({ day, label }) => (
          <text
            key={day}
            x={left + (day / 30) * chartWidth}
            y="222"
            textAnchor={day === 0 ? 'start' : day === 30 ? 'end' : 'middle'}
            className="chart-label"
          >
            {label}
          </text>
        ))}
      </svg>
      <div className="chart-legend">
        <span><i className="legend-dot legend-dot--cash" /> Projected closing cash (Demo)</span>
        <span><i className="legend-dot legend-dot--buffer" /> Minimum cash buffer (Demo)</span>
      </div>
    </div>
  );
}

function RealForecastChart({ run }: { run: ForecastRun }) {
  const width = 720;
  const left = 60;
  const right = 700;
  const top = 24;
  const bottom = 188;
  const chartWidth = right - left;
  const chartHeight = bottom - top;

  const points = run.points;
  const bufferPaise = BigInt(run.minimum_cash_buffer_paise || '0');

  // Balances
  const balances = points.map((p) => BigInt(p.closing_predicted_paise));
  const allValues = [...balances, bufferPaise, BigInt(run.opening_confirmed_paise)];

  let maxVal = allValues.reduce((max, v) => (v > max ? v : max), 0n);
  let minVal = allValues.reduce((min, v) => (v < min ? v : min), 0n);

  if (maxVal === minVal) {
    maxVal = maxVal + 100000n;
  }
  const range = maxVal - minVal;

  const getCoord = (index: number, val: bigint) => {
    const x = left + (index / (points.length - 1)) * chartWidth;
    const norm = Number(val - minVal) / Number(range || 1n);
    const y = bottom - norm * chartHeight;
    return { x, y };
  };

  const svgPoints = points.map((p, idx) => getCoord(idx, BigInt(p.closing_predicted_paise)));
  const linePath = svgPoints
    .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L ${svgPoints[svgPoints.length - 1].x.toFixed(1)} ${bottom} L ${svgPoints[0].x.toFixed(1)} ${bottom} Z`;

  const bufferY =
    bufferPaise > 0n
      ? bottom - (Number(bufferPaise - minVal) / Number(range || 1n)) * chartHeight
      : null;

  const gridLevels = [0, 0.33, 0.66, 1].map((fraction) => {
    const val = minVal + BigInt(Math.round(fraction * Number(range)));
    const y = bottom - fraction * chartHeight;
    return { val, y };
  });

  const totalInflowsPaise = points.reduce(
    (acc, p) =>
      acc +
      BigInt(p.confirmed_inflow_paise) +
      BigInt(p.estimated_inflow_paise) +
      BigInt(p.predicted_inflow_paise),
    0n
  );
  const totalOutflowsPaise = points.reduce(
    (acc, p) =>
      acc +
      BigInt(p.confirmed_outflow_paise) +
      BigInt(p.estimated_outflow_paise) +
      BigInt(p.predicted_outflow_paise),
    0n
  );

  const latestUncertainty = points[points.length - 1]?.uncertainty_band || 'LOW';

  return (
    <div className="chart-wrap">
      {/* 30-Day Projection Metrics Bar */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: 12,
          marginBottom: 16,
          padding: '12px 16px',
          background: '#f8faf9',
          borderRadius: 8,
          border: '1px solid #e5eae6',
        }}
      >
        <div>
          <span
            style={{
              fontSize: 11,
              color: '#78827d',
              display: 'block',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            Opening Cash
          </span>
          <strong style={{ fontSize: 15, color: '#17241f' }}>
            {formatPaise(BigInt(run.opening_confirmed_paise))}
          </strong>
        </div>
        <div>
          <span
            style={{
              fontSize: 11,
              color: '#78827d',
              display: 'block',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            Projected Day 30
          </span>
          <strong
            style={{
              fontSize: 15,
              color:
                BigInt(points[points.length - 1]?.closing_predicted_paise || '0') >= 0n
                  ? '#16a34a'
                  : '#dc2626',
            }}
          >
            {formatPaise(BigInt(points[points.length - 1]?.closing_predicted_paise || '0'))}
          </strong>
        </div>
        <div>
          <span
            style={{
              fontSize: 11,
              color: '#78827d',
              display: 'block',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            30-Day Inflows
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#16a34a' }}>
            +{formatPaise(totalInflowsPaise)}
          </span>
        </div>
        <div>
          <span
            style={{
              fontSize: 11,
              color: '#78827d',
              display: 'block',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            30-Day Outflows
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#ea580c' }}>
            −{formatPaise(totalOutflowsPaise)}
          </span>
        </div>
        <div>
          <span
            style={{
              fontSize: 11,
              color: '#78827d',
              display: 'block',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            Model Engine
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: '#238866',
              background: '#ecfdf5',
              padding: '2px 6px',
              borderRadius: 4,
            }}
          >
            {run.method_name === 'DETERMINISTIC_ROLL_FORWARD' ? 'Python Forecast Engine' : 'Baseline Statistical Projection'}
          </span>
        </div>
      </div>

      <svg
        className="forecast-chart"
        viewBox={`0 0 ${width} 240`}
        role="img"
        aria-label="30-day verified cash flow forecast"
      >
        <defs>
          <linearGradient id="real-cash-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#238866" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#238866" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {gridLevels.map(({ val, y }, idx) => (
          <g key={idx}>
            <line x1={left} x2={right} y1={y} y2={y} className="chart-grid" />
            <text x={left - 8} y={y + 4} textAnchor="end" className="chart-label">
              {formatPaise(val).replace(/\.00$/, '')}
            </text>
          </g>
        ))}

        {bufferY !== null && bufferY >= top && bufferY <= bottom && (
          <g>
            <line x1={left} x2={right} y1={bufferY} y2={bufferY} className="chart-buffer" />
            <text x={right - 4} y={bufferY - 6} textAnchor="end" className="chart-buffer-label">
              Operating buffer · {formatPaise(bufferPaise).replace(/\.00$/, '')}
            </text>
          </g>
        )}

        <path d={areaPath} fill="url(#real-cash-area)" />
        <path d={linePath} className="chart-line" />

        {[0, 6, 13, 20, 29].map((pointIdx) => {
          const pt = svgPoints[pointIdx];
          const pointData = points[pointIdx];
          if (!pt || !pointData) return null;
          const isBreach =
            bufferPaise > 0n && BigInt(pointData.closing_predicted_paise) < bufferPaise;

          return (
            <g key={pointIdx}>
              <circle
                cx={pt.x}
                cy={pt.y}
                r={isBreach ? 5.5 : 4}
                className={isBreach ? 'chart-point chart-point--risk' : 'chart-point'}
              />
              <text
                x={pt.x}
                y="226"
                textAnchor={pointIdx === 0 ? 'start' : pointIdx === 29 ? 'end' : 'middle'}
                className="chart-label"
              >
                {pointIdx === 0 ? 'Today' : `Day ${pointIdx + 1}`}
              </text>
            </g>
          );
        })}
      </svg>

      <div
        className="chart-legend"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 10,
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', gap: 14 }}>
          <span>
            <i className="legend-dot legend-dot--cash" /> Projected closing cash (Real)
          </span>
          {bufferPaise > 0n && (
            <span>
              <i className="legend-dot legend-dot--buffer" /> Minimum cash buffer
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#78827d' }}>
            Uncertainty Band: <strong style={{ color: '#17241f' }}>{latestUncertainty}</strong>
          </span>
          <span style={{ fontSize: 11, color: '#78827d' }}>
            Data Quality: <strong style={{ color: '#17241f' }}>{run.data_quality}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}

function InsufficientHistoryCard({
  data,
  onGenerate,
  isGenerating,
  onPreviewDemo,
}: {
  data: InsufficientHistoryData;
  onGenerate: () => void;
  isGenerating: boolean;
  onPreviewDemo: () => void;
}) {
  const minCalDays = data.min_calendar_days_required || 14;
  const minActDays = data.min_distinct_days_required || 7;
  const minTxCount = data.min_transactions_required || 7;

  const calCoveragePercent = Math.min(
    100,
    Math.round((data.calendar_days_coverage / minCalDays) * 100)
  );
  const activeDaysPercent = Math.min(
    100,
    Math.round((data.distinct_days_recorded / minActDays) * 100)
  );
  const txCountPercent = Math.min(
    100,
    Math.round((data.transaction_count / minTxCount) * 100)
  );

  const isEligibleToGenerate =
    data.calendar_days_coverage >= minCalDays &&
    data.distinct_days_recorded >= minActDays &&
    data.transaction_count >= minTxCount;

  return (
    <div style={{ padding: '32px 24px', textAlign: 'center' }}>
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: '#fef3c7',
          color: '#b45309',
          display: 'grid',
          placeItems: 'center',
          margin: '0 auto 12px',
        }}
      >
        <Clock3 size={22} aria-hidden="true" />
      </div>

      <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700, color: '#17241f' }}>
        Insufficient Historical Data
      </h3>

      <p
        style={{
          maxWidth: 540,
          margin: '0 auto 20px',
          color: '#58655c',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Predictive cash-flow forecasting requires at least{' '}
        <strong>14 calendar days</strong> of historical coverage and at least{' '}
        <strong>7 active transaction days</strong> to calculate reliable daily cash velocity without
        fabricating synthetic data.
      </p>

      {/* Three Progress Indicators Container */}
      <div
        style={{
          maxWidth: 480,
          margin: '0 auto 20px',
          background: '#f8faf9',
          border: '1px solid #e5eae6',
          borderRadius: 10,
          padding: '16px 20px',
          textAlign: 'left',
        }}
      >
        {/* Indicator 1: Calendar coverage */}
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 12,
              marginBottom: 6,
            }}
          >
            <span style={{ color: '#404c45', fontWeight: 600 }}>Calendar coverage</span>
            <strong style={{ color: calCoveragePercent >= 100 ? '#238866' : '#2d3731' }}>
              {data.calendar_days_coverage} / {minCalDays} days ({calCoveragePercent}%)
            </strong>
          </div>
          <div
            style={{
              width: '100%',
              height: 8,
              background: '#e2e8e4',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${calCoveragePercent}%`,
                height: '100%',
                background: calCoveragePercent >= 100 ? '#238866' : '#eab308',
                borderRadius: 4,
                transition: 'width 0.4s ease',
              }}
            />
          </div>
        </div>

        {/* Indicator 2: Active transaction days */}
        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 12,
              marginBottom: 6,
            }}
          >
            <span style={{ color: '#404c45', fontWeight: 600 }}>Active transaction days</span>
            <strong style={{ color: activeDaysPercent >= 100 ? '#238866' : '#2d3731' }}>
              {data.distinct_days_recorded} / {minActDays} active days ({activeDaysPercent}%)
            </strong>
          </div>
          <div
            style={{
              width: '100%',
              height: 8,
              background: '#e2e8e4',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${activeDaysPercent}%`,
                height: '100%',
                background: activeDaysPercent >= 100 ? '#238866' : '#eab308',
                borderRadius: 4,
                transition: 'width 0.4s ease',
              }}
            />
          </div>
        </div>

        {/* Indicator 3: Total transactions */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 12,
              marginBottom: 6,
            }}
          >
            <span style={{ color: '#404c45', fontWeight: 600 }}>Total transactions</span>
            <strong style={{ color: txCountPercent >= 100 ? '#238866' : '#2d3731' }}>
              {data.transaction_count} / {minTxCount} transactions ({txCountPercent}%)
            </strong>
          </div>
          <div
            style={{
              width: '100%',
              height: 8,
              background: '#e2e8e4',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${txCountPercent}%`,
                height: '100%',
                background: txCountPercent >= 100 ? '#238866' : '#eab308',
                borderRadius: 4,
                transition: 'width 0.4s ease',
              }}
            />
          </div>
        </div>

        {/* Explanation note for active days */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '10px 12px',
            background: '#ffffff',
            border: '1px solid #e2e8e4',
            borderRadius: 6,
            fontSize: 11,
            color: '#58655c',
            lineHeight: 1.45,
          }}
        >
          <Info size={14} style={{ color: '#238866', flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <span>
            Multiple transactions occurring on the same date count as only <strong>one active day</strong>. Reliable cash forecasting requires consistent activity across distinct dates.
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
        {isEligibleToGenerate ? (
          <button
            type="button"
            className="button button--primary"
            onClick={onGenerate}
            disabled={isGenerating}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: '#238866',
              color: '#ffffff',
              padding: '9px 18px',
              borderRadius: 8,
              border: 'none',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {isGenerating && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
            Generate 30-Day Forecast
          </button>
        ) : null}

        <button
          type="button"
          className="button button--secondary"
          onClick={onPreviewDemo}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 16px',
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          <Sparkles size={14} aria-hidden="true" />
          Preview Sample 30-Day Model (Demo)
        </button>
      </div>
    </div>
  );
}

function RealEarlyWarningCard({
  alerts,
  minimumBufferPaise,
  hasSufficientHistory,
  demoMode,
}: {
  alerts: RiskAlert[];
  minimumBufferPaise: bigint;
  hasSufficientHistory: boolean;
  demoMode: boolean;
}) {
  if (demoMode) {
    return (
      <div className="risk-detail">
        <div className="risk-date">
          <ShieldAlert size={19} aria-hidden="true" />
          <strong>Projected in 5 days</strong>
        </div>
        <p>
          Cash may fall to {formatPaise(demoData.points[1].balancePaise)}, below the{' '}
          {formatPaise(demoData.bufferPaise)} demo operating buffer.
        </p>
        <div className="risk-cause">
          <span className="risk-cause__line" aria-hidden="true" />
          <span>
            <strong>Largest driver</strong>
            <small>Deccan Wholesale · supplier bill</small>
          </span>
          <b>{formatPaise(demoData.supplierBillPaise)}</b>
        </div>
        <p className="risk-note">Demo scenario only · not a real alert</p>
      </div>
    );
  }

  if (!hasSufficientHistory) {
    return (
      <div className="panel-empty" style={{ padding: '36px 16px' }}>
        <ShieldAlert size={22} aria-hidden="true" style={{ marginBottom: 8, color: '#9ca3af' }} />
        <strong>Buffer risk assessment calibrating</strong>
        <span style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
          Automated buffer breach warnings trigger once 14 calendar days of transaction history calibrate your daily cash runway.
        </span>
      </div>
    );
  }

  if (alerts.length > 0) {
    const primaryAlert = alerts[0];
    const isCritical = primaryAlert.severity === 'CRITICAL';
    const projBalance = BigInt(primaryAlert.projected_balance_paise);
    const threshold = BigInt(primaryAlert.threshold_paise);
    const shortfall = threshold > projBalance ? threshold - projBalance : 0n;

    return (
      <div className="risk-detail" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div className="risk-date" style={{ color: isCritical ? '#dc2626' : '#ea580c', margin: 0 }}>
            <ShieldAlert size={19} aria-hidden="true" />
            <strong>Projected Breach on {formatDate(primaryAlert.projected_date)}</strong>
          </div>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 8px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              background: isCritical ? '#fee2e2' : '#ffedd5',
              color: isCritical ? '#991b1b' : '#9a3412',
              border: `1px solid ${isCritical ? '#fca5a5' : '#fed7aa'}`,
            }}
          >
            {primaryAlert.severity} RISK
          </span>
        </div>

        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#17241f' }}>
          Projected cash falls to <strong>{formatPaise(projBalance)}</strong>, dipping below the{' '}
          <strong>{formatPaise(threshold)}</strong> required operating buffer.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: 8,
            marginTop: 4,
          }}
        >
          <div
            style={{
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              padding: '8px 10px',
            }}
          >
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Expected Breach</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#17241f' }}>
              {formatDate(primaryAlert.projected_date)}
            </div>
          </div>

          <div
            style={{
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              padding: '8px 10px',
            }}
          >
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Projected Balance</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: projBalance < 0n ? '#dc2626' : '#17241f' }}>
              {formatPaise(projBalance)}
            </div>
          </div>

          <div
            style={{
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              padding: '8px 10px',
            }}
          >
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>Minimum Buffer</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#17241f' }}>
              {formatPaise(threshold)}
            </div>
          </div>

          <div
            style={{
              background: '#fff7ed',
              border: '1px solid #fed7aa',
              borderRadius: 6,
              padding: '8px 10px',
            }}
          >
            <div style={{ fontSize: 11, color: '#c2410c', marginBottom: 2 }}>Shortfall Amount</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#c2410c' }}>
              −{formatPaise(shortfall)}
            </div>
          </div>
        </div>

        <p className="risk-note" style={{ color: '#6b7280', margin: 0, fontSize: 12 }}>
          {primaryAlert.explanation}
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: '28px 16px', textAlign: 'center' }}>
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: '#ecfdf5',
          color: '#16a34a',
          display: 'grid',
          placeItems: 'center',
          margin: '0 auto 12px',
        }}
      >
        <CheckCircle2 size={24} aria-hidden="true" />
      </div>
      <strong style={{ fontSize: 15, color: '#17241f', display: 'block', marginBottom: 6 }}>
        Operating Buffer Protected
      </strong>
      <p
        style={{
          fontSize: 12,
          color: '#58655c',
          margin: '0 auto 14px',
          maxWidth: 320,
          lineHeight: 1.5,
        }}
      >
        Your projected cash balance remains safely above the required minimum buffer of{' '}
        <strong>{formatPaise(minimumBufferPaise)}</strong> across all 30 projected days.
      </p>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 10px',
          borderRadius: 12,
          fontSize: 11,
          fontWeight: 600,
          background: '#e9f5ef',
          color: '#238866',
        }}
      >
        <CheckCircle2 size={12} aria-hidden="true" /> Verified Zero Breach Horizon
      </span>
    </div>
  );
}

function EmptyForecast({ onPreviewDemo }: { onPreviewDemo: () => void }) {
  return (
    <div className="empty-forecast" style={{ padding: '36px 20px', textAlign: 'center' }}>
      <div className="empty-forecast__icon" style={{ margin: '0 auto 12px' }}>
        <Activity size={24} aria-hidden="true" />
      </div>
      <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Automated Cash Forecast Unavailable</h3>
      <p style={{ maxWidth: 460, margin: '0 auto 16px', color: '#6b7280', fontSize: 13, lineHeight: 1.5 }}>
        Predictive forecasting requires sustained transaction history (typically 14+ days) to compute daily cash runway and burn variance. As you record transactions, forecasting intelligence will calibrate automatically.
      </p>
      <button
        type="button"
        className="button button--secondary"
        onClick={onPreviewDemo}
        style={{ fontSize: 13 }}
      >
        <Sparkles size={14} aria-hidden="true" style={{ marginRight: 6 }} />
        Preview Sample 30-Day Model
      </button>
    </div>
  );
}

function FinancialExplanationsSection({
  explanations,
  isLoading,
  hasSufficientHistory,
  demoMode,
}: {
  explanations?: FinancialExplanation[];
  isLoading: boolean;
  hasSufficientHistory: boolean;
  demoMode: boolean;
}) {
  const displayExplanations = demoMode
    ? [
        {
          id: 'demo_exp_1',
          category: 'PAYABLE_OBLIGATION' as const,
          title: 'Upcoming Payment: Deccan Wholesale',
          text: 'Confirmed supplier bill of ₹4,20,000.00 to Deccan Wholesale scheduled on Day 5 reduces projected cash reserves.',
          date: 'Day 5',
          amount_paise: '42000000',
          certainty: 'CONFIRMED' as const,
          severity: 'WARNING' as const,
          source_type: 'PAYABLE' as const,
        },
        {
          id: 'demo_exp_2',
          category: 'EXPECTED_RECEIVABLE' as const,
          title: 'Expected Inflow: Retail Distributions',
          text: 'Confirmed customer invoice receipts totaling ₹3,80,000.00 expected across the 30-day runway support operating cash.',
          date: 'Day 12',
          amount_paise: '38000000',
          certainty: 'CONFIRMED' as const,
          severity: 'INFO' as const,
          source_type: 'RECEIVABLE' as const,
        },
        {
          id: 'demo_exp_3',
          category: 'BUFFER_BREACH' as const,
          title: 'Operating Cash Buffer Breach Expected',
          text: 'Projected closing balance dips to ₹1,20,000.00 on Day 5, creating a shortfall of ₹80,000.00 below the ₹2,00,000.00 buffer.',
          date: 'Day 5',
          amount_paise: '800000',
          certainty: 'CONFIRMED' as const,
          severity: 'WARNING' as const,
          source_type: 'RISK_ALERT' as const,
        },
      ]
    : explanations || [];

  return (
    <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-heading" style={{ marginBottom: 16 }}>
        <div>
          <div className="panel-title-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={18} aria-hidden="true" style={{ color: '#238866' }} />
            <h2 style={{ fontSize: 16, margin: 0 }}>Financial Intelligence & Drivers</h2>
            {demoMode && <span className="data-tag">DEMO</span>}
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Data-backed explanations of cash position changes, liquidity drivers, and risk factors.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div style={{ padding: '32px 16px', textAlign: 'center', color: '#6b7280' }}>
          <LoaderCircle size={22} className="spin" style={{ margin: '0 auto 8px' }} />
          <span>Analyzing financial movements...</span>
        </div>
      ) : !hasSufficientHistory && !demoMode ? (
        <div style={{ padding: '24px 16px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <Info size={20} style={{ color: '#6b7280', flexShrink: 0, marginTop: 2 }} />
            <div>
              <strong style={{ fontSize: 14, color: '#17241f', display: 'block', marginBottom: 4 }}>
                Awaiting Historical Calibration
              </strong>
              <p style={{ margin: 0, fontSize: 13, color: '#4b5563', lineHeight: 1.5 }}>
                {displayExplanations.find((e) => e.category === 'INSUFFICIENT_HISTORY')?.text ||
                  'Automated financial explanations activate once your 14-day historical transaction baseline is calibrated.'}
              </p>
            </div>
          </div>
        </div>
      ) : displayExplanations.length === 0 ? (
        <div style={{ padding: '24px 16px', textAlign: 'center', color: '#6b7280', background: '#f9fafb', borderRadius: 8 }}>
          <CheckCircle2 size={22} style={{ color: '#10b981', margin: '0 auto 6px' }} />
          <strong style={{ display: 'block', fontSize: 14, color: '#17241f', marginBottom: 2 }}>
            No Active Risk Drivers
          </strong>
          <span style={{ fontSize: 13 }}>
            Projected cash flow is stable with no upcoming buffer breaches or obligations recorded.
          </span>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 12,
          }}
        >
          {displayExplanations.map((item) => {
            const isCritical = item.severity === 'CRITICAL';
            const isWarning = item.severity === 'WARNING';
            const isRec = item.category === 'EXPECTED_RECEIVABLE';
            const isPay = item.category === 'PAYABLE_OBLIGATION';
            const isImp = item.category === 'CASH_FLOW_IMPROVEMENT';

            const borderColor = isCritical ? '#fca5a5' : isWarning ? '#fed7aa' : isImp ? '#a7f3d0' : '#e5e7eb';
            const bgHeader = isCritical ? '#fef2f2' : isWarning ? '#fff7ed' : isImp ? '#ecfdf5' : '#f9fafb';

            return (
              <div
                key={item.id}
                style={{
                  border: `1px solid ${borderColor}`,
                  borderRadius: 8,
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  background: '#ffffff',
                }}
              >
                <div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: bgHeader,
                        color: isCritical ? '#991b1b' : isWarning ? '#9a3412' : isImp ? '#065f46' : '#4b5563',
                      }}
                    >
                      {item.category.replace(/_/g, ' ')}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {item.certainty && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            padding: '1px 5px',
                            borderRadius: 4,
                            background: item.certainty === 'CONFIRMED' ? '#e0f2fe' : '#f3f4f6',
                            color: item.certainty === 'CONFIRMED' ? '#0369a1' : '#4b5563',
                          }}
                        >
                          {item.certainty}
                        </span>
                      )}
                      {item.severity !== 'INFO' && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '1px 5px',
                            borderRadius: 4,
                            background: isCritical ? '#fee2e2' : '#ffedd5',
                            color: isCritical ? '#b91c1c' : '#c2410c',
                          }}
                        >
                          {item.severity}
                        </span>
                      )}
                    </div>
                  </div>

                  <strong style={{ fontSize: 13, color: '#17241f', display: 'block', marginBottom: 6 }}>
                    {item.title}
                  </strong>
                  <p style={{ fontSize: 12, color: '#4b5563', lineHeight: 1.5, margin: 0 }}>
                    {item.text}
                  </p>
                </div>

                {(item.date || item.amount_paise) && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: 12,
                      paddingTop: 8,
                      borderTop: '1px solid #f3f4f6',
                      fontSize: 12,
                    }}
                  >
                    {item.date ? (
                      <span style={{ color: '#6b7280', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <CalendarDays size={13} aria-hidden="true" />
                        {item.date}
                      </span>
                    ) : <span />}

                    {item.amount_paise ? (
                      <strong
                        style={{
                          color: isCritical || isPay ? '#dc2626' : isRec || isImp ? '#16a34a' : '#17241f',
                          fontWeight: 700,
                        }}
                      >
                        {isPay ? '−' : isRec || isImp ? '+' : ''}
                        {formatPaise(BigInt(item.amount_paise))}
                      </strong>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function DashboardPage({ user, onLogout }: DashboardPageProps) {
  const [health, setHealth] = useState<ApiHealth>({ state: 'checking' });
  const [retryCount, setRetryCount] = useState(0);
  const [demoMode, setDemoMode] = useState(false);
  const { preference, setPreference } = useTheme();

  // Real financial transaction state
  const [summary, setSummary] = useState<TransactionSummary | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [categories, setCategories] = useState<TransactionCategory[]>([]);
  const [isLoadingFinancials, setIsLoadingFinancials] = useState(true);
  const [financialsError, setFinancialsError] = useState<string | null>(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [paginationInfo, setPaginationInfo] = useState<PaginationInfo | null>(null);
  const pageSize = 10;

  // Real cash-flow forecast state
  const [forecastData, setForecastData] = useState<ForecastLatestResponse | null>(null);
  const [isLoadingForecast, setIsLoadingForecast] = useState(true);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [isGeneratingForecast, setIsGeneratingForecast] = useState(false);

  // Add Transaction Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formType, setFormType] = useState<'income' | 'expense'>('income');
  const [formAmount, setFormAmount] = useState('');
  const [formCategoryId, setFormCategoryId] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formDate, setFormDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Edit Transaction Modal state
  const [editingTransaction, setEditingTransaction] = useState<TransactionItem | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);

  // Delete Transaction Modal state
  const [deletingTransaction, setDeletingTransaction] = useState<TransactionItem | null>(null);
  const [isSubmittingDelete, setIsSubmittingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Transaction Search and Filters state
  const [filterSearch, setFilterSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');
  const [filterCategoryId, setFilterCategoryId] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [isFiltering, setIsFiltering] = useState(false);
  const [filterError, setFilterError] = useState<string | null>(null);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filterSearch.trim()) count++;
    if (filterType !== 'all') count++;
    if (filterCategoryId) count++;
    if (filterStartDate) count++;
    if (filterEndDate) count++;
    return count;
  }, [filterSearch, filterType, filterCategoryId, filterStartDate, filterEndDate]);

  const handleClearFilters = useCallback(() => {
    setFilterSearch('');
    setFilterType('all');
    setFilterCategoryId('');
    setFilterStartDate('');
    setFilterEndDate('');
    setFilterError(null);
    setCurrentPage(1);
  }, []);

  // Filter categories matching the editing transaction direction
  const editAvailableCategories = useMemo(() => {
    if (!editingTransaction) return [];
    return categories.filter(
      (c) =>
        (c.is_active === undefined || c.is_active) &&
        (c.allowed_direction === 'BOTH' || c.allowed_direction === editingTransaction.cash_direction)
    );
  }, [categories, editingTransaction]);

  const handleOpenEditTransaction = (tx: TransactionItem) => {
    setEditingTransaction(tx);
    setEditError(null);
    const amountRupees = tx.amount_rupees !== undefined
      ? tx.amount_rupees.toFixed(2)
      : (Number(tx.amount_paise) / 100).toFixed(2);
    setEditAmount(amountRupees);
    setEditDescription(tx.description || tx.counterparty_name || '');
    setEditDate(tx.transaction_date ? tx.transaction_date.slice(0, 10) : new Date().toISOString().slice(0, 10));

    // Resolve valid category for this transaction's direction
    const valid = categories.filter(
      (c) =>
        (c.is_active === undefined || c.is_active) &&
        (c.allowed_direction === 'BOTH' || c.allowed_direction === tx.cash_direction)
    );
    const hasCurrent = tx.category_id && valid.some((c) => c.id === tx.category_id);
    setEditCategoryId(hasCurrent ? (tx.category_id as string) : (valid[0]?.id || ''));
  };

  async function handleEditTransactionSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editingTransaction) return;
    setEditError(null);

    const parsedAmount = parseFloat(editAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setEditError('Please enter a valid amount greater than zero.');
      return;
    }

    if (!editDate || !/^\d{4}-\d{2}-\d{2}$/.test(editDate)) {
      setEditError('Please select a valid transaction date (YYYY-MM-DD).');
      return;
    }

    if (!editCategoryId) {
      setEditError('Please select a valid category for this transaction.');
      return;
    }

    const selectedCategory = categories.find((c) => c.id === editCategoryId);
    if (!selectedCategory) {
      setEditError('The selected category does not exist. Please choose a valid category.');
      return;
    }

    if (
      selectedCategory.allowed_direction !== 'BOTH' &&
      selectedCategory.allowed_direction !== editingTransaction.cash_direction
    ) {
      setEditError(
        `Category "${selectedCategory.display_name}" is only allowed for ${
          selectedCategory.allowed_direction === 'INFLOW' ? 'income (inflow)' : 'expense (outflow)'
        } transactions and cannot be used for this ${
          editingTransaction.cash_direction === 'INFLOW' ? 'income' : 'expense'
        } transaction.`
      );
      return;
    }

    setIsSubmittingEdit(true);

    try {
      await updateTransaction(editingTransaction.id, {
        amount: parsedAmount.toFixed(2),
        category_id: editCategoryId,
        category: selectedCategory.display_name,
        description: editDescription.trim() || undefined,
        transaction_date: editDate,
      });

      setEditingTransaction(null);
      setActionSuccess(
        `Updated ${editingTransaction.cash_direction === 'INFLOW' ? 'income' : 'expense'} transaction to ₹${parsedAmount.toLocaleString('en-IN')}`
      );
      setTimeout(() => setActionSuccess(null), 5000);

      await Promise.all([loadFinancialData(), loadForecastData()]);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update transaction. Please try again.');
    } finally {
      setIsSubmittingEdit(false);
    }
  }

  const handleOpenDeleteTransaction = (tx: TransactionItem) => {
    setDeletingTransaction(tx);
    setDeleteError(null);
    setIsSubmittingDelete(false);
  };

  async function handleConfirmDelete() {
    if (!deletingTransaction || isSubmittingDelete) return;
    setDeleteError(null);
    setIsSubmittingDelete(true);

    try {
      await deleteTransaction(deletingTransaction.id);
      const directionLabel = deletingTransaction.cash_direction === 'INFLOW' ? 'income' : 'expense';
      const amount = deletingTransaction.amount_rupees !== undefined
        ? deletingTransaction.amount_rupees.toLocaleString('en-IN')
        : (Number(deletingTransaction.amount_paise) / 100).toLocaleString('en-IN');

      setDeletingTransaction(null);
      setActionSuccess(`Successfully deleted ${directionLabel} transaction of ₹${amount}.`);
      setTimeout(() => setActionSuccess(null), 5000);

      await Promise.all([loadFinancialData(), loadForecastData()]);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete transaction. Please try again.');
    } finally {
      setIsSubmittingDelete(false);
    }
  }

  // Filter categories matching the currently selected transaction direction
  const availableCategories = useMemo(() => {
    const currentDirection = formType === 'income' ? 'INFLOW' : 'OUTFLOW';
    return categories.filter(
      (c) =>
        (c.is_active === undefined || c.is_active) &&
        (c.allowed_direction === 'BOTH' || c.allowed_direction === currentDirection)
    );
  }, [categories, formType]);

  // Keep selected category valid whenever available categories change
  useEffect(() => {
    if (availableCategories.length > 0) {
      const isCurrentValid = availableCategories.some((c) => c.id === formCategoryId);
      if (!isCurrentValid) {
        setFormCategoryId(availableCategories[0].id);
      }
    } else {
      setFormCategoryId('');
    }
  }, [availableCategories, formCategoryId]);

  // When transaction direction changes, reset the selected category to a valid category for the new direction
  const handleDirectionChange = (newType: 'income' | 'expense') => {
    setFormType(newType);
    setFormError(null);
    const targetDirection = newType === 'income' ? 'INFLOW' : 'OUTFLOW';
    const validCategories = categories.filter(
      (c) =>
        (c.is_active === undefined || c.is_active) &&
        (c.allowed_direction === 'BOTH' || c.allowed_direction === targetDirection)
    );
    setFormCategoryId(validCategories[0]?.id || '');
  };

  // Open transaction modal with pre-initialized valid category for current direction
  const handleOpenAddTransaction = () => {
    setIsModalOpen(true);
    setFormError(null);
    const targetDirection = formType === 'income' ? 'INFLOW' : 'OUTFLOW';
    const valid = categories.filter(
      (c) =>
        (c.is_active === undefined || c.is_active) &&
        (c.allowed_direction === 'BOTH' || c.allowed_direction === targetDirection)
    );
    if (valid.length > 0 && (!formCategoryId || !valid.some((c) => c.id === formCategoryId))) {
      setFormCategoryId(valid[0].id);
    }
  };

  // Health check
  useEffect(() => {
    const controller = new AbortController();
    setHealth({ state: 'checking' });

    checkApiHealth(controller.signal)
      .then((service) => setHealth({ state: 'online', service }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setHealth({
          state: 'offline',
          message: error instanceof Error ? error.message : 'Unknown API health error.',
        });
      });

    return () => controller.abort();
  }, [retryCount]);

  // Load filtered transactions from backend using active search & filter states with server-side pagination
  const loadFilteredTransactions = useCallback(async (overrides?: {
    search?: string;
    type?: 'all' | 'income' | 'expense';
    categoryId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
  }) => {
    const searchVal = overrides?.search !== undefined ? overrides.search : filterSearch;
    const typeVal = overrides?.type !== undefined ? overrides.type : filterType;
    const catVal = overrides?.categoryId !== undefined ? overrides.categoryId : filterCategoryId;
    const startVal = overrides?.startDate !== undefined ? overrides.startDate : filterStartDate;
    const endVal = overrides?.endDate !== undefined ? overrides.endDate : filterEndDate;
    const pageVal = overrides?.page !== undefined ? overrides.page : currentPage;

    if (startVal && endVal && startVal > endVal) {
      setFilterError('Start date cannot be after end date.');
      return;
    }
    setFilterError(null);
    setIsFiltering(true);

    try {
      const res = await fetchPaginatedTransactions({
        search: searchVal.trim() || undefined,
        type: typeVal !== 'all' ? typeVal : undefined,
        category_id: catVal || undefined,
        from_date: startVal || undefined,
        to_date: endVal || undefined,
        page: pageVal,
        limit: pageSize,
      });
      setTransactions(res.items);
      setPaginationInfo(res.pagination);
    } catch (err) {
      setFilterError(err instanceof Error ? err.message : 'Failed to filter transactions.');
    } finally {
      setIsFiltering(false);
    }
  }, [filterSearch, filterType, filterCategoryId, filterStartDate, filterEndDate, currentPage, pageSize]);

  // Re-fetch transactions with debounce when search/filters/page change
  useEffect(() => {
    const timer = setTimeout(() => {
      void loadFilteredTransactions();
    }, 250);
    return () => clearTimeout(timer);
  }, [loadFilteredTransactions]);

  // Reset to page 1 whenever search filters change
  const prevFiltersRef = useRef({ filterSearch, filterType, filterCategoryId, filterStartDate, filterEndDate });
  useEffect(() => {
    const prev = prevFiltersRef.current;
    if (
      prev.filterSearch !== filterSearch ||
      prev.filterType !== filterType ||
      prev.filterCategoryId !== filterCategoryId ||
      prev.filterStartDate !== filterStartDate ||
      prev.filterEndDate !== filterEndDate
    ) {
      prevFiltersRef.current = { filterSearch, filterType, filterCategoryId, filterStartDate, filterEndDate };
      setCurrentPage(1);
    }
  }, [filterSearch, filterType, filterCategoryId, filterStartDate, filterEndDate]);

  // If current page exceeds total pages (e.g. after deletion), navigate back to max available page
  useEffect(() => {
    if (paginationInfo && paginationInfo.total_pages > 0 && currentPage > paginationInfo.total_pages) {
      setCurrentPage(paginationInfo.total_pages);
    }
  }, [paginationInfo, currentPage]);

  const handlePrevPage = () => {
    if (currentPage > 1 && !isFiltering && !isLoadingFinancials) {
      setCurrentPage((prev) => prev - 1);
    }
  };

  const handleNextPage = () => {
    if (
      paginationInfo &&
      currentPage < paginationInfo.total_pages &&
      !isFiltering &&
      !isLoadingFinancials
    ) {
      setCurrentPage((prev) => prev + 1);
    }
  };

  // Load real financial data
  const loadFinancialData = useCallback(async () => {
    setIsLoadingFinancials(true);
    setFinancialsError(null);

    try {
      const [summaryData, catData] = await Promise.all([
        fetchTransactionSummary(),
        fetchCategories().catch(() => []),
      ]);

      setSummary(summaryData);
      setCategories(catData);

      await loadFilteredTransactions();

      const targetDirection = formType === 'income' ? 'INFLOW' : 'OUTFLOW';
      const available = catData.filter(
        (c) =>
          (c.is_active === undefined || c.is_active) &&
          (c.allowed_direction === 'BOTH' || c.allowed_direction === targetDirection)
      );
      if (available.length > 0) {
        setFormCategoryId((prev) => {
          const isValid = available.some((c) => c.id === prev);
          return isValid ? prev : available[0].id;
        });
      }
    } catch (err) {
      setFinancialsError(err instanceof Error ? err.message : 'Failed to load transaction data.');
    } finally {
      setIsLoadingFinancials(false);
    }
  }, [formType, loadFilteredTransactions]);

  // Load real forecast data
  const loadForecastData = useCallback(async () => {
    setIsLoadingForecast(true);
    setForecastError(null);

    try {
      const data = await fetchLatestForecast();
      setForecastData(data);
    } catch (err) {
      setForecastError(err instanceof Error ? err.message : 'Failed to load forecast data.');
    } finally {
      setIsLoadingForecast(false);
    }
  }, []);

  const handleGenerateForecast = useCallback(async () => {
    setIsGeneratingForecast(true);
    setForecastError(null);

    try {
      const data = await generateForecast({ horizon_days: 30 });
      setForecastData(data);
    } catch (err) {
      setForecastError(err instanceof Error ? err.message : 'Failed to generate forecast.');
    } finally {
      setIsGeneratingForecast(false);
    }
  }, []);

  useEffect(() => {
    void loadFinancialData();
    void loadForecastData();
  }, [loadFinancialData, loadForecastData, retryCount]);

  // Handle transaction creation
  async function handleAddTransactionSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsedAmount = parseFloat(formAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setFormError('Please enter a valid amount greater than zero.');
      return;
    }

    if (!formDate || !/^\d{4}-\d{2}-\d{2}$/.test(formDate)) {
      setFormError('Please select a valid transaction date (YYYY-MM-DD).');
      return;
    }

    // Category validation: existence and direction compatibility
    if (!formCategoryId) {
      setFormError('Please select a valid category for this transaction.');
      return;
    }

    const selectedCategory = categories.find((c) => c.id === formCategoryId);
    if (!selectedCategory) {
      setFormError('The selected category does not exist. Please choose a valid category.');
      return;
    }

    const expectedDirection = formType === 'income' ? 'INFLOW' : 'OUTFLOW';
    if (
      selectedCategory.allowed_direction !== 'BOTH' &&
      selectedCategory.allowed_direction !== expectedDirection
    ) {
      setFormError(
        `Category "${selectedCategory.display_name}" is only allowed for ${
          selectedCategory.allowed_direction === 'INFLOW' ? 'income (inflow)' : 'expense (outflow)'
        } transactions and cannot be used with ${formType === 'income' ? 'income' : 'expense'}.`
      );
      return;
    }

    setIsSubmitting(true);

    try {
      await createTransaction({
        type: formType,
        amount: parsedAmount.toFixed(2),
        category_id: formCategoryId,
        category: selectedCategory.display_name,
        description: formDescription.trim() || undefined,
        transaction_date: formDate,
      });

      // Reset form
      setFormAmount('');
      setFormDescription('');
      setFormDate(new Date().toISOString().slice(0, 10));

      // Reset selected category to a valid category for the current direction
      const currentValid = categories.filter(
        (c) =>
          (c.is_active === undefined || c.is_active) &&
          (c.allowed_direction === 'BOTH' || c.allowed_direction === expectedDirection)
      );
      setFormCategoryId(currentValid[0]?.id || '');
      setIsModalOpen(false);

      // Trigger instant refresh of figures
      setActionSuccess(`Recorded ${formType === 'income' ? 'income' : 'expense'} of ₹${parsedAmount.toLocaleString('en-IN')}`);
      setTimeout(() => setActionSuccess(null), 5000);

      await Promise.all([loadFinancialData(), loadForecastData()]);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to record transaction. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const today = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="Cashflow Sentinel dashboard">
          <span className="brand-mark"><Activity size={19} aria-hidden="true" /></span>
          <span className="brand-name">Cashflow<span>Sentinel</span></span>
        </a>

        <div className="workspace-picker">
          <span className="sidebar-caption">WORKSPACE</span>
          <button type="button" className="workspace-button" style={{ cursor: 'default' }}>
            <span className="workspace-avatar">
              {demoMode ? 'SL' : (user?.display_name ? user.display_name.slice(0, 2).toUpperCase() : 'CS')}
            </span>
            <span className="workspace-copy">
              <strong>{demoMode ? 'Shree Laxmi Kirana' : (user ? `${user.display_name}'s Business` : 'Active Business')}</strong>
              <small>{demoMode ? 'Demo preview · Pune' : (user?.email || 'Live Account')}</small>
            </span>
          </button>
        </div>

        <nav className="primary-nav" aria-label="Dashboard sections">
          <span className="sidebar-caption">CASH MANAGEMENT</span>
          <a className="nav-link nav-link--active" href="#overview">
            <LayoutDashboard size={17} aria-hidden="true" /> Overview
          </a>
          <a className="nav-link" href="#transactions-section">
            <Clock3 size={17} aria-hidden="true" /> Transactions
          </a>
          <a className="nav-link" href="#forecast">
            <Activity size={17} aria-hidden="true" /> Cash forecast
          </a>
          <a className="nav-link" href="#simulator">
            <Sparkles size={17} aria-hidden="true" /> What-If simulator
          </a>
        </nav>

        <div className="sidebar-bottom">
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '9px 12px',
                marginBottom: 16,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                color: '#eaf3ee',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <LogOut size={16} aria-hidden="true" />
              <span>Sign out</span>
            </button>
          )}

          <div className="privacy-note">
            <LockKeyhole size={15} aria-hidden="true" />
            <span>Financial data is business-isolated and encrypted.</span>
          </div>
          <div className="sidebar-footer">
            <span className="sidebar-footer__mark">CS</span>
            <span><strong>Cashflow Sentinel</strong><small>Decision support for local business</small></span>
          </div>
        </div>
      </aside>

      {/* Main Shell */}
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar__context">
            <span>Workspace</span><span className="crumb-separator">/</span><strong>Overview</strong>
          </div>
          <div className="topbar__right">
            <span className="today-label"><CalendarDays size={15} aria-hidden="true" />{today}</span>
            <label className="theme-control" htmlFor="theme-preference">
              <span className="theme-control__icon" aria-hidden="true">
                {preference === 'system'
                  ? <Monitor size={15} />
                  : preference === 'dark'
                    ? <Moon size={15} />
                    : <Sun size={15} />}
              </span>
              <span className="theme-control__label">Theme</span>
              <select
                id="theme-preference"
                aria-label="Color theme"
                value={preference}
                onChange={(event) => {
                  const selectedPreference = event.currentTarget.value;
                  if (
                    selectedPreference === 'light' ||
                    selectedPreference === 'dark' ||
                    selectedPreference === 'system'
                  ) {
                    setPreference(selectedPreference);
                  }
                }}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </select>
            </label>
            <ApiStatus health={health} />
          </div>
        </header>

        <main className="dashboard-main" id="overview">
          {/* Page Heading & Actions */}
          <section className="page-heading">
            <div>
              <p className="eyebrow">YOUR BUSINESS AT A GLANCE</p>
              <h1>Cashflow overview</h1>
              <p className="page-subtitle">Track your income, operating expenses, and verified cash position.</p>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                type="button"
                className="button button--primary"
                onClick={handleOpenAddTransaction}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  background: '#238866',
                  color: '#ffffff',
                  fontWeight: 600,
                  padding: '9px 18px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: '0 2px 6px rgba(35,136,102,0.25)',
                }}
              >
                <Plus size={17} aria-hidden="true" />
                Add Transaction
              </button>

              <button
                type="button"
                className={demoMode ? 'button button--demo-active' : 'button button--secondary'}
                aria-pressed={demoMode}
                onClick={() => setDemoMode((current) => !current)}
              >
                <Activity size={16} aria-hidden="true" />
                {demoMode ? 'Exit demo preview' : 'Preview demo data'}
              </button>
            </div>
          </section>

          {/* Action Feedback Banner */}
          {actionSuccess && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: '#ecfdf5',
              border: '1px solid #a7f3d0',
              color: '#065f46',
              padding: '12px 18px',
              borderRadius: 8,
              marginBottom: 18,
              fontSize: 14,
            }}>
              <CheckCircle2 size={18} aria-hidden="true" />
              <span>{actionSuccess}</span>
            </div>
          )}

          {/* Mode Banner */}
          {demoMode ? (
            <div className="demo-banner" role="status">
              <span className="demo-banner__tag">DEMO PREVIEW</span>
              <span>Illustrative synthetic values only. They are not fetched from or saved to the database.</span>
            </div>
          ) : financialsError ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '12px 18px',
              borderRadius: 8,
              marginBottom: 18,
              fontSize: 14,
            }}>
              <span>{financialsError}</span>
              <button
                type="button"
                className="text-button"
                onClick={() => void loadFinancialData()}
              >
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            </div>
          ) : (
            <div className="live-banner" role="status">
              <div className="live-banner__icon">
                <CheckCircle2 size={18} aria-hidden="true" />
              </div>
              <div className="live-banner__copy">
                <strong>Live PostgreSQL Connected</strong>
                <span>
                  {summary
                    ? `Displaying ${summary.transaction_count} recorded transaction${summary.transaction_count === 1 ? '' : 's'} stored in database.`
                    : 'Loading real financial data from database...'}
                </span>
              </div>
            </div>
          )}

          {/* Real Metrics Grid */}
          <section className="metrics-grid" aria-label="Cash position summary">
            {/* Cash Available / Current Balance */}
            <article className="metric-card metric-card--balance">
              <div className="metric-card__top">
                <span className="metric-icon metric-icon--green"><Wallet size={18} aria-hidden="true" /></span>
                {demoMode ? (
                  <span className="data-tag">DEMO</span>
                ) : (
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#238866', background: '#e9f5ef', padding: '2px 8px', borderRadius: 12 }}>
                    VERIFIED
                  </span>
                )}
              </div>
              <p className="metric-label">Cash available</p>
              <strong className="metric-value">
                {demoMode
                  ? formatPaise(demoData.openingBalancePaise)
                  : isLoadingFinancials
                    ? '...'
                    : summary
                      ? formatPaise(BigInt(summary.current_cash_balance_paise))
                      : '—'}
              </strong>
              <span className="metric-footnote">
                {demoMode
                  ? 'Opening balance across 2 accounts'
                  : summary
                    ? 'Current cash position across active accounts'
                    : 'Loading balance...'}
              </span>
            </article>

            {/* Total Income */}
            <article className="metric-card">
              <div className="metric-card__top">
                <span className="metric-icon metric-icon--blue"><ArrowDownRight size={18} aria-hidden="true" /></span>
                {demoMode && <span className="data-tag">DEMO</span>}
              </div>
              <p className="metric-label">Total income</p>
              <strong className="metric-value" style={{ color: '#16a34a' }}>
                {demoMode
                  ? formatPaise(demoData.expectedReceiptsPaise)
                  : isLoadingFinancials
                    ? '...'
                    : summary
                      ? formatPaise(BigInt(summary.total_income_paise))
                      : '—'}
              </strong>
              <span className="metric-footnote">
                {demoMode ? '1 open customer receipt' : 'Total posted business inflows'}
              </span>
            </article>

            {/* Total Expenses */}
            <article className="metric-card">
              <div className="metric-card__top">
                <span className="metric-icon metric-icon--orange"><ArrowUpRight size={18} aria-hidden="true" /></span>
                {demoMode && <span className="data-tag">DEMO</span>}
              </div>
              <p className="metric-label">Total expenses</p>
              <strong className="metric-value" style={{ color: '#ea580c' }}>
                {demoMode
                  ? formatPaise(demoData.supplierBillPaise)
                  : isLoadingFinancials
                    ? '...'
                    : summary
                      ? formatPaise(BigInt(summary.total_expense_paise))
                      : '—'}
              </strong>
              <span className="metric-footnote">
                {demoMode ? '1 supplier bill due' : 'Total posted business outflows'}
              </span>
            </article>

            {/* Net Cash Flow */}
            <article className="metric-card">
              <div className="metric-card__top">
                <span className="metric-icon metric-icon--neutral"><Activity size={18} aria-hidden="true" /></span>
                {demoMode && <span className="data-tag">DEMO</span>}
              </div>
              <p className="metric-label">Net cash flow</p>
              <strong className="metric-value">
                {demoMode
                  ? formatPaise(demoData.expectedReceiptsPaise - demoData.supplierBillPaise)
                  : isLoadingFinancials
                    ? '...'
                    : summary
                      ? formatPaise(BigInt(summary.net_cash_flow_paise))
                      : '—'}
              </strong>
              <span className="metric-footnote">
                {demoMode ? 'Illustrative net flow' : 'Income minus expenses'}
              </span>
            </article>
          </section>

          {/* Real Transaction History Table Section */}
          <section id="transactions-section" style={{ marginTop: 28 }}>
            <div style={{
              background: '#ffffff',
              borderRadius: 14,
              border: '1px solid #e5eae6',
              boxShadow: '0 2px 10px rgba(0,0,0,0.03)',
              overflow: 'hidden',
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '20px 24px',
                borderBottom: '1px solid #f0f3f1',
                flexWrap: 'wrap',
                gap: 12,
              }}>
                <div>
                  <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px', color: '#17241f' }}>
                    Transaction History
                  </h2>
                  <p style={{ margin: 0, fontSize: 13, color: '#78827d' }}>
                    {demoMode
                      ? 'Displaying demo illustrative movements'
                      : `Real persisted transactions (${paginationInfo ? paginationInfo.total_count : transactions.length} total)`}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => void loadFinancialData()}
                    disabled={isLoadingFinancials}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '7px 14px',
                      background: '#f5f7f5',
                      border: '1px solid #e5eae6',
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      color: '#58655c',
                    }}
                  >
                    <RefreshCw size={13} className={isLoadingFinancials ? 'spin' : ''} aria-hidden="true" />
                    Refresh
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenAddTransaction}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '7px 14px',
                      background: '#238866',
                      border: 'none',
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 600,
                      color: '#ffffff',
                      cursor: 'pointer',
                    }}
                  >
                    <Plus size={14} aria-hidden="true" />
                    Add Transaction
                  </button>
                </div>
              </div>

              {/* Transaction Search & Filter Bar */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 20px',
                  background: '#f8faf9',
                  borderBottom: '1px solid #e5eae6',
                }}
              >
                {/* Search input */}
                <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 180 }}>
                  <Search
                    size={14}
                    style={{
                      position: 'absolute',
                      left: 10,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: '#9ca3af',
                      pointerEvents: 'none',
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Search description or counterparty..."
                    value={filterSearch}
                    onChange={(e) => setFilterSearch(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '7px 28px 7px 30px',
                      borderRadius: 6,
                      border: '1px solid #d1d5db',
                      fontSize: 13,
                      background: '#ffffff',
                      color: '#1f2937',
                      outline: 'none',
                    }}
                  />
                  {filterSearch && (
                    <button
                      type="button"
                      onClick={() => setFilterSearch('')}
                      aria-label="Clear search text"
                      style={{
                        position: 'absolute',
                        right: 8,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: '#9ca3af',
                        padding: 2,
                        display: 'flex',
                      }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                {/* Type Filter */}
                <div style={{ minWidth: 130 }}>
                  <select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value as 'all' | 'income' | 'expense')}
                    aria-label="Filter by type"
                    style={{
                      width: '100%',
                      padding: '7px 10px',
                      borderRadius: 6,
                      border: '1px solid #d1d5db',
                      fontSize: 13,
                      background: '#ffffff',
                      color: '#1f2937',
                      cursor: 'pointer',
                    }}
                  >
                    <option value="all">All Types</option>
                    <option value="income">Income (+)</option>
                    <option value="expense">Expense (−)</option>
                  </select>
                </div>

                {/* Category Filter */}
                <div style={{ minWidth: 140 }}>
                  <select
                    value={filterCategoryId}
                    onChange={(e) => setFilterCategoryId(e.target.value)}
                    aria-label="Filter by category"
                    style={{
                      width: '100%',
                      padding: '7px 10px',
                      borderRadius: 6,
                      border: '1px solid #d1d5db',
                      fontSize: 13,
                      background: '#ffffff',
                      color: '#1f2937',
                      cursor: 'pointer',
                    }}
                  >
                    <option value="">All Categories</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Date Range Filters */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="date"
                    value={filterStartDate}
                    onChange={(e) => setFilterStartDate(e.target.value)}
                    placeholder="Start date"
                    aria-label="Filter start date"
                    style={{
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: '1px solid #d1d5db',
                      fontSize: 12,
                      background: '#ffffff',
                      color: '#1f2937',
                    }}
                  />
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>to</span>
                  <input
                    type="date"
                    value={filterEndDate}
                    onChange={(e) => setFilterEndDate(e.target.value)}
                    placeholder="End date"
                    aria-label="Filter end date"
                    style={{
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: '1px solid #d1d5db',
                      fontSize: 12,
                      background: '#ffffff',
                      color: '#1f2937',
                    }}
                  />
                </div>

                {/* Clear / Reset button */}
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    onClick={handleClearFilters}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '6px 12px',
                      borderRadius: 6,
                      border: '1px solid #d1d5db',
                      background: '#ffffff',
                      color: '#4b5563',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = '#9ca3af';
                      e.currentTarget.style.color = '#111827';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = '#d1d5db';
                      e.currentTarget.style.color = '#4b5563';
                    }}
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    Reset ({activeFilterCount})
                  </button>
                )}
              </div>

              {/* Filter Error banner */}
              {filterError && (
                <div
                  role="alert"
                  style={{
                    padding: '10px 20px',
                    background: '#fef2f2',
                    color: '#b91c1c',
                    borderBottom: '1px solid #fecaca',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <ShieldAlert size={15} />
                  <span>{filterError}</span>
                </div>
              )}

              {isLoadingFinancials || isFiltering ? (
                <div style={{ padding: '48px 24px', textAlign: 'center', color: '#78827d' }}>
                  <LoaderCircle size={24} className="spin" style={{ margin: '0 auto 12px' }} />
                  <p style={{ margin: 0, fontSize: 14 }}>
                    {isFiltering ? 'Filtering transactions...' : 'Loading transactions from PostgreSQL...'}
                  </p>
                </div>
              ) : transactions.length === 0 ? (
                activeFilterCount > 0 ? (
                  <div style={{ padding: '48px 24px', textAlign: 'center' }}>
                    <div
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: '50%',
                        background: '#f3f4f6',
                        color: '#6b7280',
                        display: 'grid',
                        placeItems: 'center',
                        margin: '0 auto 14px',
                      }}
                    >
                      <Search size={22} aria-hidden="true" />
                    </div>
                    <h3 style={{ margin: '0 0 6px', fontSize: 16, color: '#17241f' }}>
                      No matching transactions found
                    </h3>
                    <p style={{ margin: '0 auto 18px', maxWidth: 420, fontSize: 13, color: '#78827d', lineHeight: 1.5 }}>
                      No transactions matched your current search and filter combination. Try adjusting the search text, category, or date range.
                    </p>
                    <button
                      type="button"
                      onClick={handleClearFilters}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '8px 16px',
                        background: '#f3f4f6',
                        color: '#374151',
                        borderRadius: 8,
                        border: '1px solid #d1d5db',
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      Clear all filters
                    </button>
                  </div>
                ) : (
                  <div style={{ padding: '48px 24px', textAlign: 'center' }}>
                    <div
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: '50%',
                        background: '#f0fdf4',
                        color: '#238866',
                        display: 'grid',
                        placeItems: 'center',
                        margin: '0 auto 14px',
                      }}
                    >
                      <Wallet size={22} aria-hidden="true" />
                    </div>
                    <h3 style={{ margin: '0 0 6px', fontSize: 16, color: '#17241f' }}>No transactions recorded yet</h3>
                    <p style={{ margin: '0 auto 18px', maxWidth: 400, fontSize: 13, color: '#78827d', lineHeight: 1.5 }}>
                      Record your first income or business expense to begin tracking cash flow and generating automated insights.
                    </p>
                    <button
                      type="button"
                      onClick={handleOpenAddTransaction}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '9px 18px',
                        background: '#238866',
                        color: '#ffffff',
                        borderRadius: 8,
                        border: 'none',
                        fontWeight: 600,
                        fontSize: 14,
                        cursor: 'pointer',
                      }}
                    >
                      <Plus size={16} aria-hidden="true" />
                      Add First Transaction
                    </button>
                  </div>
                )
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f8faf9', borderBottom: '1px solid #e5eae6', color: '#58655c' }}>
                        <th style={{ padding: '12px 20px', fontWeight: 600 }}>Date</th>
                        <th style={{ padding: '12px 16px', fontWeight: 600 }}>Type</th>
                        <th style={{ padding: '12px 16px', fontWeight: 600 }}>Category</th>
                        <th style={{ padding: '12px 16px', fontWeight: 600 }}>Description</th>
                        <th style={{ padding: '12px 20px', fontWeight: 600, textAlign: 'right' }}>Amount</th>
                        <th style={{ padding: '12px 20px', fontWeight: 600, textAlign: 'center' }}>Status</th>
                        <th style={{ padding: '12px 20px', fontWeight: 600, textAlign: 'center' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((tx) => {
                        const isInflow = tx.cash_direction === 'INFLOW';
                        return (
                          <tr key={tx.id} style={{ borderBottom: '1px solid #f0f3f1' }}>
                            <td style={{ padding: '14px 20px', color: '#17241f', whiteSpace: 'nowrap' }}>
                              {formatDate(tx.transaction_date)}
                            </td>
                            <td style={{ padding: '14px 16px' }}>
                              <span style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '3px 8px',
                                borderRadius: 12,
                                fontSize: 11,
                                fontWeight: 700,
                                background: isInflow ? '#ecfdf5' : '#fff7ed',
                                color: isInflow ? '#065f46' : '#9a3412',
                              }}>
                                {isInflow ? 'INCOME' : 'EXPENSE'}
                              </span>
                            </td>
                            <td style={{ padding: '14px 16px', color: '#58655c' }}>
                              <span style={{
                                background: '#f3f4f6',
                                padding: '2px 8px',
                                borderRadius: 6,
                                fontSize: 12,
                              }}>
                                {tx.category_name || 'General'}
                              </span>
                            </td>
                            <td style={{ padding: '14px 16px', color: '#17241f', maxWidth: 260 }}>
                              {tx.description || tx.counterparty_name || '—'}
                            </td>
                            <td style={{
                              padding: '14px 20px',
                              textAlign: 'right',
                              fontWeight: 700,
                              color: isInflow ? '#16a34a' : '#dc2626',
                              whiteSpace: 'nowrap',
                            }}>
                              {isInflow ? '+' : '−'}
                              {formatPaise(BigInt(tx.amount_paise))}
                            </td>
                            <td style={{ padding: '14px 20px', textAlign: 'center' }}>
                              <span style={{
                                fontSize: 11,
                                color: '#4b5563',
                                background: '#f3f4f6',
                                padding: '2px 7px',
                                borderRadius: 4,
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                              }}>
                                {tx.record_status}
                              </span>
                            </td>
                            <td style={{ padding: '14px 20px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                              {tx.record_status === 'POSTED' && (
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenEditTransaction(tx)}
                                    aria-label={`Edit transaction ${tx.description || tx.id}`}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 5,
                                      padding: '5px 12px',
                                      borderRadius: 6,
                                      border: '1px solid #d1d5db',
                                      background: '#ffffff',
                                      color: '#374151',
                                      fontSize: 12,
                                      fontWeight: 600,
                                      cursor: 'pointer',
                                      transition: 'all 0.15s ease',
                                    }}
                                    onMouseEnter={(e) => {
                                      e.currentTarget.style.borderColor = '#238866';
                                      e.currentTarget.style.color = '#238866';
                                      e.currentTarget.style.background = '#f0fdf4';
                                    }}
                                    onMouseLeave={(e) => {
                                      e.currentTarget.style.borderColor = '#d1d5db';
                                      e.currentTarget.style.color = '#374151';
                                      e.currentTarget.style.background = '#ffffff';
                                    }}
                                  >
                                    <Pencil size={13} aria-hidden="true" />
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenDeleteTransaction(tx)}
                                    aria-label={`Delete transaction ${tx.description || tx.id}`}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 5,
                                      padding: '5px 12px',
                                      borderRadius: 6,
                                      border: '1px solid #fecaca',
                                      background: '#ffffff',
                                      color: '#b91c1c',
                                      fontSize: 12,
                                      fontWeight: 600,
                                      cursor: 'pointer',
                                      transition: 'all 0.15s ease',
                                    }}
                                    onMouseEnter={(e) => {
                                      e.currentTarget.style.borderColor = '#dc2626';
                                      e.currentTarget.style.color = '#dc2626';
                                      e.currentTarget.style.background = '#fef2f2';
                                    }}
                                    onMouseLeave={(e) => {
                                      e.currentTarget.style.borderColor = '#fecaca';
                                      e.currentTarget.style.color = '#b91c1c';
                                      e.currentTarget.style.background = '#ffffff';
                                    }}
                                  >
                                    <Trash2 size={13} aria-hidden="true" />
                                    Delete
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Server-side Pagination Controls */}
              {!isLoadingFinancials && !isFiltering && transactions.length > 0 && paginationInfo && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 24px',
                    borderTop: '1px solid #f0f3f1',
                    background: '#ffffff',
                    fontSize: 13,
                    color: '#58655c',
                    flexWrap: 'wrap',
                    gap: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>
                      Showing{' '}
                      <strong style={{ color: '#17241f' }}>
                        {(currentPage - 1) * paginationInfo.limit + 1}–{Math.min(currentPage * paginationInfo.limit, paginationInfo.total_count)}
                      </strong>{' '}
                      of <strong style={{ color: '#17241f' }}>{paginationInfo.total_count}</strong> transactions
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span
                      style={{
                        padding: '4px 10px',
                        background: '#f8faf9',
                        border: '1px solid #e5eae6',
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        color: '#374151',
                      }}
                    >
                      Page {currentPage} of {Math.max(paginationInfo.total_pages, 1)}
                    </span>

                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <button
                        type="button"
                        onClick={handlePrevPage}
                        disabled={currentPage <= 1 || isFiltering || isLoadingFinancials}
                        aria-label="Previous page"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          padding: '6px 12px',
                          borderRadius: 6,
                          border: '1px solid #d1d5db',
                          background: currentPage <= 1 ? '#f9fafb' : '#ffffff',
                          color: currentPage <= 1 ? '#9ca3af' : '#374151',
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: currentPage <= 1 ? 'not-allowed' : 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <ChevronLeft size={15} aria-hidden="true" />
                        Previous
                      </button>

                      <button
                        type="button"
                        onClick={handleNextPage}
                        disabled={currentPage >= paginationInfo.total_pages || isFiltering || isLoadingFinancials}
                        aria-label="Next page"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          padding: '6px 12px',
                          borderRadius: 6,
                          border: '1px solid #d1d5db',
                          background: currentPage >= paginationInfo.total_pages ? '#f9fafb' : '#ffffff',
                          color: currentPage >= paginationInfo.total_pages ? '#9ca3af' : '#374151',
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: currentPage >= paginationInfo.total_pages ? 'not-allowed' : 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        Next
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Forecasting & Early Warning Section */}
          <section className="dashboard-grid" style={{ marginTop: 28 }}>
            <article className="panel forecast-panel" id="forecast">
              <div className="panel-heading">
                <div>
                  <div className="panel-title-row">
                    <h2>30-day cash-flow forecast</h2>
                    {demoMode ? (
                      <span className="data-tag">DEMO SERIES</span>
                    ) : isLoadingForecast ? (
                      <span
                        style={{
                          fontSize: 11,
                          color: '#6b7280',
                          background: '#f3f4f6',
                          padding: '2px 8px',
                          borderRadius: 10,
                        }}
                      >
                        LOADING MODEL...
                      </span>
                    ) : forecastData?.has_sufficient_history ? (
                      <span
                        style={{
                          fontSize: 11,
                          color: '#065f46',
                          background: '#ecfdf5',
                          padding: '2px 8px',
                          borderRadius: 10,
                          fontWeight: 600,
                        }}
                      >
                        VERIFIED PROJECTION
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: 11,
                          color: '#92400e',
                          background: '#fef3c7',
                          padding: '2px 8px',
                          borderRadius: 10,
                          fontWeight: 600,
                        }}
                      >
                        CALIBRATING
                      </span>
                    )}
                  </div>
                  <p>
                    {demoMode
                      ? 'Illustrative daily closing cash and buffer simulation'
                      : forecastData?.has_sufficient_history
                        ? `30-day daily cash runway calculated via ${
                            forecastData.run.method_name === 'DETERMINISTIC_ROLL_FORWARD'
                              ? 'Python Deterministic Forecast Engine'
                              : 'Baseline Statistical Projection'
                          }`
                        : 'Forecast models calibrate as 14+ calendar days of transactions accumulate'}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {!demoMode && (
                    <button
                      type="button"
                      onClick={() => void handleGenerateForecast()}
                      disabled={isGeneratingForecast || isLoadingForecast}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '5px 10px',
                        background: '#f5f7f5',
                        border: '1px solid #e5eae6',
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        color: '#58655c',
                      }}
                      title="Recalculate 30-day forecast from latest PostgreSQL transactions"
                    >
                      <RefreshCw
                        size={12}
                        className={isGeneratingForecast || isLoadingForecast ? 'spin' : ''}
                        aria-hidden="true"
                      />
                      Refresh
                    </button>
                  )}
                  <span className="range-pill">
                    Next 30 days <ChevronDown size={14} aria-hidden="true" />
                  </span>
                </div>
              </div>

              {demoMode ? (
                <DemoForecastChart />
              ) : isLoadingForecast ? (
                <div style={{ padding: '60px 20px', textAlign: 'center', color: '#78827d' }}>
                  <LoaderCircle size={24} className="spin" style={{ margin: '0 auto 12px' }} />
                  <p style={{ margin: 0, fontSize: 14 }}>Calculating verified cash-flow forecast...</p>
                </div>
              ) : forecastError ? (
                <div style={{ padding: '36px 20px', textAlign: 'center' }}>
                  <p style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{forecastError}</p>
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => void loadForecastData()}
                    style={{ fontSize: 12 }}
                  >
                    <RefreshCw size={13} style={{ marginRight: 6 }} aria-hidden="true" /> Retry Forecast
                  </button>
                </div>
              ) : forecastData?.has_sufficient_history ? (
                <RealForecastChart run={forecastData.run} />
              ) : forecastData ? (
                <InsufficientHistoryCard
                  data={forecastData}
                  onGenerate={() => void handleGenerateForecast()}
                  isGenerating={isGeneratingForecast}
                  onPreviewDemo={() => setDemoMode(true)}
                />
              ) : (
                <EmptyForecast onPreviewDemo={() => setDemoMode(true)} />
              )}
            </article>

            <article className="panel risk-panel">
              <div className="panel-heading">
                <div>
                  <div className="panel-title-row">
                    <h2>Early warning</h2>
                    {demoMode && <span className="data-tag">DEMO</span>}
                  </div>
                  <p>Cash buffer check</p>
                </div>
                <span
                  className={`risk-indicator${
                    demoMode
                      ? ' risk-indicator--warning'
                      : !forecastData || !forecastData.has_sufficient_history
                        ? ''
                        : forecastData.run.alerts.length > 0
                          ? ' risk-indicator--warning'
                          : ' risk-indicator--safe'
                  }`}
                  style={
                    !demoMode &&
                    forecastData?.has_sufficient_history &&
                    forecastData.run.alerts.length === 0
                      ? { background: '#ecfdf5', color: '#065f46', borderColor: '#a7f3d0' }
                      : undefined
                  }
                >
                  {demoMode
                    ? 'At risk'
                    : !forecastData || !forecastData.has_sufficient_history
                      ? 'Calibrating'
                      : forecastData.run.alerts.length > 0
                        ? forecastData.run.alerts[0].severity === 'CRITICAL'
                          ? 'Critical'
                          : 'At risk'
                        : 'Protected'}
                </span>
              </div>

              <RealEarlyWarningCard
                alerts={
                  forecastData && forecastData.has_sufficient_history ? forecastData.run.alerts : []
                }
                minimumBufferPaise={
                  forecastData && forecastData.has_sufficient_history
                    ? BigInt(forecastData.run.minimum_cash_buffer_paise || '0')
                    : 0n
                }
                hasSufficientHistory={Boolean(forecastData?.has_sufficient_history)}
                demoMode={demoMode}
              />
            </article>
          </section>

          {/* Financial Explanations Layer */}
          <FinancialExplanationsSection
            explanations={
              forecastData && 'explanations' in forecastData
                ? forecastData.explanations
                : forecastData && 'run' in forecastData && forecastData.run.explanations
                  ? forecastData.run.explanations
                  : undefined
            }
            isLoading={isLoadingForecast}
            hasSufficientHistory={Boolean(forecastData?.has_sufficient_history)}
            demoMode={demoMode}
          />

          {/* Interactive What-If Simulator Section */}
          <WhatIfSimulator
            forecastData={forecastData}
            demoMode={demoMode}
            onSwitchToDemo={() => setDemoMode(true)}
            onRefreshForecast={loadForecastData}
          />

          {/* Footer */}
          <footer className="dashboard-footer" style={{ marginTop: 36 }}>
            <span>
              <Clock3 size={14} aria-hidden="true" />
              {demoMode
                ? 'Demo preview active · Synthetic values are not saved.'
                : 'Transactions are securely saved and backed by PostgreSQL.'}
            </span>
            <button
              type="button"
              className="footer-refresh"
              onClick={() => {
                setRetryCount((c) => c + 1);
                void loadFinancialData();
              }}
              disabled={health.state === 'checking' || isLoadingFinancials}
            >
              <RefreshCw size={13} aria-hidden="true" className={isLoadingFinancials ? 'spin' : ''} />
              Sync data
            </button>
          </footer>
        </main>
      </div>

      {/* Add Transaction Modal Dialog */}
      {isModalOpen && (
        <div style={modalStyles.backdrop}>
          <div style={modalStyles.dialog} role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div style={modalStyles.header}>
              <h2 id="modal-title" style={{ fontSize: 20, margin: 0, fontWeight: 700, color: '#17241f' }}>
                Add New Transaction
              </h2>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                disabled={isSubmitting}
                style={modalStyles.closeButton}
                aria-label="Close dialog"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleAddTransactionSubmit} style={modalStyles.form}>
              {/* Income / Expense Selector Tabs */}
              <div>
                <label style={modalStyles.label}>Transaction Type</label>
                <div style={modalStyles.typeToggleWrap}>
                  <button
                    type="button"
                    style={{
                      ...modalStyles.typeTab,
                      ...(formType === 'income' ? modalStyles.typeTabActiveIncome : {}),
                    }}
                    onClick={() => handleDirectionChange('income')}
                  >
                    <ArrowDownRight size={16} aria-hidden="true" />
                    Income (Receipt)
                  </button>
                  <button
                    type="button"
                    style={{
                      ...modalStyles.typeTab,
                      ...(formType === 'expense' ? modalStyles.typeTabActiveExpense : {}),
                    }}
                    onClick={() => handleDirectionChange('expense')}
                  >
                    <ArrowUpRight size={16} aria-hidden="true" />
                    Expense (Payment)
                  </button>
                </div>
              </div>

              {/* Amount field */}
              <div>
                <label style={modalStyles.label} htmlFor="tx-amount">
                  Amount (₹) *
                </label>
                <input
                  id="tx-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="e.g. 2500.00"
                  value={formAmount}
                  onChange={(e) => {
                    setFormAmount(e.target.value);
                    setFormError(null);
                  }}
                  required
                  disabled={isSubmitting}
                  style={modalStyles.input}
                />
              </div>

              {/* Category selector */}
              <div>
                <label style={modalStyles.label} htmlFor="tx-category">
                  Category *
                </label>
                <select
                  id="tx-category"
                  value={formCategoryId}
                  onChange={(e) => {
                    setFormCategoryId(e.target.value);
                    setFormError(null);
                  }}
                  disabled={isSubmitting || availableCategories.length === 0}
                  style={modalStyles.input}
                  required
                >
                  {isLoadingFinancials && categories.length === 0 ? (
                    <option value="" disabled>Loading categories...</option>
                  ) : availableCategories.length === 0 ? (
                    <option value="" disabled>No categories available for this direction</option>
                  ) : (
                    availableCategories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.display_name}
                      </option>
                    ))
                  )}
                </select>
              </div>

              {/* Description field */}
              <div>
                <label style={modalStyles.label} htmlFor="tx-desc">
                  Description / Counterparty
                </label>
                <input
                  id="tx-desc"
                  type="text"
                  placeholder="e.g. Sales to Mahesh Traders, Shop electricity"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  disabled={isSubmitting}
                  style={modalStyles.input}
                />
              </div>

              {/* Transaction Date field */}
              <div>
                <label style={modalStyles.label} htmlFor="tx-date">
                  Transaction Date *
                </label>
                <input
                  id="tx-date"
                  type="date"
                  value={formDate}
                  onChange={(e) => setFormDate(e.target.value)}
                  required
                  disabled={isSubmitting}
                  style={modalStyles.input}
                />
              </div>

              {/* Error box */}
              {formError && (
                <div role="alert" style={modalStyles.errorBox}>
                  {formError}
                </div>
              )}

              {/* Actions */}
              <div style={modalStyles.actions}>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={isSubmitting}
                  style={modalStyles.cancelButton}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    ...modalStyles.submitButton,
                    ...(isSubmitting ? modalStyles.buttonDisabled : {}),
                  }}
                >
                  {isSubmitting ? 'Saving...' : 'Save Transaction'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Transaction Modal Dialog */}
      {editingTransaction && (
        <div style={modalStyles.backdrop}>
          <div style={modalStyles.dialog} role="dialog" aria-modal="true" aria-labelledby="edit-modal-title">
            <div style={modalStyles.header}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                <h2 id="edit-modal-title" style={{ fontSize: 20, margin: 0, fontWeight: 700, color: '#17241f' }}>
                  Edit Transaction
                </h2>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    padding: '0.2rem 0.5rem',
                    borderRadius: 9999,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    backgroundColor:
                      editingTransaction.cash_direction === 'INFLOW'
                        ? 'rgba(34, 197, 94, 0.12)'
                        : 'rgba(239, 68, 68, 0.12)',
                    color: editingTransaction.cash_direction === 'INFLOW' ? '#15803d' : '#b91c1c',
                  }}
                >
                  {editingTransaction.cash_direction === 'INFLOW' ? (
                    <>
                      <ArrowDownRight size={13} aria-hidden="true" />
                      Income
                    </>
                  ) : (
                    <>
                      <ArrowUpRight size={13} aria-hidden="true" />
                      Expense
                    </>
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setEditingTransaction(null)}
                disabled={isSubmittingEdit}
                style={modalStyles.closeButton}
                aria-label="Close edit dialog"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleEditTransactionSubmit} style={modalStyles.form}>
              {/* Direction Indicator (Read-only since direction is immutable) */}
              <div
                style={{
                  fontSize: 13,
                  color: '#4b5563',
                  padding: '0.5rem 0.75rem',
                  backgroundColor: '#f9fafb',
                  borderRadius: 8,
                  border: '1px solid #e5e7eb',
                }}
              >
                Editing {editingTransaction.cash_direction === 'INFLOW' ? 'Income (Inflow)' : 'Expense (Outflow)'}{' '}
                record. Cash direction cannot be changed.
              </div>

              {/* Amount field */}
              <div>
                <label style={modalStyles.label} htmlFor="edit-tx-amount">
                  Amount (₹) *
                </label>
                <input
                  id="edit-tx-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="e.g. 2500.00"
                  value={editAmount}
                  onChange={(e) => {
                    setEditAmount(e.target.value);
                    setEditError(null);
                  }}
                  required
                  disabled={isSubmittingEdit}
                  style={modalStyles.input}
                />
              </div>

              {/* Category selector */}
              <div>
                <label style={modalStyles.label} htmlFor="edit-tx-category">
                  Category *
                </label>
                <select
                  id="edit-tx-category"
                  value={editCategoryId}
                  onChange={(e) => {
                    setEditCategoryId(e.target.value);
                    setEditError(null);
                  }}
                  disabled={isSubmittingEdit || editAvailableCategories.length === 0}
                  style={modalStyles.input}
                  required
                >
                  {editAvailableCategories.length === 0 ? (
                    <option value="" disabled>
                      No categories available for this direction
                    </option>
                  ) : (
                    editAvailableCategories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.display_name}
                      </option>
                    ))
                  )}
                </select>
              </div>

              {/* Description field */}
              <div>
                <label style={modalStyles.label} htmlFor="edit-tx-desc">
                  Description / Counterparty
                </label>
                <input
                  id="edit-tx-desc"
                  type="text"
                  placeholder="e.g. Sales to Mahesh Traders, Shop electricity"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  disabled={isSubmittingEdit}
                  style={modalStyles.input}
                />
              </div>

              {/* Transaction Date field */}
              <div>
                <label style={modalStyles.label} htmlFor="edit-tx-date">
                  Transaction Date *
                </label>
                <input
                  id="edit-tx-date"
                  type="date"
                  value={editDate}
                  onChange={(e) => setEditDate(e.target.value)}
                  required
                  disabled={isSubmittingEdit}
                  style={modalStyles.input}
                />
              </div>

              {/* Error box */}
              {editError && (
                <div role="alert" style={modalStyles.errorBox}>
                  {editError}
                </div>
              )}

              {/* Actions */}
              <div style={modalStyles.actions}>
                <button
                  type="button"
                  onClick={() => setEditingTransaction(null)}
                  disabled={isSubmittingEdit}
                  style={modalStyles.cancelButton}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingEdit}
                  style={{
                    ...modalStyles.submitButton,
                    ...(isSubmittingEdit ? modalStyles.buttonDisabled : {}),
                  }}
                >
                  {isSubmittingEdit ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Transaction Confirmation Modal */}
      {deletingTransaction && (
        <div style={modalStyles.backdrop}>
          <div
            style={{
              ...modalStyles.dialog,
              maxWidth: 440,
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-modal-title"
          >
            <div style={modalStyles.header}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    backgroundColor: 'rgba(239, 68, 68, 0.12)',
                    color: '#dc2626',
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  <Trash2 size={17} aria-hidden="true" />
                </div>
                <h2 id="delete-modal-title" style={{ fontSize: 18, margin: 0, fontWeight: 700, color: '#17241f' }}>
                  Delete Transaction
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setDeletingTransaction(null)}
                disabled={isSubmittingDelete}
                style={modalStyles.closeButton}
                aria-label="Close delete dialog"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <div style={{ padding: '1.25rem' }}>
              <p style={{ margin: '0 0 1rem', fontSize: 14, color: '#4b5563', lineHeight: 1.5 }}>
                Are you sure you want to delete this transaction? This record will be soft-deleted and removed from your active cash flow totals.
              </p>

              {/* Transaction Summary Card */}
              <div
                style={{
                  padding: '0.875rem 1rem',
                  backgroundColor: '#f9fafb',
                  borderRadius: 8,
                  border: '1px solid #e5e7eb',
                  marginBottom: '1.25rem',
                  fontSize: 13,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: '#6b7280' }}>Direction:</span>
                  <span
                    style={{
                      fontWeight: 700,
                      color: deletingTransaction.cash_direction === 'INFLOW' ? '#15803d' : '#b91c1c',
                    }}
                  >
                    {deletingTransaction.cash_direction === 'INFLOW' ? 'Income (Inflow)' : 'Expense (Outflow)'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: '#6b7280' }}>Amount:</span>
                  <span style={{ fontWeight: 700, color: '#111827' }}>
                    ₹
                    {deletingTransaction.amount_rupees !== undefined
                      ? deletingTransaction.amount_rupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })
                      : (Number(deletingTransaction.amount_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: '#6b7280' }}>Category:</span>
                  <span style={{ color: '#374151', fontWeight: 500 }}>
                    {deletingTransaction.category_name || 'General'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: '#6b7280' }}>Date:</span>
                  <span style={{ color: '#374151' }}>
                    {deletingTransaction.transaction_date ? deletingTransaction.transaction_date.slice(0, 10) : '—'}
                  </span>
                </div>
                {deletingTransaction.description && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#6b7280' }}>Description:</span>
                    <span
                      style={{
                        color: '#374151',
                        maxWidth: 200,
                        textOverflow: 'ellipsis',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {deletingTransaction.description}
                    </span>
                  </div>
                )}
              </div>

              {/* Error display */}
              {deleteError && (
                <div role="alert" style={{ ...modalStyles.errorBox, marginBottom: '1.25rem' }}>
                  {deleteError}
                </div>
              )}

              {/* Action buttons */}
              <div style={modalStyles.actions}>
                <button
                  type="button"
                  onClick={() => setDeletingTransaction(null)}
                  disabled={isSubmittingDelete}
                  style={modalStyles.cancelButton}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  disabled={isSubmittingDelete}
                  style={{
                    ...modalStyles.submitButton,
                    backgroundColor: '#dc2626',
                    borderColor: '#dc2626',
                    color: '#ffffff',
                    ...(isSubmittingDelete ? modalStyles.buttonDisabled : {}),
                  }}
                >
                  {isSubmittingDelete ? 'Deleting...' : 'Yes, Delete Transaction'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const modalStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    backdropFilter: 'blur(3px)',
    display: 'grid',
    placeItems: 'center',
    padding: 20,
    zIndex: 9999,
  },
  dialog: {
    width: '100%',
    maxWidth: 480,
    background: '#ffffff',
    borderRadius: 16,
    boxShadow: '0 20px 45px rgba(0,0,0,0.18)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '22px 24px',
    borderBottom: '1px solid #eef2ef',
  },
  closeButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#64748b',
    padding: 4,
    borderRadius: 6,
  },
  form: {
    padding: 24,
    display: 'grid',
    gap: 16,
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    color: '#374151',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid #d1d5db',
    borderRadius: 8,
    fontSize: 14,
    color: '#111827',
    background: '#ffffff',
    outlineColor: '#238866',
  },
  typeToggleWrap: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
  },
  typeTab: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 10,
    borderRadius: 8,
    border: '1px solid #e5e7eb',
    background: '#f9fafb',
    color: '#4b5563',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
  typeTabActiveIncome: {
    background: '#ecfdf5',
    borderColor: '#10b981',
    color: '#065f46',
  },
  typeTabActiveExpense: {
    background: '#fff7ed',
    borderColor: '#f97316',
    color: '#9a3412',
  },
  errorBox: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#b91c1c',
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 13,
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 8,
  },
  cancelButton: {
    padding: '10px 18px',
    borderRadius: 8,
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#374151',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
  },
  submitButton: {
    padding: '10px 20px',
    borderRadius: 8,
    border: 'none',
    background: '#238866',
    color: '#ffffff',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
  },
  buttonDisabled: {
    opacity: 0.65,
    cursor: 'not-allowed',
  },
};
