import { SubscriptionPlan, UserSubscription } from '../../db/models.js';
import { sequelize } from '../../db/config.js';
import { razorpay } from '../../lib/razorpay.js';
import { razorpayPlanIdFor } from '../../config/env.js';
import { writeLedger } from '../ledger.js';

/**
 * SUBSCRIPTIONS — Razorpay Subscriptions (₹49 Pro / ₹99 Creator monthly).
 *
 * Flow:
 *   1. POST /payments/subscriptions → createSubscription():
 *        - validates the plan exists + is active (paid plans only)
 *        - enforces ONE active subscription per user (no double-subscribing)
 *        - maps our plan id → the Razorpay plan id created in the dashboard
 *        - calls Razorpay Subscriptions API → a checkout URL for the app to open
 *   2. User pays → webhook `subscription.charged` → activateSubscription():
 *        - writes/updates the `UserSubscription` row (status active, period dates)
 *        - debits the ledger (type = subscription_payment, ref_id = sub id)
 *        - idempotent — replays can't double-charge (guarded by webhook dispatch)
 *   3. Renewals → `subscription.charged` again → current_period_end rolls forward.
 *   4. Cancel / expiry → `subscription.cancelled` / `subscription.expired`
 *        → status = cancelled/expired + cancelled_at.
 *
 * All money is integer rupees.
 */

const PERIOD_MONTH_MS = 30 * 24 * 60 * 60 * 1000; // Razorpay "every month" ≈ 30 days

/** Return a 4xx-style error object, matching checkout.service's shape. */
function err(status, message) {
  return { error: { status, message } };
}

/**
 * Phase 1 — create a Razorpay subscription for a paid plan.
 * @returns {{ razorpaySubId, planId, planName, priceInr, currency, totalCount, interval, notes, customer, expireBy } | {error}}
 */
export async function createSubscription({ userId, planId, customerDetails }) {
  const plan = await SubscriptionPlan.findByPk(planId);
  if (!plan || !plan.isActive || !plan.priceInr) {
    return err(404, 'Plan not found');
  }
  if (plan.priceInr <= 0) {
    return err(400, 'The free plan is automatic — no Razorpay subscription needed');
  }

  // One active subscription per user. A user on Pro who upgrades to Creator
  // should cancel the old one first (the UI can offer that as a separate flow).
  const existing = await UserSubscription.findOne({ where: { userId, status: 'active' } });
  if (existing) {
    return err(409, 'You already have an active subscription');
  }

  const razorpayPlanId = razorpayPlanIdFor(planId);
  if (!razorpayPlanId) {
    return err(
      501,
      `No Razorpay plan configured for "${planId}" — set RAZORPAY_PLAN_${planId.toUpperCase()}_ID`,
    );
  }

  const periodEnd = Date.now() + PERIOD_MONTH_MS;
  const subscription = await razorpay.subscriptions.create({
    plan_id: razorpayPlanId,
    total_count: 12, // renews monthly; webhook charges each cycle
    quantity: 1,
    customer_notify: 1,
    notes: { userId },
    // charge in the background on a schedule, not via a one-time checkout
    ...(customerDetails?.customerId ? { customer_id: customerDetails.customerId } : {}),
    // default no-auth auto-charge is NOT used — the UI opens the payment page from short_url
  });

  return {
    razorpaySubId: subscription.id,
    planId,
    planName: plan.name,
    priceInr: plan.priceInr,
    currency: 'INR',
    totalCount: subscription.total_count,
    interval: subscription.interval,
    shortUrl: subscription.short_url, // app opens this for the user to pay
    periodEndIso: new Date(periodEnd).toISOString(),
  };
}

/**
 * Activate a subscription after a successful charge (webhook `subscription.charged`).
 * Called by the webhook dispatcher AFTER the event is idempotently claimed.
 * @param {object} sub Razorpay subscription object from the webhook payload
 * @returns {Promise<void>} — throws on DB failure; caller marks the event failed
 */
export async function activateSubscription(sub) {
  const userId = sub.notes?.userId;
  if (!userId) return; // seeded/historical subs without notes — nothing to wire

  const planId = planIdFromRazorpayPlan(sub.plan_id);
  if (!planId) {
    // Plan removed from dashboard — still record the row so history is honest.
    // (plan_id FK is enforced, so skip writing rather than crash the webhook.)
    return;
  }

  const periodStart = new Date(sub.current_start * 1000);
  const periodEnd = new Date(sub.current_end * 1000);

  // Sub rows only get razorpay_sub_id after the user actually pays (Razorpay
  // returns it in subscription.charged). If one already exists, reuse it so we
  // don't leak rows on every renewal.
  const existing = await UserSubscription.findOne({ where: { razorpaySubId: sub.id } });

  await sequelize.transaction(async (t) => {
    if (existing) {
      // Renewal — roll current_period_* forward; status stays active.
      await existing.update(
        { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, status: 'active' },
        { transaction: t },
      );
    } else {
      await UserSubscription.create(
        {
          userId,
          planId,
          razorpaySubId: sub.id,
          status: 'active',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
        { transaction: t },
      );
    }

    // Ledger — the user pays the platform for the plan (a debit on their balance).
    const plan = await SubscriptionPlan.findByPk(planId);
    if (plan?.priceInr) {
      await writeLedger(
        {
          userId,
          type: 'subscription_payment',
          direction: 'debit',
          amountInr: plan.priceInr,
          refId: sub.id,
          note: `Subscription — ${plan.name} (₹${plan.priceInr}/month)`,
        },
        t,
      );
    }
  });
}

/**
 * Handle `subscription.cancelled` / `subscription.expired` webhooks.
 */
export async function deactivateSubscription(sub) {
  const [row] = await UserSubscription.findAll({
    where: { razorpaySubId: sub.id, status: 'active' },
    order: [['createdAt', 'DESC']],
    limit: 1,
  });
  if (!row) return;
  await row.update({
    status: sub.status === 'cancelled' ? 'cancelled' : 'expired',
    cancelledAt: new Date(),
  });
}

/** Map a Razorpay plan_id → our plan id. 'free' has no Razorpay plan. */
function planIdFromRazorpayPlan(rzpPlanId) {
  if (!rzpPlanId) return null;
  for (const ours of ['pro', 'creator']) {
    if (razorpayPlanIdFor(ours) === rzpPlanId) return ours;
  }
  return null;
}
