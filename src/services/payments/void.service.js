import { COLS, findByPk, inTxGet, inTxSet, inTxAdd } from '../../db/firestoreRepo.js';
import { runTransaction } from '../../db/config.js';
import { getOneTimeProduct, isDepositProduct } from './products.js';
import { refundDepositTx } from '../wallet.service.js';

/**
 * Refund / void handling — Phase 1 ★ (plans/play-billing.md §7).
 *
 * A buyer can get a Play refund (up to ~48h) or Google can void a purchase.
 * Without a handler the creator's wallet `earnings` phantom-credits — a real
 * money hole. This module reverses each grant type:
 *
 *   prompt purchase  → void the `prompt_purchases` row (status: 'voided'),
 *                      then DEBIT the creator's wallet `earnings` back —
 *                      capped at their un-withdrawn earnings for that item
 *                      (never overdraw the bank; a residual becomes a
 *                      negative float against future earnings).
 *   deposit top-up   → refund the NET from `deposits` and remove the recycled
 *                      bonus vintage (see wallet.md §4.6 / refundDeposit).
 *   ad-free          → unset `users.adFree` ONLY if it was bought as one-time
 *                      (not a subscription perk) — otherwise keep the perk.
 *   subscription     → mark the row cancelled/expired + drop entitlements;
 *                      Play itself issues the refund, no wallet move here.
 *
 * Void is only valid when the purchase token matches a stored, non-voided
 * grant. On a refund the 5% buyer transaction fee is returned with it (the
 * buyer paid `buyerPaysInr`; the app's gross income shrinks accordingly) —
 * this is a bookkeeping note, not a wallet credit.
 */

function err(status, message) {
  return { error: { status, message } };
}

/** Money precision: rupees with paise — never more than 2 decimals. */
function toMoney(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Look up a stored one-time grant by (userId, productId). Returns null when
 * absent. Callers check `status === 'voided'` themselves (a not-voided row is
 * the voidable precondition).
 */
async function findOneTimeGrant({ userId, productId }) {
  const docId = `${userId}_${productId}`;
  return findByPk(COLS.promptPurchases, docId);
}

/**
 * Void a paid prompt unlock.
 *
 * Creator reversal is capped at their CURRENT un-withdrawn `earnings` — we
 * never drive the wallet to a negative cash position. If the creator already
 * cashed out that sale, the leftover is tracked as an OWED balance (ledger
 * note, `refId` = purchase id) to be recovered from future sales — a negative
 * float, not a bank overdraw.
 */
async function voidPromptPurchase({ userId, purchaseToken, productId, reason }) {
  const promptId = productId.slice('prompt_'.length);

  // 1. Only a stored, non-voided grant is voidable.
  const grant = await findOneTimeGrant({ userId, productId });
  if (!grant) return err(404, 'No prompt purchase found to void');
  if (grant.gatewayOrderToken !== purchaseToken) {
    return err(409, 'Purchase token mismatch — cannot void this prompt');
  }
  if (grant.status === 'voided') {
    return err(409, 'This prompt purchase is already voided');
  }

  const authorId = grant.authorId;
  const salesPrice = Number(grant.priceInr) || 0;
  const buyerPays = Number(grant.buyerPaysInr) || 0;

  try {
    await runTransaction(async (tx) => {
      const fresh = await inTxGet(tx, COLS.promptPurchases, `${userId}_${productId}`);
      if (fresh?.status === 'voided') {
        throw Object.assign(new Error('already-voided'), { alreadyVoided: true });
      }

      // 2. Void the row.
      inTxSet(tx, COLS.promptPurchases, `${userId}_${productId}`, {
        status: 'voided',
        voidedAt: new Date(),
        voidReason: reason ?? 'refund',
        updatedAt: new Date(),
      });

      // 3. Debit the creator's earnings back — capped at current un-withdrawn
      //    earnings so we never drive the wallet negative.
      if (authorId && salesPrice > 0) {
        const wallet = (await inTxGet(tx, COLS.userWallets, authorId)) ?? {
          earnings: 0,
          deposits: 0,
          bonus: 0,
          bonusVintages: {},
        };
        const currentEarnings = Math.max(0, Number(wallet.earnings ?? 0));
        const debit = Math.min(salesPrice, currentEarnings);
        const residual = toMoney(salesPrice - debit); // owed float if they cashed out

        if (debit > 0) {
          const newEarnings = toMoney(currentEarnings - debit);
          inTxSet(tx, COLS.userWallets, authorId, { earnings: newEarnings, updatedAt: new Date() });
          inTxAdd(tx, COLS.transactions, {
            userId: authorId,
            type: 'purchase_void',
            direction: 'debit',
            amountInr: debit,
            balanceType: 'earnings',
            balanceAfterInr: newEarnings,
            refId: `${userId}_${productId}`,
            note: `Refund of "${grant.promptId ?? productId}" — ${debit} debited from earnings`,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }

        if (residual > 0) {
          // Owed float — tracked for recovery from future sales, never overdraw.
          inTxAdd(tx, COLS.transactions, {
            userId: authorId,
            type: 'purchase_void_shortfall',
            direction: 'debit',
            amountInr: residual,
            balanceType: 'earnings',
            balanceAfterInr: currentEarnings, // unchanged — cap applied
            refId: `${userId}_${productId}`,
            note: `Settled earnings covered only ${debit} of the ${salesPrice} refund — ${residual} recovers from future sales`,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }

      // 4. Buyer ledger — refund note (the +5% buyer transaction fee was app
      //    income; refunding the sale shrinks app gross by buyerPays).
      inTxAdd(tx, COLS.transactions, {
        userId,
        type: 'purchase_void',
        direction: 'credit', // refund to buyer bookkeeping (not a wallet credit)
        amountInr: buyerPays,
        balanceType: 'deposits',
        balanceAfterInr: null,
        refId: `${userId}_${productId}`,
        note: `Refund of prompt — ${buyerPays} (price + 5% transaction fee) returned`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    return { success: true, type: 'prompt', promptId, voided: true, refundedInr: buyerPays };
  } catch (e) {
    if (e.alreadyVoided) return err(409, 'This prompt purchase is already voided');
    throw e;
  }
}

/**
 * Void a deposit top-up.
 *
 * Reverses the wallet split atomically (one transaction): mark the purchase
 * voided, debit the NET out of `deposits`, and remove the recycled bonus
 * vintage (wallet.md §4.6). If the user already spent the deposit, the debit
 * can leave `deposits` negative — a marked owed balance (blocking further
 * deposit-spend until recovered; plans/wallet.md §9).
 */
async function voidDeposit({ userId, productId, purchaseToken, reason }) {
  const product = getOneTimeProduct(productId);
  if (!product || product.type !== 'consumable') {
    return err(400, 'Not a deposit product');
  }
  const grant = await findOneTimeGrant({ userId, productId });
  if (!grant) return err(404, 'No deposit top-up found to void');
  if (grant.gatewayOrderToken !== purchaseToken) {
    return err(409, 'Purchase token mismatch — cannot void this top-up');
  }
  if (grant.status === 'voided') {
    return err(409, 'This deposit top-up is already voided');
  }

  const netDeposit = Number(grant.priceInr) - (Number(grant.gatewayFeeInr) || 0);
  const vintageId = `${userId}_${productId}`; // matches creditDepositTopUpTx's creditId

  try {
    const refund = await runTransaction(async (tx) => {
      const fresh = await inTxGet(tx, COLS.promptPurchases, `${userId}_${productId}`);
      if (fresh?.status === 'voided') {
        throw Object.assign(new Error('already-voided'), { alreadyVoided: true });
      }
      inTxSet(tx, COLS.promptPurchases, `${userId}_${productId}`, {
        status: 'voided',
        voidedAt: new Date(),
        voidReason: reason ?? 'refund',
        updatedAt: new Date(),
      });

      // Atomically: mark voided + refund the net + remove the bonus vintage.
      return refundDepositTx(tx, {
        userId,
        netDeposit,
        vintageId,
        refId: `${userId}_${productId}`,
        note: `Refunded deposit ${product.name} — net ${netDeposit} removed`,
      });
    });

    return {
      success: true,
      type: 'deposit',
      productId,
      refundedNetInr: netDeposit,
      depositsNegative: refund.depositsNegative,
    };
  } catch (e) {
    if (e.alreadyVoided) return err(409, 'This deposit top-up is already voided');
    throw e;
  }
}

/**
 * Void a one-time ad-free grant.
 *
 * Revokes `users.adFree` only when it was purchased explicitly (not when it
 * comes from a subscription perk — Pro/Creator keep ad-free via the sub).
 */
async function voidAdFree({ userId, purchaseToken, reason }) {
  const grant = await findOneTimeGrant({ userId, productId: 'ad_free' });
  if (!grant) return err(404, 'No ad-free purchase found to void');
  if (grant.gatewayOrderToken !== purchaseToken) {
    return err(409, 'Purchase token mismatch — cannot void ad-free');
  }
  if (grant.status === 'voided') {
    return err(409, 'This ad-free purchase is already voided');
  }

  // A purchased ad-free is non-consumable — one grant per user. Only revoke if
  // the user has no active Pro/Creator sub carrying the ad-free perk.
  const { currentActiveSubscriptionWithPlan } = await import('./subscription-utils.js');
  const sub = await currentActiveSubscriptionWithPlan(userId);
  const perkActive = sub?.plan?.perks?.includes('ad_free') === true;

  await runTransaction(async (tx) => {
    const fresh = await inTxGet(tx, COLS.promptPurchases, `${userId}_ad_free`);
    if (fresh?.status === 'voided') {
      throw Object.assign(new Error('already-voided'), { alreadyVoided: true });
    }
    inTxSet(tx, COLS.promptPurchases, `${userId}_ad_free`, {
      status: 'voided',
      voidedAt: new Date(),
      voidReason: reason ?? 'refund',
      updatedAt: new Date(),
    });

    // Revoke only if the ad-free isn't coming from a subscription perk.
    if (!perkActive && !fresh?.voidedAt) {
      const user = await inTxGet(tx, COLS.users, userId);
      if (user?.adFree) {
        inTxSet(tx, COLS.users, userId, { adFree: false, updatedAt: new Date() });
      }
    }
  });

  return {
    success: true,
    type: 'ad_free',
    adFreeRevoked: !perkActive,
    perkRetained: perkActive,
  };
}

/**
 * Void an active subscription (refund).
 *
 * Play itself issues the refund; this marks the local row cancelled and drops
 * the entitlement (the already-paid current period benefits end immediately on
 * a void — the period was unused). No wallet money moves here (no deposit/earnings).
 */
async function voidSubscription({ purchaseToken, reason }) {
  const docId = `sub_${purchaseToken}`;
  const sub = await findByPk(COLS.userSubscriptions, docId);
  if (!sub) return err(404, 'No subscription found to void');
  if (sub.status === 'voided' || sub.status === 'expired') {
    return err(409, 'This subscription is already voided/expired');
  }

  await runTransaction(async (tx) => {
    const fresh = await inTxGet(tx, COLS.userSubscriptions, docId);
    if (!fresh || fresh.status === 'voided' || fresh.status === 'expired') {
      throw Object.assign(new Error('already-voided'), { alreadyVoided: true });
    }
    inTxSet(tx, COLS.userSubscriptions, docId, {
      status: 'voided',
      cancelledAt: new Date(),
      voidReason: reason ?? 'refund',
      updatedAt: new Date(),
    });
  });

  return { success: true, type: 'subscription', subscriptionId: docId, voided: true };
}

/**
 * POST /payments/playbilling/void — dispatch a refund/void by productId.
 *
 *   - prompt_<id>    → voidPromptPurchase (creator earnings revoke)
 *   - deposit_*      → voidDeposit (net debit + bonus vintage removed)
 *   - ad_free        → voidAdFree (revoke unless subscription-perk)
 *   - pro/pro_annual/creator/creator_annual (isSubscription) → voidSubscription
 */
export async function voidOneTimePurchase({ userId, productId, purchaseToken, reason }) {
  if (!productId) return err(400, 'Missing productId');

  if (productId.startsWith('prompt_')) {
    return voidPromptPurchase({ userId, productId, purchaseToken, reason });
  }
  if (isDepositProduct(productId)) {
    return voidDeposit({ userId, productId, purchaseToken, reason });
  }
  if (productId === 'ad_free') {
    return voidAdFree({ userId, productId, purchaseToken, reason });
  }
  return err(400, 'Unknown productId for void');
}

export async function voidSubscriptionPurchase({ purchaseToken, reason }) {
  return voidSubscription({ purchaseToken, reason });
}