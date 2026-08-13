import { COLS, findByPk, queryAll, inTxGet, inTxSet, update } from '../../db/firestoreRepo.js';
import { runTransaction } from '../../db/config.js';
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
 *        - writes/updates the `user_subscriptions` row (status active, period dates)
 *        - debits the ledger (type = subscription_payment, ref_id = sub id)
 *        - idempotent — replays can't double-charge (guarded by webhook dispatch)
 *   3. Renewals → `subscription.charged` again → current_period_end rolls forward.
 *   4. Cancel / expiry → `subscription.cancelled` / `subscription.expired`
 *        → status = cancelled/expired + cancelled_at.
 *
 * The user_subscriptions doc id IS the Razorpay subscription id, so a renewal
 * upserts the same doc (rolls the period forward) instead of leaking rows.
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
  const plan = await findByPk(COLS.subscriptionPlans, planId);
  if (!plan || !plan.isActive || !plan.priceInr) {
    return err(404, 'Plan not found');
  }
  if (plan.priceInr <= 0) {
    return err(400, 'The free plan is automatic — no Razorpay subscription needed');
  }

  // One active subscription per user. A user on Pro who upgrades to Creator
  // should cancel the old one first (the UI can offer that as a separate flow).
  const existing = await queryAll({
    collection: COLS.userSubscriptions,
    filters: [{ field: 'userId', value: userId }, { field: 'status', value: 'active' }],
    limit: 1,
  });
  if (existing.rows.length) {
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
  const subscription = await razorpay().subscriptions.create({
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
  if (!planId) return; // plan removed from dashboard — nothing to wire

  const periodStart = new Date(sub.current_start * 1000);
  const periodEnd = new Date(sub.current_end * 1000);

  await runTransaction(async (tx) => {
    const plan = await findByPk(COLS.subscriptionPlans, planId);
    const docId = `sub_${sub.id}`;
    const existing = await inTxGet(tx, COLS.userSubscriptions, docId);

    if (existing) {
      // Renewal — roll current_period_* forward on the same doc; status stays active.
      inTxSet(tx, COLS.userSubscriptions, docId, {
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        status: 'active',
        updatedAt: new Date(),
      });
      return;
    }

    inTxSet(tx, COLS.userSubscriptions, docId, {
      userId,
      planId,
      razorpaySubId: sub.id,
      status: 'active',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    if (plan?.priceInr) {
      await writeLedger(
        tx,
        {
          userId,
          type: 'subscription_payment',
          direction: 'debit',
          amountInr: plan.priceInr,
          refId: docId,
          note: `Subscription — ${plan.name} (₹${plan.priceInr}/month)`,
        },
      );
    }
  });
}

/**
 * Handle `subscription.cancelled` / `subscription.expired` webhooks.
 */
export async function deactivateSubscription(sub) {
  const rows = await queryAll({
    collection: COLS.userSubscriptions,
    filters: [{ field: 'razorpaySubId', value: sub.id }, { field: 'status', value: 'active' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 1,
  });
  const row = rows.rows[0];
  if (!row) return;
  await update(COLS.userSubscriptions, row.id, {
    status: sub.status === 'cancelled' ? 'cancelled' : 'expired',
    cancelledAt: new Date(),
    updatedAt: new Date(),
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
