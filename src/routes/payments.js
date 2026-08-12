import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { hasRazorpayKeys } from '../config/env.js';
import { createCheckoutOrder, verifyAndUnlock } from '../services/payments/checkout.service.js';
import {
  requestPayout,
  listPayouts,
  markPayoutPaid,
  markPayoutFailed,
} from '../services/payments/payouts.service.js';
import { createSubscription } from '../services/payments/subscriptions.service.js';

const router = Router();

// All payment routes require auth. Razorpay-keyed routes (checkout/subscriptions)
// additionally require the keys; the manual-settle payout routes do NOT touch
// Razorpay and must work even when the keys are unset.
router.use(requireAuth);

function requireRazorpayKeys(req, res, next) {
  if (!hasRazorpayKeys) {
    const err = new Error('Razorpay is not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    err.status = 501;
    return next(err);
  }
  return next();
}

const orderSchema = z.object({ promptId: z.string().uuid() });
const verifySchema = z.object({
  promptId: z.string().uuid(),
  orderId: z.string(),
  paymentId: z.string(),
  signature: z.string(),
  amountInr: z.number().int().positive().optional(),
});

/**
 * POST /payments/checkout/order — create a Razorpay order for a paid prompt.
 * Body: { promptId } → { orderId, amountInr, currency, feePercent, feeInr, netInr, prompt }
 */
router.post('/checkout/order', requireRazorpayKeys, async (req, res, next) => {
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
 * Body: { promptId, orderId, paymentId, signature } (Razorpay Checkout success payload)
 */
router.post('/checkout/verify', requireRazorpayKeys, async (req, res, next) => {
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
 * The app opens subscription.shortUrl to collect the first payment.
 */
router.post('/subscriptions', requireRazorpayKeys, async (req, res, next) => {
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
 * The admin transfers the money via their own bank app, then marks it paid.
 */
router.post('/payouts', async (req, res, next) => {
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

/* ── Admin (solo developer) — manual settle ───────────────────────────────
 * The platform pays out with YOUR bank app, not Razorpay. These endpoints are
 * your back-office: list pending requests, then mark them paid/failed after
 * you've transferred the money.
 *
 * ⚠️ DEV ONLY: the admin "check" is just requireAuth. There is no role field
 * enforced. Before launch, gate these behind a real admin role/token.
 */

/**
 * GET /payments/admin/payouts?status=pending — list payout requests with the
 * bank details (full account number) needed to transfer.
 */
router.get('/admin/payouts', async (req, res, next) => {
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
router.post('/admin/payouts/:id/mark-paid', async (req, res, next) => {
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
router.post('/admin/payouts/:id/mark-failed', async (req, res, next) => {
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
