import { frontendEnv } from '../config/env';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function checkApiHealth(signal: AbortSignal): Promise<string> {
  const response = await fetch(`${frontendEnv.API_BASE_URL}/health`, {
    headers: { Accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw new Error(`API health check returned HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    payload.status !== 'ok' ||
    typeof payload.service !== 'string'
  ) {
    throw new Error('API health check returned an unexpected response.');
  }

  return payload.service;
}
