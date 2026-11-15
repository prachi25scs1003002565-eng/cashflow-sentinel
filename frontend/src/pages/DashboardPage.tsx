import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Moon,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Sun,
  Wallet,
} from 'lucide-react';
import { checkApiHealth } from '../services/dashboard';
import { useTheme } from '../context/ThemeContext';

type ApiHealth =
  | { state: 'checking' }
  | { state: 'online'; service: string }
  | { state: 'offline'; message: string };

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
        <span><i className="legend-dot legend-dot--cash" /> Projected closing cash</span>
        <span><i className="legend-dot legend-dot--buffer" /> Minimum cash buffer</span>
      </div>
    </div>
  );
}

function EmptyForecast() {
  return (
    <div className="empty-forecast">
      <div className="empty-forecast__icon"><Activity size={21} aria-hidden="true" /></div>
      <h3>No forecast loaded</h3>
      <p>
        Connect a business and generate a successful forecast to see daily cash
        movement here. No sample values are shown in live mode.
      </p>
    </div>
  );
}

export default function DashboardPage() {
  const [health, setHealth] = useState<ApiHealth>({ state: 'checking' });
  const [retryCount, setRetryCount] = useState(0);
  const [demoMode, setDemoMode] = useState(false);
  const [showSimulatorNote, setShowSimulatorNote] = useState(false);
  const { preference, setPreference } = useTheme();

  useEffect(() => {
    const controller = new AbortController();
    setHealth({ state: 'checking' });

    checkApiHealth(controller.signal)
      .then((service) => setHealth({ state: 'online', service }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setHealth({
          state: 'offline',
          message: error instanceof Error ? error.message : 'Unknown API health error.',
        });
      });

    return () => controller.abort();
  }, [retryCount]);

  const today = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
  const minimumBufferGapPaise = demoData.bufferPaise - demoData.points[1].balancePaise;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="Cashflow Sentinel dashboard">
          <span className="brand-mark"><Activity size={19} aria-hidden="true" /></span>
          <span className="brand-name">Cashflow<span>Sentinel</span></span>
        </a>

        <div className="workspace-picker">
          <span className="sidebar-caption">WORKSPACE</span>
          <button type="button" className="workspace-button" disabled={!demoMode}>
            <span className="workspace-avatar">{demoMode ? 'SL' : '—'}</span>
            <span className="workspace-copy">
              <strong>{demoMode ? 'Shree Laxmi Kirana' : 'No business selected'}</strong>
              <small>{demoMode ? 'Demo preview · Pune' : 'Connect a business'}</small>
            </span>
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Dashboard sections">
          <span className="sidebar-caption">CASH MANAGEMENT</span>
          <a className="nav-link nav-link--active" href="#overview">
            <LayoutDashboard size={17} aria-hidden="true" /> Overview
          </a>
          <a className="nav-link" href="#forecast">
            <Activity size={17} aria-hidden="true" /> Cash forecast
          </a>
          <a className="nav-link" href="#dues">
            <CalendarDays size={17} aria-hidden="true" /> Receivables &amp; payables
          </a>
          <a className="nav-link" href="#simulator">
            <Sparkles size={17} aria-hidden="true" /> What-If simulator
          </a>
        </nav>

        <div className="sidebar-bottom">
          <div className="privacy-note">
            <LockKeyhole size={15} aria-hidden="true" />
            <span>Your financial data stays private and business-scoped.</span>
          </div>
          <div className="sidebar-footer">
            <span className="sidebar-footer__mark">CS</span>
            <span><strong>Cashflow Sentinel</strong><small>Decision support for local business</small></span>
          </div>
        </div>
      </aside>

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
          <section className="page-heading">
            <div>
              <p className="eyebrow">YOUR BUSINESS AT A GLANCE</p>
              <h1>Cashflow overview</h1>
              <p className="page-subtitle">See what you have, what is coming, and when cash may get tight.</p>
            </div>
            <button
              type="button"
              className={demoMode ? 'button button--demo-active' : 'button button--secondary'}
              aria-pressed={demoMode}
              onClick={() => setDemoMode((current) => !current)}
            >
              <Activity size={16} aria-hidden="true" />
              {demoMode ? 'Exit demo preview' : 'Preview demo data'}
            </button>
          </section>

          {demoMode ? (
            <div className="demo-banner" role="status">
              <span className="demo-banner__tag">DEMO PREVIEW</span>
              <span>Illustrative synthetic values only. They are not fetched from or saved to the backend.</span>
            </div>
          ) : (
            <div className="live-banner" role="status">
              <div className="live-banner__icon">
                {health.state === 'online' ? <CheckCircle2 size={18} aria-hidden="true" /> : <CircleHelp size={18} aria-hidden="true" />}
              </div>
              <div className="live-banner__copy">
                <strong>
                  {health.state === 'online'
                    ? 'API is reachable; no business data is connected'
                    : health.state === 'checking'
                      ? 'Checking the API connection'
                      : 'Live business data is unavailable'}
                </strong>
                <span>
                  {health.state === 'online'
                    ? 'There is no signed-in user or selected business in this frontend yet. Financial values are intentionally blank—not zero.'
                    : health.state === 'checking'
                      ? 'Waiting for the backend health check.'
                      : health.message}
                </span>
              </div>
              {health.state === 'offline' && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setRetryCount((count) => count + 1)}
                >
                  <RefreshCw size={14} aria-hidden="true" /> Retry
                </button>
              )}
            </div>
          )}

          <section className="metrics-grid" aria-label="Cash position summary">
            <article className="metric-card metric-card--balance">
              <div className="metric-card__top">
                <span className="metric-icon metric-icon--green"><Wallet size={18} aria-hidden="true" /></span>
                {demoMode && <span className="data-tag">DEMO</span>}
              </div>
              <p className="metric-label">Cash available</p>
              <strong className="metric-value">{demoMode ? formatPaise(demoData.openingBalancePaise) : '—'}</strong>
              <span className="metric-footnote">
                {demoMode ? 'Opening balance across 2 accounts' : 'No account balance loaded'}
              </span>
            </article>

            <article className="metric-card">
              <div className="metric-card__top">
                <span className="metric-icon metric-icon--blue"><ArrowDownRight size={18} aria-hidden="true" /></span>
                {demoMode && <span className="data-tag">DEMO</span>}
              </div>
              <p className="metric-label">Receivables expected</p>
              <strong className="metric-value">{demoMode ? formatPaise(demoData.expectedReceiptsPaise) : '—'}</strong>
              <span className="metric-footnote">{demoMode ? '1 open customer receipt' : 'No receivables loaded'}</span>
            </article>

            <article className="metric-card">
              <div className="metric-card__top">
                <span className="metric-icon metric-icon--orange"><ArrowUpRight size={18} aria-hidden="true" /></span>
                {demoMode && <span className="data-tag">DEMO</span>}
              </div>
              <p className="metric-label">Payables outstanding</p>
              <strong className="metric-value">{demoMode ? formatPaise(demoData.supplierBillPaise) : '—'}</strong>
              <span className="metric-footnote">{demoMode ? '1 supplier bill due in 5 days' : 'No payables loaded'}</span>
            </article>

            <article className={`metric-card metric-card--risk${demoMode ? ' metric-card--risk-active' : ''}`}>
              <div className="metric-card__top">
                <span className={`metric-icon ${demoMode ? 'metric-icon--red' : 'metric-icon--neutral'}`}>
                  <ShieldAlert size={18} aria-hidden="true" />
                </span>
                {demoMode && <span className="risk-tag">DEMO RISK</span>}
              </div>
              <p className="metric-label">Cash-crunch risk</p>
              <strong className="metric-value metric-value--risk">
                {demoMode ? 'Buffer breach' : 'Not assessed'}
              </strong>
              <span className="metric-footnote">
                {demoMode
                  ? `In 5 days · ${formatPaise(minimumBufferGapPaise)} below demo buffer`
                  : 'A successful forecast is required'}
              </span>
            </article>
          </section>

          <section className="dashboard-grid">
            <article className="panel forecast-panel" id="forecast">
              <div className="panel-heading">
                <div>
                  <div className="panel-title-row">
                    <h2>30-day cash-flow forecast</h2>
                    {demoMode && <span className="data-tag">DEMO SERIES</span>}
                  </div>
                  <p>{demoMode ? 'Illustrative daily closing cash and minimum buffer' : 'Daily closing cash after confirmed and expected movements'}</p>
                </div>
                <span className="range-pill">Next 30 days <ChevronDown size={14} aria-hidden="true" /></span>
              </div>
              {demoMode ? <DemoForecastChart /> : <EmptyForecast />}
            </article>

            <article className="panel risk-panel">
              <div className="panel-heading">
                <div>
                  <div className="panel-title-row"><h2>Early warning</h2>{demoMode && <span className="data-tag">DEMO</span>}</div>
                  <p>Cash buffer check</p>
                </div>
                <span className={`risk-indicator${demoMode ? ' risk-indicator--warning' : ''}`}>
                  {demoMode ? 'At risk' : 'Not assessed'}
                </span>
              </div>
              {demoMode ? (
                <div className="risk-detail">
                  <div className="risk-date"><ShieldAlert size={19} aria-hidden="true" /><strong>Projected in 5 days</strong></div>
                  <p>Cash may fall to {formatPaise(demoData.points[1].balancePaise)}, below the {formatPaise(demoData.bufferPaise)} demo operating buffer.</p>
                  <div className="risk-cause">
                    <span className="risk-cause__line" aria-hidden="true" />
                    <span><strong>Largest driver</strong><small>Deccan Wholesale · supplier bill</small></span>
                    <b>{formatPaise(demoData.supplierBillPaise)}</b>
                  </div>
                  <p className="risk-note">Demo scenario only · not a real alert</p>
                </div>
              ) : (
                <div className="panel-empty">
                  <ShieldAlert size={21} aria-hidden="true" />
                  <strong>No risk assessment yet</strong>
                  <span>Risk appears after a successful forecast is available.</span>
                </div>
              )}
            </article>
          </section>

          <section className="lower-grid" id="dues">
            <article className="panel dues-panel">
              <div className="panel-heading">
                <div>
                  <div className="panel-title-row"><h2>Upcoming money movement</h2>{demoMode && <span className="data-tag">DEMO</span>}</div>
                  <p>Receivables and obligations that affect your next 30 days</p>
                </div>
                <button type="button" className="icon-button" aria-label="About upcoming money movements" title="Only business-scoped records appear here once connected.">
                  <CircleHelp size={17} aria-hidden="true" />
                </button>
              </div>
              {demoMode ? (
                <div className="movement-list">
                  <MovementRow
                    kind="outflow"
                    title="Deccan Wholesale"
                    subtitle="Supplier bill · due in 5 days"
                    amount={formatPaise(demoData.supplierBillPaise)}
                  />
                  <MovementRow
                    kind="inflow"
                    title="Mehta Stores"
                    subtitle="Expected receipt · in 6 days"
                    amount={formatPaise(demoData.expectedReceiptsPaise)}
                  />
                  <MovementRow
                    kind="outflow"
                    title="Shop rent"
                    subtitle="Recurring commitment · in 8 days"
                    amount={formatPaise(demoData.rentPaise)}
                  />
                </div>
              ) : (
                <div className="movement-empty">
                  <CalendarDays size={20} aria-hidden="true" />
                  <p>No receivables or payables loaded.</p>
                  <span>Connect a business to review due dates and outstanding balances.</span>
                </div>
              )}
            </article>

            <article className="panel simulator-panel" id="simulator">
              <div className="simulator-art"><Sparkles size={21} aria-hidden="true" /></div>
              <p className="eyebrow">PLAN BEFORE YOU COMMIT</p>
              <h2>Try a What-If scenario</h2>
              <p className="simulator-description">
                Compare how a changed payment date or planned purchase could affect your cash buffer—without changing your books.
              </p>
              <button
                type="button"
                className="button button--primary simulator-button"
                onClick={() => setShowSimulatorNote((visible) => !visible)}
                aria-expanded={showSimulatorNote}
              >
                Explore the simulator <ArrowRight size={16} aria-hidden="true" />
              </button>
              {showSimulatorNote && (
                <div className="simulator-note" role="status">
                  {demoMode
                    ? 'This demo preview does not run or save a simulation. A real scenario needs a successful live forecast.'
                    : 'A What-If run needs a selected business and a successful baseline forecast. Neither is connected yet.'}
                </div>
              )}
              <span className="simulator-footnote"><LockKeyhole size={13} aria-hidden="true" /> Scenarios never alter actual transactions</span>
            </article>
          </section>

          <footer className="dashboard-footer">
            <span><Clock3 size={14} aria-hidden="true" /> {demoMode ? 'Demo values are synthetic and not saved.' : 'Live figures remain blank until authorized business data is connected.'}</span>
            <button
              type="button"
              className="footer-refresh"
              onClick={() => setRetryCount((count) => count + 1)}
              disabled={health.state === 'checking'}
            >
              <RefreshCw size={13} aria-hidden="true" className={health.state === 'checking' ? 'spin' : ''} />
              Refresh connection
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}

function MovementRow({
  kind,
  title,
  subtitle,
  amount,
}: {
  kind: 'inflow' | 'outflow';
  title: string;
  subtitle: string;
  amount: string;
}) {
  const Icon = kind === 'inflow' ? ArrowDownRight : ArrowUpRight;

  return (
    <div className="movement-row">
      <span className={`movement-icon movement-icon--${kind}`}>
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="movement-copy"><strong>{title}</strong><small>{subtitle}</small></span>
      <strong className={`movement-amount movement-amount--${kind}`}>
        {kind === 'outflow' ? '−' : '+'}{amount}
      </strong>
    </div>
  );
}
