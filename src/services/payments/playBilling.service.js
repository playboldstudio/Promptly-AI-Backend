import { COLS, findByPk, inTxGet, inTxSet } from '../../db/firestoreRepo.js';
import { runTransaction } from '../../db/config.js';
import { verifyOneTimePurchase, acknowledgePurchaseWithRetry, consumePurchase, calculatePlayBillingFee, safeVerify } from '../../lib/playBilling.js';
import { isAdminEmail } from '../../config/env.js';
import { getOneTimeProduct } from './products.js';
import { playConsoleProductId } from './playConsoleIds.js';
import { creditDepositTopUpTx } from '../wallet.service.js';
import { notify } from '../notify.js';

/** Money precision: rupees with paise — never more than 2 decimals. */
function toMoney(value) {
  return Math.round(value * 100) / 100;
}

function err(status, message) {
  return { error: { status, message } };
}

/**
 * A short, deterministic suffix from a purchase token — used to make a deposit
 * purchase row id unique per purchase (fix: repeat top-ups of the same pack no
 * longer collide at `{userId}_{productId}` — see PAYMENT_API_AUDIT_REPORT §1.3).
 */
function tokenSuffix(token) {
  if (!token) return Date.now().toString(36);
  return Buffer.from(String(token)).toString('hex').slice(-12);
}

/**
 * Per-purchase deposit row id. `{userId}_{productId}` alone overwrote the prior
 * purchase on a repeat top-up (history lost + refunds blocked); the token suffix
 * makes each purchase its own row while staying deterministic for idempotency.
 */
export function depositRowIdFor(userId, productId, purchaseToken) {
  return `${userId}_${productId}_${tokenSuffix(purchaseToken)}`;
}

/* ── Ad-free (one-time, non-consumable) ──────────────────────────────────── */

const AD_FREE_DOC_ID = 'ad_free'; // deterministic — one per user

/**
 * Grant ad-free access from a verified Play Billing one-time purchase
 * (product `ad_free`). Sets `users.adFree = true` and records the purchase
 * for idempotency. The purchase token is stored for potential void/refund.
 */
export async function grantAdFree({ userId, purchaseToken }) {
  const user = await findByPk(COLS.users, userId);
  if (!user) return err(404, 'User not found');

  // Admins always have full access — ad-free is redundant.
  if (isAdminEmail(user.email)) {
    return err(409, 'Admins already have full access — ad-free is included');
  }

  // Already granted — idempotent no-op.
  if (user.adFree) {
    return err(409, 'You already have ad-free access');
  }

  // Verify the purchase token with Google BEFORE granting. The Google API uses
  // the real Play Console id for the ad-free SKU; internal storage uses `ad_free`.
  const consoleId = playConsoleProductId('ad_free');
  const { data: purchase, error: verifyErr } = await safeVerify(() =>
    verifyOneTimePurchase({ productId: consoleId, purchaseToken }),
  );
  if (verifyErr) return err(verifyErr.status, verifyErr.message);
  if (!purchase || Number(purchase.purchaseState) !== 0) {
    return err(400, 'Purchase not completed');
  }

  const gateway = calculatePlayBillingFee({ salePriceInr: 149 });

  try {
    await runTransaction(async (tx) => {
      // Idempotent: skip if someone else completed concurrently.
      const fresh = await inTxGet(tx, COLS.users, userId);
      if (fresh?.adFree) throw Object.assign(new Error('already-granted'), { alreadyGranted: true });

      // Mark user as ad-free with audit fields.
      inTxSet(tx, COLS.users, userId, {
        adFree: true,
        adFreePurchasedAt: new Date(),
        adFreeSku: 'ad_free',
        updatedAt: new Date(),
      });

      // Record the purchase (deterministic id = userId_ad_free).
      inTxSet(tx, COLS.promptPurchases, `${userId}_${AD_FREE_DOC_ID}`, {
        buyerId: userId,
        promptId: AD_FREE_DOC_ID,
        authorId: null,
        priceInr: 149,
        buyerPaysInr: 149,
        transactionFeeInr: 0,
        gateway: 'play_billing',
        gatewayOrderToken: purchaseToken,
        gatewayFeeInr: gateway.feeInr,
        gatewayFeePercent: gateway.feePercent,
        gatewayFeeSource: 'calculated',
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    // Acknowledge AFTER successful grant — prevents Google's 3-day auto-refund.
    await acknowledgePurchaseWithRetry({ productId: consoleId, purchaseToken }).catch(() => {});

    notify({
      userId,
      type: 'ad_free',
      title: 'Ad-free activated',
      body: 'Ads are now removed — enjoy Promptly without interruptions.',
      refId: `${userId}_ad_free`,
      dedupeKey: `${userId}_ad_free`,
    });

    return { success: true, adFree: true, priceInr: 149 };
  } catch (e) {
    if (e.alreadyGranted) return err(409, 'You already have ad-free access');
    if (/ABORTED|already exists/i.test(e.message)) return err(409, 'You already have ad-free access');
    throw e;
  }
}

/* ── Deposit top-up (one-time, consumable) ────────────────────────────────── */

/**
 * Handle a deposit pack top-up from a verified Play Billing purchase.
 *
 * Money model (pricing.md §4 / wallet.md §4.5):
 *  - Buyer pays the full SKU price (e.g. ₹100 for deposit_m)
 *  - Google takes ~15% commission (Play Billing fee)
 *  - Net goes to the wallet's `deposits` (user's own money)
 *  - The gateway fee is recycled as `bonus` (90-day vintage, FEFO spend)
 */
export async function handleDepositTopUp({ userId, productId, purchaseToken }) {
  const product = getOneTimeProduct(productId);
  if (!product || product.type !== 'consumable') {
    return err(400, 'Not a deposit product');
  }

  // Google API uses the real Play Console id; internal dispatch uses `deposit_*`.
  const consoleId = playConsoleProductId(productId);

  // Verify the purchase token with Google BEFORE crediting.
  const { data: purchase, error: verifyErr } = await safeVerify(() =>
    verifyOneTimePurchase({ productId: consoleId, purchaseToken }),
  );
  if (verifyErr) return err(verifyErr.status, verifyErr.message);
  if (!purchase || Number(purchase.purchaseState) !== 0) {
    return err(400, 'Purchase not completed');
  }

  const priceInr = product.priceInr;
  const gateway = calculatePlayBillingFee({ salePriceInr: priceInr });
  const gatewayFeeInr = gateway.feeInr;
  const netDeposit = priceInr - gatewayFeeInr;
  // Per-purchase row id (token-suffixed) — repeat top-ups of the same pack no
  // longer overwrite the prior purchase (audit §1.3: history + refunds broke).
  const purchaseRowId = depositRowIdFor(userId, productId, purchaseToken);

  try {
    // Consumables MUST be consumed after purchase, or the NEXT purchase of the
    // same SKU fails with ITEM_ALREADY_OWNED. Consume before the idempotency
    // transaction (single Google call, never inside the Firestore tx).
    await consumePurchase({ productId: consoleId, purchaseToken }).catch((err) => {
      const code = err?.code ?? err?.status;
      const isOwned = /already.?owned|ITEM_ALREADY_OWNED|consumptionState/i.test(err?.message ?? String(code));
      if (!isOwned) {
        // Non-"already owned" consume failures shouldn't block a verified top-up.
        console.error('deposit consume failed (non-ITEM_ALREADY_OWNED):', err?.message ?? err);
      }
    });

    await runTransaction(async (tx) => {
      // Idempotent: check for an existing completed purchase with this token.
      const existingPurchase = await inTxGet(tx, COLS.promptPurchases, purchaseRowId);
      if (existingPurchase?.gatewayOrderToken === purchaseToken) {
        throw Object.assign(new Error('already-processed'), { alreadyProcessed: true });
      }

      // NOTE: Firestore transactions require ALL reads BEFORE any write in the
      // transaction. `creditDepositTopUpTx` must not read the user's wallet
      // after the write below — so pre-read the wallet first, then record the
      // purchase row, then credit the wallet with the pre-read doc.
      const walletDoc = await inTxGet(tx, COLS.userWallets, userId); // read BEFORE writes

      // Record the purchase row.
      inTxSet(tx, COLS.promptPurchases, purchaseRowId, {
        buyerId: userId,
        promptId: productId,
        authorId: null,
        priceInr,
        buyerPaysInr: priceInr,
        transactionFeeInr: 0,
        gateway: 'play_billing',
        gatewayOrderToken: purchaseToken,
        gatewayFeeInr,
        gatewayFeePercent: gateway.feePercent,
        gatewayFeeSource: 'calculated',
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Credit the wallet: NET → deposits, gateway fee → bonus vintage.
      // (The gateway fee is the platform's cost, recycled as retention credit.)
      // The vintage's creditId IS this purchase row id — per-purchase, so a
      // refund of one deposit no longer wipes a whole pooled pack.
      creditDepositTopUpTx(tx, {
        userId,
        priceInr,
        gatewayFeeInr,
        refId: purchaseRowId,
        note: `Top-up ${product.name} — net ${netDeposit} after ${gatewayFeeInr} gateway fee`,
        walletDoc, // pre-read wallet — no read-after-write
      });
    });

    // Acknowledge AFTER successful grant — prevents Google's 3-day auto-refund.
    await acknowledgePurchaseWithRetry({ productId: consoleId, purchaseToken }).catch(() => {});

    // Inbox notification for the buyer (deduped by this purchase row).
    notify({
      userId,
      type: 'deposit_credit',
      title: 'Top-up successful',
      body: `₹${priceInr} added to your wallet (₹${netDeposit} deposit + ₹${gatewayFeeInr} bonus)`,
      refId: purchaseRowId,
      dedupeKey: purchaseRowId,
      data: { productId, priceInr, netDeposit, giftDepositInr: gatewayFeeInr },
    });

    return {
      success: true,
      productId,
      priceInr,
      gatewayFeeInr,
      netDeposit,
    };
  } catch (e) {
    if (e.alreadyProcessed) {
      return { success: true, productId, priceInr, gatewayFeeInr, netDeposit, note: 'Already processed' };
    }
    if (/ABORTED|already exists/i.test(e.message)) {
      return { success: true, productId, priceInr, gatewayFeeInr, netDeposit, note: 'Already processed' };
    }
    throw e;
  }
}