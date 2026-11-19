import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TARGET_DB = 'cashflow_sentinel_migration_test';
const PROTECTED_DB = 'cashflow_sentinel';

if (process.env.DB_NAME === PROTECTED_DB) {
  throw new Error(`CRITICAL: Attempted access to protected DB "${PROTECTED_DB}"!`);
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: TARGET_DB,
});

const safetyRes = await pool.query('SELECT current_database() as db');
if (safetyRes.rows[0].db !== TARGET_DB) {
  throw new Error(`Database is not ${TARGET_DB}`);
}
console.log(`[SAFETY CHECK PASSED] Connected to ${TARGET_DB}`);

const BACKEND_PORT = 5055;
const FRONTEND_PORT = 3055;
const CDP_PORT = 9255;
const API_URL = `http://127.0.0.1:${BACKEND_PORT}/api/v1`;

// 1. Start Express backend
import appExport from '../dist/app.js';
const app = appExport.default || appExport;

const server = app.listen(BACKEND_PORT, '0.0.0.0', () => {
  console.log(`[BACKEND] Running on http://127.0.0.1:${BACKEND_PORT}`);
});

// 2. Start Vite on port 3055 with --host 127.0.0.1
const viteProcess = spawn('npx.cmd', ['vite', '--host', '127.0.0.1', '--port', String(FRONTEND_PORT), '--strictPort'], {
  cwd: path.resolve(__dirname, '../../frontend'),
  env: {
    ...process.env,
    VITE_API_URL: API_URL,
  },
  stdio: 'pipe',
  shell: true,
});

viteProcess.stdout.on('data', (d) => {
  const line = d.toString();
  if (line.includes('Local:')) {
    console.log(`[VITE] ${line.trim()}`);
  }
});
viteProcess.stderr.on('data', (d) => {
  console.error(`[VITE ERR] ${d.toString().trim()}`);
});

// Wait for Vite to be ready
console.log(`[WAITING] Checking for Vite /health at http://127.0.0.1:${FRONTEND_PORT}/health...`);
let viteReady = false;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${FRONTEND_PORT}/health`);
    if (res.ok) {
      viteReady = true;
      console.log(`[FRONTEND READY] Vite is listening on port ${FRONTEND_PORT}`);
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
}

if (!viteReady) {
  throw new Error(`Vite failed to start on port ${FRONTEND_PORT}`);
}

// 3. Register Tenants & Seed Data
const suffix = Date.now();

async function createTenant(tag, dayCount) {
  const email = `ui_${tag}_${suffix}@example.com`;
  const password = 'Password@123';
  const displayName = tag === 'insufficient' ? 'Anand Provisions' : 'Mahalaxmi Supermarket';

  const regRes = await fetch(`${API_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: displayName }),
  }).then((r) => r.json());

  if (!regRes.data?.access_token) {
    throw new Error(`Registration failed: ${JSON.stringify(regRes)}`);
  }

  const token = regRes.data.access_token;
  const user = regRes.data.user;

  // Trigger business auto-provisioning
  await fetch(`${API_URL}/transactions/summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const bRes = await pool.query(
    'SELECT b.id FROM businesses b JOIN business_memberships bm ON bm.business_id = b.id WHERE bm.user_id = $1',
    [user.id]
  );
  const businessId = bRes.rows[0].id;

  // Insert transactions
  for (let d = 1; d <= dayCount; d++) {
    const dayStr = d < 10 ? `0${d}` : `${d}`;
    await fetch(`${API_URL}/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        type: d % 2 === 0 ? 'expense' : 'income',
        amount: (3000 + d * 250).toFixed(2),
        transaction_date: `2026-10-${dayStr}`,
        description: `Operational ledger entry day ${d}`,
      }),
    });
  }

  // If dayCount >= 14, configure buffer and generate forecast
  if (dayCount >= 14) {
    // Set buffer to ₹25,000
    await pool.query(
      'UPDATE businesses SET minimum_cash_buffer_paise = 2500000 WHERE id = $1',
      [businessId]
    );

    const genRes = await fetch(`${API_URL}/forecasts/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ horizon_days: 30, as_of_date: '2026-10-15' }),
    }).then((r) => r.json());
    console.log(`[FORECAST GENERATION] Generated forecast run: ${genRes.data?.run?.id}`);
  }

  return { email, token, user, businessId };
}

const tenantInsufficient = await createTenant('insufficient', 3);
const tenantSufficient = await createTenant('sufficient', 15);
console.log(`[DATA PREPARATION] Created tenants: insufficient (${tenantInsufficient.email}) and sufficient (${tenantSufficient.email})`);

// 4. Start headless Chrome / Edge
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browserExe = fs.existsSync(edgePath) ? edgePath : chromePath;

const browserProcess = spawn(
  browserExe,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=1440,1100',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

await new Promise((resolve) => setTimeout(resolve, 2500));
console.log(`[BROWSER] Headless browser started on CDP ${CDP_PORT}`);

const listRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const pageTarget = listRes.find((t) => t.type === 'page') || listRes[0];
const wsUrl = pageTarget.webSocketDebuggerUrl;

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let msgId = 1;
function sendCdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const handler = (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : event.data.toString();
        const data = JSON.parse(text);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          if (data.error) {
            reject(new Error(`CDP Error in ${method}: ${JSON.stringify(data.error)}`));
          } else {
            resolve(data.result);
          }
        }
      } catch (err) {
        console.error('Error parsing CDP message:', err);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Log console messages
ws.addEventListener('message', (event) => {
  try {
    const text = typeof event.data === 'string' ? event.data : event.data.toString();
    const data = JSON.parse(text);
    if (data.method === 'Runtime.consoleAPICalled') {
      const args = (data.params.args || []).map((a) => a.value || a.description).join(' ');
      console.log(`[BROWSER CONSOLE ${data.params.type}]`, args);
    }
  } catch {}
});

await sendCdp('Page.enable');
await sendCdp('Runtime.enable');
await sendCdp('DOM.enable');
await sendCdp('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1500,
  deviceScaleFactor: 1,
  mobile: false,
});

const artifactDir = 'C:\\Users\\prach\\.gemini\\antigravity\\brain\\61fb7b04-e2d2-4bc4-b9ea-1e2346d4015c';

async function screenshotDashboard(tenant, filename, scrollForecast = false) {
  const url = `http://127.0.0.1:${FRONTEND_PORT}/?token=${tenant.token}`;
  console.log(`[NAVIGATING] ${filename} to ${url}`);
  await sendCdp('Page.navigate', { url });

  // Wait 4.5 seconds for full React load and forecast API completion
  await new Promise((r) => setTimeout(r, 4500));

  if (scrollForecast) {
    await sendCdp('Runtime.evaluate', {
      expression: `
        const el = document.querySelector('.forecast-panel') || document.querySelector('.risk-panel');
        if (el) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
      `,
    });
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Inspect page title/content
  const evalRes = await sendCdp('Runtime.evaluate', {
    expression: 'document.body.innerText.slice(0, 300)',
  });
  console.log(`[PAGE TEXT PREVIEW]`, evalRes.result?.value?.replace(/\n+/g, ' '));

  console.log(`[CAPTURING] ${filename}...`);
  const screenshotRes = await sendCdp('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  });

  if (!screenshotRes || !screenshotRes.data) {
    throw new Error(`Screenshot failed for ${filename}: empty CDP response`);
  }

  const outPath = path.join(artifactDir, filename);
  const buffer = Buffer.from(screenshotRes.data, 'base64');
  fs.writeFileSync(outPath, buffer);
  console.log(`✅ Saved ${filename} (${buffer.length} bytes) to ${outPath}`);
}

await screenshotDashboard(tenantInsufficient, 'dashboard_insufficient_history.png', false);
await screenshotDashboard(tenantSufficient, 'dashboard_forecast_sufficient.png', true);

// 5. Cleanup
ws.close();
browserProcess.kill();
viteProcess.kill();
server.close();
await pool.end();

console.log(`\n========================================`);
console.log(`ALL DASHBOARD SCREENSHOTS CAPTURED SUCCESSFULLY`);
console.log(`========================================\n`);
