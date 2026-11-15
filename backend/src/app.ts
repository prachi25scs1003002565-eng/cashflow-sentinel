import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandlerMiddleware } from './middleware/error-handler';
import { requestIdMiddleware } from './middleware/request-id';

const app = express();
const apiBasePath = new URL(env.API_BASE_URL).pathname.replace(/\/+$/, '');

app.disable('x-powered-by');
app.use(requestIdMiddleware);
app.use(helmet());
app.use(cors({
  origin: env.CORS_ORIGIN,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.get(`${apiBasePath}/health`, (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'cashflow-sentinel-api',
  });
});

app.use(errorHandlerMiddleware);

export default app;
