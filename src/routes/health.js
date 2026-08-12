import { Router } from 'express';
import { pingDb } from '../db/config.js';

const router = Router();

/**
 * GET /health — liveness + DB connectivity.
 * Always returns 200 for liveness; `db` reports whether `SELECT 1` succeeds.
 * The app stays up (and serves the API) even when the DB is down.
 */
router.get('/health', async (_req, res) => {
  let db = 'down';
  try {
    if (await pingDb()) db = 'up';
  } catch {
    // fall through — db stays 'down'
  }

  res.json({
    status: 'ok',
    db,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
