import { COLS, queryAll, inTxGet, inTxSet, update } from '../../db/firestoreRepo.js';
import { runTransaction } from '../../db/config.js';
import { razorpay } from '../../lib/razorpay.js';
import { razorpayPlanIdFor } from '../../config/env.js';
import { writeLedger } from '../ledger.js';
import { planById } from './plans.js';
import { currentActiveSubscriptionWithPlan } from './subscription-utils.js';

const PERIOD_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function err(status, message) {
  return { error: { status, message } };
}

export async function createSubscription({ userId, planId, customerDetails }) {
  const plan = await planById(planId);
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
 * Cancel the caller's active subscription: stop renewals at Razorpay and mark
 * the local row cancelled. The already-paid current period runs to its end —
 * benefits (Pro/Creator) stay until the period expires. Admins get a 409 —
 * their Creator access is permanent, there is nothing to cancel.
 */
export async function cancelActiveSubscription(userId) {
  const sub = await currentActiveSubscriptionWithPlan(userId);
  if (sub?.adminPerk) {
    return err(409, 'Admins always have Creator access — there is no subscription to cancel');
  }

  const { rows } = await queryAll({
    collection: COLS.userSubscriptions,
    filters: [{ field: 'userId', value: userId }, { field: 'status', value: 'active' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 1,
  });
  const row = rows[0];
  if (!row) return err(404, 'No active subscription to cancel');

  if (row.razorpaySubId) {
    try {
      await razorpay().subscriptions.cancel(row.razorpaySubId, false);
    } catch (e) {
      // Already cancelled/expired at Razorpay is fine — just sync locally.
      if (!/already|cancelled|expired|subscription/i.test(e?.message ?? '')) {
        return err(502, 'Could not cancel the subscription at Razorpay — try again');
      }
    }
  }

  await update(COLS.userSubscriptions, row.id, {
    status: 'cancelled',
    cancelledAt: new Date(),
    updatedAt: new Date(),
  });

  return {
    success: true,
    subscriptionId: row.razorpaySubId,
    planId: row.planId,
    cancelledAt: new Date().toISOString(),
  };
}

export async function activateSubscription(sub) {
  const userId = sub.notes?.userId;
  if (!userId) return; // seeded/historical subs without notes — nothing to wire

  const planId = planIdFromRazorpayPlan(sub.plan_id);
  if (!planId) return; // plan removed from dashboard — nothing to wire

  const periodStart = new Date(sub.current_start * 1000);
  const periodEnd = new Date(sub.current_end * 1000);

  await runTransaction(async (tx) => {
    const plan = await planById(planId);
    const docId = `sub_${sub.id}`;
    const existing = await inTxGet(tx, COLS.userSubscriptions, docId);
    // Pre-read the balance BEFORE any write — Firestore transactions cannot read
    // after a write (writeLedger below only writes when given the balance).
    const prevBalance = Number((await inTxGet(tx, COLS.userBalances, userId))?.balanceInr ?? 0);

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
          balanceInr: prevBalance,
        },
      );
    }
  });
}

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

function planIdFromRazorpayPlan(rzpPlanId) {
  if (!rzpPlanId) return null;
  for (const ours of ['pro', 'creator']) {
    if (razorpayPlanIdFor(ours) === rzpPlanId) return ours;
  }
  return null;
}
