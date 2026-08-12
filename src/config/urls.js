import { env } from './env.js';

/**
 * The API's two base URLs — local (testing) vs live (production).
 *
 * This is the single place the local/live split lives. CORS and any absolute
 * links (e.g. the Razorpay webhook URL) read from here. The frontend does the
 * real API_BASE_URL switch — see README "Local vs live base URL".
 */
export const BASE_URLS = {
  /** Local dev server. Android emulators should use http://10.0.2.2:3000. */
  local: 'http://localhost:3000',
  /** Live Render service — override the default with PUBLIC_BASE_URL in .env. */
  live: env.PUBLIC_BASE_URL || 'https://promptly-ai-backend.onrender.com',
};

/** The base URL the app should use right now, based on NODE_ENV. */
export function getApiBaseUrl() {
  return BASE_URLS[env.NODE_ENV === 'production' ? 'live' : 'local'];
}

/**
 * Browser origins CORS accepts — always local + live, plus anything listed in
 * CORS_ORIGINS (e.g. the frontend's own dev server on a different port).
 */
export function allowedOrigins() {
  const extra = (env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([BASE_URLS.local, BASE_URLS.live, ...extra]);
}
