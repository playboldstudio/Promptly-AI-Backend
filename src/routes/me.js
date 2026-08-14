import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getProfile, getMyPrompts, getSavedPrompts, getTransactions, setUpiId } from '../services/me.service.js';
import { getEarningsSummary, getEarningsByPrompt } from '../services/earnings.service.js';

const router = Router();

// Everything under /me requires a valid Bearer token.
router.use(requireAuth);

// Light validation — real UPI verification (NPCI) is out of scope; the admin
// settles manually and can eyeball the ID. Enforce the standard shape only.
const upiSchema = z.object({
  upiId: z.string().trim().min(4).max(80)
    .regex(/^[\w.\-]+@[a-zA-Z]+$/, 'Enter a valid UPI ID like name@upi'),
});

const paging = (req) => ({
  limit: Math.min(Number(req.query.limit) || 50, 100),
  offset: Math.max(Number(req.query.offset) || 0, 0),
});

router.get('/profile', async (req, res, next) => {
  try {
    const profile = await getProfile(req.userId);
    return res.json({ user: req.user, ...profile });
  } catch (err) {
    return next(err);
  }
});

router.get('/prompts', async (req, res, next) => {
  try {
    const result = await getMyPrompts(req.userId, paging(req));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/saved', async (req, res, next) => {
  try {
    const result = await getSavedPrompts(req.userId, paging(req));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/transactions', async (req, res, next) => {
  try {
    const result = await getTransactions(req.userId, paging(req));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/earnings', async (req, res, next) => {
  try {
    const summary = await getEarningsSummary(req.userId);
    return res.json({ earnings: summary });
  } catch (err) {
    return next(err);
  }
});

router.get('/earnings/prompts', async (req, res, next) => {
  try {
    const rows = await getEarningsByPrompt(req.userId);
    return res.json({ prompts: rows });
  } catch (err) {
    return next(err);
  }
});

router.post('/upi', async (req, res, next) => {
  try {
    const parsed = upiSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const err = new Error(parsed.error.issues[0]?.message ?? 'Invalid body — expected { upiId: string }');
      err.status = 400;
      return next(err);
    }
    const user = await setUpiId(req.userId, parsed.data.upiId);
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

export default router;
