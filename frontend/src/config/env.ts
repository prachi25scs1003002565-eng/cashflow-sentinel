const configuredApiUrl = import.meta.env.VITE_API_URL?.trim() || '/api/v1';
const isAbsoluteHttpUrl = /^https?:\/\//i.test(configuredApiUrl);

if (!isAbsoluteHttpUrl && (
  !configuredApiUrl.startsWith('/') ||
  configuredApiUrl.startsWith('//')
)) {
  throw new Error('VITE_API_URL must be an HTTP(S) URL or a root-relative path.');
}

const parsedApiUrl = new URL(configuredApiUrl, 'http://localhost');
if (!['http:', 'https:'].includes(parsedApiUrl.protocol)) {
  throw new Error('VITE_API_URL must use HTTP or HTTPS.');
}

export const frontendEnv = Object.freeze({
  API_BASE_URL: configuredApiUrl.replace(/\/+$/, ''),
});
