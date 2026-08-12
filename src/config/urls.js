import { env } from './env.js';

/**
 * The single, always-live API base URL.
 *
 * The local/testing URL has been removed — everything points at the live
 * deployment. `PUBLIC_BASE_URL` (Render env) overrides the default service URL.
 */
export const API_BASE_URL =
  env.PUBLIC_BASE_URL || 'https://promptly-ai-backend-svho.onrender.com';

/**
 * Browser origins CORS accepts — the live URL plus anything in `CORS_ORIGINS`
 * (e.g. a web frontend dev server). Mobile apps don't send an Origin header and
 * are always allowed.
 */
export function allowedOrigins() {
  const extra = (env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([API_BASE_URL, ...extra]);
}