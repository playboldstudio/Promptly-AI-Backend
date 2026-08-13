/**
 * Lightweight in-memory fixed-window rate limiter (no external dependency).
 *
 * Protects abuse-prone endpoints (auth login, payment verification, prompt
 * publishing). Keyed by IP for anonymous callers and by userId for signed-in
 * callers (a rotating IP can't bypass a signed-in user's quota).
 *
 * This is per-instance state — fine for Cloud Run's small scale and for a
 * single deployed service. A distributed limiter (Redis) would be the upgrade
 * if the app grows to many instances.
 */

const buckets = new Map(); // key -> { start, count }

/**
 * @param {object} opts
 * @param {number} [opts.windowMs=60000]  window length in ms
 * @param {number} [opts.max=60]          max requests per window
 * @param {string} [opts.message]         message for the 429 response
 */
export function rateLimit({ windowMs = 60_000, max = 60, message = 'Too many requests — slow down' } = {}) {
  return (req, _res, next) => {
    const key = req.userId ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const err = new Error(message);
      err.status = 429;
      return next(err);
    }

    return next();
  };
}

// Best-effort cleanup so the map can't grow unbounded across many keys.
const INTERVAL = 10 * 60 * 1000;
const timer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.start >= INTERVAL) buckets.delete(key);
  }
}, INTERVAL);
timer.unref(); // don't keep the process alive for cleanup only
