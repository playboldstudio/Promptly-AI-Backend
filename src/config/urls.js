import { env } from './env.js';

/**
 * The single, always-live API base URL.
 *
 * On Cloud Run this is your assigned HTTPS URL, e.g.
 * `https://<service>-<hash>.run.app`. Set it via the `PUBLIC_BASE_URL` env var
 * (Cloud Run) so the Android/Web client and CORS allow-list it. The fallback
 * below is only a placeholder so local dev boots without it.
 */
export const API_BASE_URL =
  env.PUBLIC_BASE_URL || 'http://localhost:8080';

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
