import request from 'supertest';
import appExport from '../dist/app.js';
import { Database } from '../dist/db/index.js';

const app = appExport.default || appExport;

async function run() {
  try {
    const r1 = await request(app).get('/health');
    console.log('GET /health:', r1.status, JSON.stringify(r1.body));

    const r2 = await request(app).get('/api/v1/health');
    console.log('GET /api/v1/health:', r2.status, JSON.stringify(r2.body));

    const r3 = await request(app).get('/health/ready');
    console.log('GET /health/ready:', r3.status, JSON.stringify(r3.body));

    const r4 = await request(app).get('/api/v1/health/ready');
    console.log('GET /api/v1/health/ready:', r4.status, JSON.stringify(r4.body));

    if (
      r1.status === 200 && r1.body.status === 'ok' &&
      r2.status === 200 && r2.body.status === 'ok' &&
      r3.status === 200 && r3.body.database === 'connected' &&
      r4.status === 200 && r4.body.database === 'connected'
    ) {
      console.log('✅ ALL HEALTH CHECKS PASSED');
      process.exitCode = 0;
    } else {
      console.error('❌ HEALTH CHECK ASSERTION FAILED');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('❌ ERROR DURING HEALTH CHECK:', err);
    process.exitCode = 1;
  } finally {
    await Database.close();
    process.exit(process.exitCode || 0);
  }
}

run();
