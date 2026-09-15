import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parsePaging } from '../utils/paging.js';
import { httpError } from '../utils/http-error.js';
import {
  generateReferralCode,
  getReferralCode,
  validateReferralCode,
  applyReferralCode,
  isOAuthSignIn,
  getReferralStats,
  getReferralList,
} from '../services/referrals/referral.service.js';

const router = Router();

// Code apply/validate mutates wallets — throttle per user/IP.
const referralLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: 'Too many referral requests — try again shortly',
});

// Apply + code generation are auth-protected; validate is public.
const applySchema = z.object({
  code: z.string().min(1),
  playAccountId: z.string().optional().default(''),
});

/**
 * Referral program endpoints (plans/referrals.md §6).
 *
 *   POST /referrals/code        — generate (or return) my code   [auth]
 *   GET  /referrals/code        — get (creating if absent) code  [auth]
 *   GET  /referrals/:code/validate — check a code publicly       [public]
 *   POST /referrals/apply       — apply a code at signup         [auth, oAuth-only]
 *   GET  /referrals/stats       — my invite stats                [auth]
 *   GET  /referrals/list        — my invites                     [auth]
 */
router.use('/code', requireAuth);
router.use('/apply', requireAuth);
router.use('/stats', requireAuth);
router.use('/list', requireAuth);

// No requireAuth below here — /validate is public; the private routes above
// are already gated.

// ─── Code ────────────────────────────────────────────────────────────────
router.post('/code', referralLimiter, async (req, res, next) => {
  try {
    const result = await generateReferralCode(req.userId);
    return res.json({ code: result.code, alreadyExists: result.alreadyExists });
  } catch (err) {
    return next(err);
  }
});

router.get('/code', async (req, res, next) => {
  try {
    const result = await getReferralCode(req.userId);
    return res.json({ code: result.code, alreadyExists: result.alreadyExists });
  } catch (err) {
    return next(err);
  }
});

// ─── Validate (public) ───────────────────────────────────────────────────
router.get('/:code/validate', referralLimiter, async (req, res, next) => {
  try {
    const result = await validateReferralCode(req.params.code);
    if (!result.valid) return next(httpError(400, result.error));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// ─── Apply (signup, oAuth-only) ──────────────────────────────────────────
router.post('/apply', referralLimiter, async (req, res, next) => {
  try {
    const parsed = applySchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, 'Missing referral code'));

    // oAuth-only gate — non-oAuth sign-ins get a graceful skip.
    if (!isOAuthSignIn(req.user)) {
      return next(httpError(400, 'Referral codes apply to oAuth sign-ups only'));
    }

    const result = await applyReferralCode({
      refereeId: req.userId,
      code: parsed.data.code,
      playAccountId: parsed.data.playAccountId || null,
      ipAddress: req.ip,
    });
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// ─── Stats ───────────────────────────────────────────────────────────────
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await getReferralStats(req.userId);
    const { code } = await getReferralCode(req.userId);
    return res.json({ ...stats, referralCode: code });
  } catch (err) {
    return next(err);
  }
});

// ─── List ────────────────────────────────────────────────────────────────
router.get('/list', async (req, res, next) => {
  try {
    const paging = parsePaging(req.query);
    const list = await getReferralList(req.userId, paging);
    return res.json(list);
  } catch (err) {
    return next(err);
  }
});

export default router;
