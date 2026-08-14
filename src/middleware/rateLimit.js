/**
 * In-memory fixed-window rate limiter. Keyed by IP for anonymous callers and
 * by userId for signed-in callers. Per-instance state — fine for a single
 * Cloud Run service; a distributed limiter (Redis) is the upgrade path.
 */

const buckets = new Map();

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

// Best-effort cleanup so the map can't grow unbounded.
const INTERVAL = 10 * 60 * 1000;
const timer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.start >= INTERVAL) buckets.delete(key);
  }
}, INTERVAL);
timer.unref();
