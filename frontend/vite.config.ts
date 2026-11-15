import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

function registerHealthCheck(middlewares: ViteDevServer['middlewares']) {
  middlewares.use('/health', (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      service: 'cashflow-sentinel-frontend',
    }));
  });
}

function healthCheckPlugin(): Plugin {
  return {
    name: 'cashflow-sentinel-health-check',
    configureServer(server: ViteDevServer) {
      registerHealthCheck(server.middlewares);
    },
    configurePreviewServer(server: PreviewServer) {
      registerHealthCheck(server.middlewares);
    },
  };
}

export default defineConfig({
  envDir: '..',
  plugins: [react(), healthCheckPlugin()],
  server: {
    port: 3000,
    proxy: {
      '/api/v1': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
