import { Server } from 'http';
import app from './app';
import { env } from './config/env';
import { Database } from './db';

const server: Server = app.listen(env.PORT, () => {
  console.log(`Cashflow Sentinel API listening on port ${env.PORT}`);
});

server.on('error', (error) => {
  console.error('Cashflow Sentinel API failed to start:', error);
  process.exitCode = 1;
});

const shutdown = (signal: string) => {
  console.log(`Received ${signal}; shutting down API server.`);
  server.close((error) => {
    if (error) {
      console.error('API server shutdown failed:', error);
      process.exitCode = 1;
    }

    Database.close()
      .then(() => {
        if (error) {
          process.exitCode = 1;
        }
      })
      .catch((databaseError: unknown) => {
        console.error('PostgreSQL pool shutdown failed:', databaseError);
        process.exitCode = 1;
      });
  });
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
