import { Router, raw } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getProfile, getMyPrompts, getSavedPrompts, getTransactions, setUpiId, updateProfile } from '../services/me.service.js';
import { getEarningsSummary, getEarningsByPrompt } from '../services/earnings.service.js';
import { uploadImage } from '../services/storage.service.js';

const router = Router();

// Everything under /me requires a valid Bearer token.
router.use(requireAuth);

// Light validation — real UPI verification (NPCI) is out of scope; the admin
// settles manually and can eyeball the ID. Enforce the standard shape only.
const upiSchema = z.object({
  upiId: z.string().trim().min(4).max(80)
    .regex(/^[\w.\-]+@[a-zA-Z]+$/, 'Enter a valid UPI ID like name@upi'),
});

const profilePatchSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  bio: z.string().trim().max(300).optional(),
  avatarUrl: z.string().trim().url().max(1000).optional(),
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

/**
 * PATCH /me/profile — edit display profile fields.
 * Accepts a partial object: { fullName?, bio?, avatarUrl? }.
 */
router.patch('/profile', async (req, res, next) => {
  try {
    const parsed = profilePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const err = new Error(parsed.error.issues[0]?.message ?? 'Invalid body');
      err.status = 400;
      return next(err);
    }
    const user = await updateProfile(req.userId, parsed.data);
    return res.json({ user });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /me/avatar — upload a profile picture (raw image body, e.g. image/jpeg).
 * Stores the bytes in Cloud Storage and saves the public URL on the user doc.
 */
router.post(
  '/avatar',
  raw({ type: 'image/*', limit: '3mb' }),
  async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        const err = new Error('Send the image file as the raw request body (image/jpeg, image/png, …)');
        err.status = 400;
        return next(err);
      }
      const contentType = String(req.headers['content-type'] ?? 'image/jpeg').split(';')[0].trim();
      const avatarUrl = await uploadImage({
        folder: `avatars/${req.userId}`,
        buffer: req.body,
        contentType,
      });
      const user = await updateProfile(req.userId, { avatarUrl });
      return res.json({ user, avatarUrl });
    } catch (err) {
      if (err.status) return next(err);
      return next(err);
    }
  },
);

export default router;
