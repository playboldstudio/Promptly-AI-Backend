import { Router } from 'express';
import { pingDb } from '../db/config.js';

const router = Router();

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
