import { env } from './env.js';

export const API_BASE_URL =
  env.PUBLIC_BASE_URL || 'http://localhost:8080';

/**
 * Browser origins CORS accepts — the live URL plus anything in `CORS_ORIGINS`.
 * Mobile apps don't send an Origin header and are always allowed.
 */
export function allowedOrigins() {
  const extra = (env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([API_BASE_URL, ...extra]);
}
