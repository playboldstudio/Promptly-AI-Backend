import { COLS, findByPk, queryAll, inTxGet, inTxSet, update } from '../../db/firestoreRepo.js';
import { runTransaction } from '../../db/config.js';
import { verifySubscription, acknowledgePurchase } from '../../lib/playBilling.js';
import { writeLedger } from '../ledger.js';
import { planById, PRODUCT_TO_PLAN } from './plans.js';
import { currentActiveSubscriptionWithPlan } from './subscription-utils.js';

function err(status, message) {
  return { error: { status, message } };
}

/**
 * Activate a subscription from a Play Billing purchase token.
 *
 * Called from POST /payments/playbilling/verify when `isSubscription` is true.
 * Verifies the token, maps productId → plan (supports monthly + annual),
 * grants entitlements (including subscription perks like ad-free), then
 * acknowledges (acknowledging within 3 days prevents Google's auto-refund).
 */
export async function activateSubscriptionFromToken({ userId, productId, purchaseToken }) {
  // Map Play Billing productId → internal plan id.
  const planId = PRODUCT_TO_PLAN[productId] ?? productId;
  const plan = await planById(planId);
  if (!plan || !plan.isActive || !plan.priceInr || plan.priceInr <= 0) {
    return err(400, 'Unknown subscription plan');
  }

  const purchase = await verifySubscription({ purchaseToken });
  // purchaseState 0 = PURCHASED / active.
  if (!purchase || Number(purchase.purchaseState) !== 0) {
    return err(400, 'Subscription is not active');
  }

  const docId = `sub_${purchaseToken}`;
  const periodStart = new Date(Number(purchase.startTimeMillis) || Date.now());
  const periodEnd = new Date(Number(purchase.expiryTimeMillis) || Date.now() + MONTH_MS);

  // Determine the billing description (monthly vs annual).
  const billingLabel = plan.billingCycle === 'annual' ? 'year' : 'month';

  await runTransaction(async (tx) => {
    const existing = await inTxGet(tx, COLS.userSubscriptions, docId);
    const prevBalance = Number((await inTxGet(tx, COLS.userBalances, userId))?.balanceInr ?? 0);

    if (existing) {
      // Same token re-granted (renewal / retry) — roll the period forward.
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
      planId: plan.id,
      gateway: 'play_billing',
      gatewaySubscriptionId: purchaseToken,
      status: 'active',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Grant subscription perks — e.g. Pro/Creator include ad-free.
    if (plan.perks?.includes('ad_free')) {
      const user = await inTxGet(tx, COLS.users, userId);
      if (user && !user.adFree) {
        inTxSet(tx, COLS.users, userId, { adFree: true, updatedAt: new Date() });
      }
    }

    if (plan.priceInr) {
      await writeLedger(
        tx,
        {
          userId,
          type: 'subscription_payment',
          direction: 'debit',
          amountInr: plan.priceInr,
          note: `Subscription — ${plan.name} (₹${plan.priceInr}/${billingLabel})`,
          balanceInr: prevBalance,
        },
      );
    }
  });

  await acknowledgePurchase({ productId: plan.id, purchaseToken, isSubscription: true }).catch(() => {});

  return {
    success: true,
    planId: plan.id,
    planName: plan.name,
    priceInr: plan.priceInr,
    billingCycle: plan.billingCycle,
    perks: plan.perks ?? [],
    subscriptionId: docId,
    currentPeriodEnd: periodEnd.toISOString(),
  };
}

/**
 * Cancel the caller's active subscription.
 *
 * Play Billing has no server-side "cancel" call for a token; cancellation is
 * user-initiated in the Play Store. So this marks the local row cancelled —
 * the already-paid current period keeps benefits until expiry, and
 * SUBSCRIPTION_CANCELED from RTDN will confirm the state change.
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

  // Informational hint: the user must also cancel in the Play Store so
  // auto-renewals stop. RTDN will surface the actual state.
  await update(COLS.userSubscriptions, row.id, {
    status: 'cancelled',
    cancelledAt: new Date(),
    updatedAt: new Date(),
  });

  return {
    success: true,
    subscriptionId: row.id,
    planId: row.planId,
    cancelledAt: new Date().toISOString(),
    note: 'Also cancel in the Play Store (Subscriptions) to stop renewals',
  };
}

/**
 * RTDN lifecycle events — extend / expire / cancel a subscription from
 * Google's push notification (SUBSCRIPTION_RENEWED / EXPIRED / CANCELED).
 */
export async function handleRTDNSubscription({ purchaseToken, eventType }) {
  const docId = `sub_${purchaseToken}`;
  const existing = await findByPk(COLS.userSubscriptions, docId);
  if (!existing) return; // unknown token — ignore

  if (eventType === 'SUBSCRIPTION_RENEWED' || eventType === 'SUBSCRIPTION_RESTARTED') {
    const details = await verifySubscription({ purchaseToken }).catch(() => null);
    await update(COLS.userSubscriptions, docId, {
      status: 'active',
      currentPeriodEnd: details
        ? new Date(Number(details.expiryTimeMillis)).toISOString()
        : new Date(Date.now() + MONTH_MS).toISOString(),
      updatedAt: new Date(),
    });
  } else if (eventType === 'SUBSCRIPTION_EXPIRED') {
    await update(COLS.userSubscriptions, docId, {
      status: 'expired',
      updatedAt: new Date(),
    });
  } else if (eventType === 'SUBSCRIPTION_CANCELED') {
    await update(COLS.userSubscriptions, docId, {
      status: 'cancelled',
      cancelledAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;