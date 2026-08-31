import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { hasRazorpayKeys, isAdminEmail } from '../config/env.js';
import { createCheckoutOrder, verifyAndUnlock } from '../services/payments/checkout.service.js';
import {
  requestPayout,
  listPayouts,
  listUserPayouts,
  withdrawalEligibility,
  markPayoutPaid,
  markPayoutFailed,
} from '../services/payments/payouts.service.js';
import { createSubscription, cancelActiveSubscription } from '../services/payments/subscriptions.service.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parsePaging } from '../utils/paging.js';
import { httpError } from '../utils/http-error.js';

const router = Router();

// Money-mutating endpoints — throttle per user/IP to blunt abuse.
const moneyLimiter = rateLimit({ windowMs: 60_000, max: 60, message: 'Too many payment requests — try again shortly' });

// All payment routes require auth. Razorpay-keyed routes (checkout/subscriptions)
// additionally require the keys; the manual-settle payout routes do NOT touch
// Razorpay and must work even when the keys are unset.
router.use(requireAuth);

// Admin back-office: only emails listed in ADMIN_EMAILS may settle payouts.
function requireAdmin(req, res, next) {
  if (!isAdminEmail(req.user?.email)) {
    const err = new Error('You need admin access to do this');
    err.status = 403;
    return next(err);
  }
  return next();
}

function requireRazorpayKeys(req, res, next) {
  if (!hasRazorpayKeys) {
    const err = new Error('Payments are temporarily unavailable. Please try again shortly');
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
    if (!parsed.success) return next(httpError(400, 'Missing the prompt for this purchase'));
    const result = await createCheckoutOrder({ buyerId: req.userId, promptId: parsed.data.promptId });
    if (result.error) return next(httpError(result.error.status, result.error.message));
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
    if (!parsed.success) return next(httpError(400, 'Could not confirm your payment — please try again'));
    const result = await verifyAndUnlock({ buyerId: req.userId, ...parsed.data });
    if (result.error) return next(httpError(result.error.status, result.error.message));
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
    if (!parsed.success) return next(httpError(400, 'Please choose a valid plan'));
    const result = await createSubscription({
      userId: req.userId,
      planId: parsed.data.planId,
    });
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json({ subscription: result });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /payments/subscriptions — cancel the signed-in user's active
 * subscription. Stops renewals at Razorpay; the paid current period stays
 * active until it expires. Admins get 409 (their access is permanent).
 */
router.delete('/subscriptions', moneyLimiter, requireRazorpayKeys, async (req, res, next) => {
  try {
    const result = await cancelActiveSubscription(req.userId);
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

const payoutSchema = z.object({ amountInr: z.number().int().positive() });

/**
 * GET /payments/payouts/eligibility — the signed-in creator's withdrawal rules:
 * withdrawableBalance, minWithdrawalInr, eligible + blockers the UI can render.
 */
router.get('/payouts/eligibility', async (req, res, next) => {
  try {
    const result = await withdrawalEligibility(req.userId);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /payments/payouts — the signed-in creator's payout history.
 * Query params: limit, offset.
 */
router.get('/payouts', async (req, res, next) => {
  try {
    const result = await listUserPayouts(req.userId, parsePaging(req.query));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /payments/payouts — request a withdrawal (manual settle, min ₹60).
 * Body: { amountInr } → { payout: { id, amountInr, status }, balanceInr, ... }
 */
router.post('/payouts', moneyLimiter, async (req, res, next) => {
  try {
    const parsed = payoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, 'Please enter a valid withdrawal amount'));
    const result = await requestPayout({ userId: req.userId, amountInr: parsed.data.amountInr });
    if (result.error) return next(httpError(result.error.status, result.error.message));
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
    const result = await listPayouts({ status, ...parsePaging(req.query) });
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
    if (result.error) return next(httpError(result.error.status, result.error.message));
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
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
