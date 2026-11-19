import cors from 'cors';
import express, { Request, Response } from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { Database } from './db';
import { errorHandlerMiddleware } from './middleware/error-handler';
import authRoutes from './modules/auth/auth.routes';
import transactionsRoutes from './modules/transactions/transactions.routes';
import forecastingRoutes from './modules/forecasting/forecasting.routes';
import { requestIdMiddleware } from './middleware/request-id';

const app = express();
const apiBasePath = new URL(env.API_BASE_URL).pathname.replace(/\/+$/, '');

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(requestIdMiddleware);
app.use(helmet());

const configuredOrigins = env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
const defaultOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3055',
  'http://127.0.0.1:3055',
  'http://localhost:3002',
  'http://127.0.0.1:3002',
];
const allowedOrigins = Array.from(new Set([...configuredOrigins, ...defaultOrigins]));

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Liveness and readiness handlers
const handleLiveness = (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'cashflow-sentinel-api',
  });
};

const handleReadiness = async (_req: Request, res: Response) => {
  try {
    const isConnected = await Database.testConnection();
    if (isConnected) {
      return res.status(200).json({
        status: 'ok',
        service: 'cashflow-sentinel-api',
        database: 'connected',
      });
    }
    return res.status(503).json({
      status: 'error',
      service: 'cashflow-sentinel-api',
      database: 'disconnected',
    });
  } catch (_err) {
    return res.status(503).json({
      status: 'error',
      service: 'cashflow-sentinel-api',
      database: 'disconnected',
    });
  }
};

// Root health checks (for cloud orchestrators / load balancers)
app.get('/health', handleLiveness);
app.get('/health/ready', handleReadiness);

// API-scoped health checks
if (apiBasePath && apiBasePath !== '') {
  app.get(`${apiBasePath}/health`, handleLiveness);
  app.get(`${apiBasePath}/health/ready`, handleReadiness);
}

app.use(`${apiBasePath}/auth`, authRoutes);
app.use(`${apiBasePath}`, transactionsRoutes);
app.use(`${apiBasePath}/businesses/:businessId`, transactionsRoutes);
app.use(`${apiBasePath}`, forecastingRoutes);
app.use(`${apiBasePath}/businesses/:businessId`, forecastingRoutes);

app.use(errorHandlerMiddleware);

export default app;
