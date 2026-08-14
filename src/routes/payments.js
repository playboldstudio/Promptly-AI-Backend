import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { hasRazorpayKeys, env } from '../config/env.js';
import { createCheckoutOrder, verifyAndUnlock } from '../services/payments/checkout.service.js';
import {
  requestPayout,
  listPayouts,
  markPayoutPaid,
  markPayoutFailed,
} from '../services/payments/payouts.service.js';
import { createSubscription } from '../services/payments/subscriptions.service.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// Money-mutating endpoints — throttle per user/IP to blunt abuse.
const moneyLimiter = rateLimit({ windowMs: 60_000, max: 60, message: 'Too many payment requests — try again shortly' });

// All payment routes require auth. Razorpay-keyed routes (checkout/subscriptions)
// additionally require the keys; the manual-settle payout routes do NOT touch
// Razorpay and must work even when the keys are unset.
router.use(requireAuth);

// Admin back-office: only emails listed in ADMIN_EMAILS may settle payouts.
const adminEmails = new Set(
  (env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function requireAdmin(req, res, next) {
  if (!req.user?.email || !adminEmails.has(req.user.email)) {
    const err = new Error('Admin access required');
    err.status = 403;
    return next(err);
  }
  return next();
}

function requireRazorpayKeys(req, res, next) {
  if (!hasRazorpayKeys) {
    const err = new Error('Razorpay is not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    err.status = 501;
    return next(err);
  }
  return next();
}

// promptId is a Firestore doc id — seeded prompts use slugs, creator-created
// prompts use UUIDs — so accept any non-empty string.
const orderSchema = z.object({ promptId: z.string().min(1) });
const verifySchema = z.object({
  promptId: z.string().min(1),
  orderId: z.string(),
  paymentId: z.string(),
  signature: z.string(),
});

/**
 * POST /payments/checkout/order — create a Razorpay order for a paid prompt.
 * Body: { promptId } → { orderId, amountInr, currency, feePercent, feeInr, netInr, prompt }
 */
router.post('/checkout/order', moneyLimiter, requireRazorpayKeys, async (req, res, next) => {
  try {
    const parsed = orderSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const err = new Error('Invalid body — expected { promptId: uuid }');
      err.status = 400;
      return next(err);
    }
    const result = await createCheckoutOrder({ buyerId: req.userId, promptId: parsed.data.promptId });
    if (result.error) {
      const { status, message } = result.error;
      const err = new Error(message);
      err.status = status;
      return next(err);
    }
    return res.json({ order: result });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /payments/checkout/verify — verify the payment + unlock the prompt.
 * Body: { promptId, orderId, paymentId, signature }
 */
router.post('/checkout/verify', moneyLimiter, requireRazorpayKeys, async (req, res, next) => {
  try {
    const parsed = verifySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const err = new Error('Invalid body — expected { promptId, orderId, paymentId, signature }');
      err.status = 400;
      return next(err);
    }
    const result = await verifyAndUnlock({ buyerId: req.userId, ...parsed.data });
    if (result.error) {
      const { status, message } = result.error;
      const err = new Error(message);
      err.status = status;
      return next(err);
    }
    return res.json({ success: true, unlocked: true, promptId: result.promptId });
  } catch (err) {
    return next(err);
  }
});

const subscriptionSchema = z.object({ planId: z.enum(['pro', 'creator']) });

/**
 * POST /payments/subscriptions — create a Razorpay subscription for a paid plan.
 * Body: { planId: "pro" | "creator" } → { subscription: { razorpaySubId, shortUrl, ... } }
 */
router.post('/subscriptions', moneyLimiter, requireRazorpayKeys, async (req, res, next) => {
  try {
    const parsed = subscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const err = new Error('Invalid body — expected { planId: "pro" | "creator" }');
      err.status = 400;
      return next(err);
    }
    const result = await createSubscription({
      userId: req.userId,
      planId: parsed.data.planId,
    });
    if (result.error) {
      const { status, message } = result.error;
      const err = new Error(message);
      err.status = status;
      return next(err);
    }
    return res.json({ subscription: result });
  } catch (err) {
    return next(err);
  }
});

const payoutSchema = z.object({ amountInr: z.number().int().positive() });

/**
 * POST /payments/payouts — request a withdrawal (manual settle, min ₹60).
 * Body: { amountInr } → { payout: { id, amountInr, status } }
 */
router.post('/payouts', moneyLimiter, async (req, res, next) => {
  try {
    const parsed = payoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const err = new Error('Invalid body — expected { amountInr: number }');
      err.status = 400;
      return next(err);
    }
    const result = await requestPayout({ userId: req.userId, amountInr: parsed.data.amountInr });
    if (result.error) {
      const { status, message } = result.error;
      const err = new Error(message);
      err.status = status;
      return next(err);
    }
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

/* ── Admin (manual settle) ───────────────────────────────────────────────────
 * These are the payout back-office endpoints: list pending requests, then mark
 * them paid/failed after you've transferred the money.
 */

/**
 * GET /payments/admin/payouts?status=pending — list payout requests with the
 * transfer details (UPI ID, creator) the admin needs to pay out manually.
 */
router.get('/admin/payouts', requireAdmin, async (req, res, next) => {
  try {
    const { status } = req.query;
    const result = await listPayouts({ status, limit: req.query.limit, offset: req.query.offset });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /payments/admin/payouts/:id/mark-paid — mark a payout paid after the
 * money has been transferred manually.
 */
router.post('/admin/payouts/:id/mark-paid', moneyLimiter, requireAdmin, async (req, res, next) => {
  try {
    const result = await markPayoutPaid({ payoutId: req.params.id });
    if (result.error) {
      const { status, message } = result.error;
      const err = new Error(message);
      err.status = status;
      return next(err);
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /payments/admin/payouts/:id/mark-failed — mark a payout failed; the
 * reserved balance is returned to the creator.
 */
router.post('/admin/payouts/:id/mark-failed', moneyLimiter, requireAdmin, async (req, res, next) => {
  try {
    const result = await markPayoutFailed({
      payoutId: req.params.id,
      reason: req.body?.reason,
    });
    if (result.error) {
      const { status, message } = result.error;
      const err = new Error(message);
      err.status = status;
      return next(err);
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
