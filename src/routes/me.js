import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getProfile, getMyPrompts, getSavedPrompts, getTransactions } from '../services/me.service.js';
import { getEarningsSummary, getEarningsByPrompt } from '../services/earnings.service.js';

const router = Router();

// Everything under /me requires a valid Bearer token.
router.use(requireAuth);

const paging = (req) => ({
  limit: Math.min(Number(req.query.limit) || 50, 100),
  offset: Math.max(Number(req.query.offset) || 0, 0),
});

/** GET /me/profile — profile + current subscription + KYC state. */
router.get('/profile', async (req, res, next) => {
  try {
    const profile = await getProfile(req.userId);
    return res.json({ user: req.user, ...profile });
  } catch (err) {
    return next(err);
  }
});

/** GET /me/prompts — prompts the user published. */
router.get('/prompts', async (req, res, next) => {
  try {
    const result = await getMyPrompts(req.userId, paging(req));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/** GET /me/saved — saved prompts (join table). */
router.get('/saved', async (req, res, next) => {
  try {
    const result = await getSavedPrompts(req.userId, paging(req));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/** GET /me/transactions — the My Account ledger, newest first. */
router.get('/transactions', async (req, res, next) => {
  try {
    const result = await getTransactions(req.userId, paging(req));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/** GET /me/earnings — creator earnings summary (lifetime, withdrawn, pending, balance). */
router.get('/earnings', async (req, res, next) => {
  try {
    const summary = await getEarningsSummary(req.userId);
    return res.json({ earnings: summary });
  } catch (err) {
    return next(err);
  }
});

/** GET /me/earnings/prompts — per-prompt earnings breakdown. */
router.get('/earnings/prompts', async (req, res, next) => {
  try {
    const rows = await getEarningsByPrompt(req.userId);
    return res.json({ prompts: rows });
  } catch (err) {
    return next(err);
  }
});

export default router;
