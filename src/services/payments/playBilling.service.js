import { COLS, findByPk, inTxGet, inTxSet } from '../../db/firestoreRepo.js';
import { runTransaction } from '../../db/config.js';
import { verifyOneTimePurchase, acknowledgePurchase, calculatePlayBillingFee } from '../../lib/playBilling.js';
import { writeLedger } from '../ledger.js';
import { isAdminEmail } from '../../config/env.js';
import { getOneTimeProduct } from './products.js';
import { currentActiveSubscriptionWithPlan } from './subscription-utils.js';
import { creditDepositTopUpTx } from '../wallet.service.js';

/** Money precision: rupees with paise — never more than 2 decimals. */
function toMoney(value) {
  return Math.round(value * 100) / 100;
}

function err(status, message) {
  return { error: { status, message } };
}

function purchaseIdFor(buyerId, promptId) {
  return `${buyerId}_${promptId}`;
}

/**
 * Grant a paid prompt unlock from a verified Play Billing one-time purchase
 * token (product `prompt_<id>`).
 *
 * Money model (see plans/pricing.md + plans/withdrawals.md):
 *  - Buyer pays price + 5% transaction fee (app income — not credited anywhere)
 *  - Creator's `earnings` is credited the FULL gross price at sale
 *  - Play Billing's ~15% commission is stored as gatewayFeeInr for
 *    reconciliation only — it is NEVER deducted at withdrawal
 *  - The 15%/5% withdrawal fee is applied later, when the creator initiates a
 *    payout (payouts.service.js)
 */
export async function grantPromptUnlock({ buyerId, productId, purchaseToken }) {
  if (!productId || !productId.startsWith('prompt_')) {
    return err(400, 'Unknown product');
  }
  const promptId = productId.slice('prompt_'.length);
  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt || prompt.status !== 'published') {
    return err(404, 'Prompt not found');
  }
  if (!prompt.isPaid || !prompt.priceInr) {
    return err(400, 'This prompt is free — nothing to pay');
  }

  // Admins have full access to every prompt — they never pay.
  const buyer = await findByPk(COLS.users, buyerId);
  if (buyer && isAdminEmail(buyer.email)) {
    return err(409, 'You have full admin access — this prompt is already unlocked');
  }

  // One unlock per buyer per prompt — reject if already purchased.
  const purchaseId = purchaseIdFor(buyerId, promptId);
  const existing = await findByPk(COLS.promptPurchases, purchaseId);
  if (existing) {
    return err(409, 'You already own this prompt');
  }

  // Verify the purchase token with Google BEFORE granting (never trust the client).
  const purchase = await verifyOneTimePurchase({ productId, purchaseToken });
  if (!purchase || Number(purchase.purchaseState) !== 0) {
    return err(400, 'Purchase not completed');
  }

  const priceInr = Number(prompt.priceInr);
  const buyerPaysInr = toMoney(priceInr * 1.05);            // + 5% transaction fee
  const transactionFeeInr = toMoney(buyerPaysInr - priceInr);
  const gateway = calculatePlayBillingFee({ salePriceInr: priceInr });

  try {
    // Snapshot the seller's withdrawal-fee (platform) percent so the purchase
    // row is self-contained for reconciliation. Derives from the seller's active
    // plan (Pro 15% / Creator 5%); defaults to the Creator rate when no plan.
    const authorSub = await currentActiveSubscriptionWithPlan(prompt.authorId);
    const authorFeePercent = authorSub?.plan?.platformFeePercent ?? 5;
    // The fee-in-total snapshot shown on the purchase row (gross net after the
    // seller's platform fee — informational; the fee is truly applied at payout).
    const netInr = toMoney(priceInr - toMoney((priceInr * authorFeePercent) / 100));

    await runTransaction(async (tx) => {
      const already = await inTxGet(tx, COLS.promptPurchases, purchaseId);
      if (already) throw Object.assign(new Error('already-owns'), { alreadyOwns: true });

      // Pre-read the buyer's balance BEFORE any write. Firestore transactions
      // cannot read after a write; writeLedger writes the user_balances doc.
      const buyerBalance = await inTxGet(tx, COLS.userBalances, buyerId);
      const buyerPrev = Number(buyerBalance?.balanceInr ?? 0);

      // The purchase row (deterministic id guarantees one-per-buyer-per-prompt).
      inTxSet(tx, COLS.promptPurchases, purchaseId, {
        buyerId,
        promptId,
        authorId: prompt.authorId ?? null,
        priceInr,
        buyerPaysInr,
        transactionFeeInr,
        platformFeePercent: authorFeePercent,
        netInr,
        gateway: 'play_billing',
        gatewayOrderToken: purchaseToken,
        gatewayFeeInr: gateway.feeInr,
        gatewayFeePercent: gateway.feePercent,
        gatewayFeeSource: 'calculated',
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Creator earnings are a wallet balance (Phase 2) — credit the FULL gross
      // price to the seller's `earnings`. The withdrawal fee (15%/5%) is applied
      // at payout, never here, and the Play Billing commission was absorbed by
      // the platform at payment time (tracked on the row for reconciliation).
      if (prompt.authorId) {
        const authorWallet = (await inTxGet(tx, COLS.userWallets, prompt.authorId)) ?? {
          earnings: 0,
          deposits: 0,
          bonus: 0,
          bonusVintages: {},
        };
        const newEarnings = toMoney(Number(authorWallet.earnings ?? 0) + priceInr);
        inTxSet(tx, COLS.userWallets, prompt.authorId, {
          earnings: newEarnings,
          updatedAt: new Date(),
        });
        inTxAdd(tx, COLS.transactions, {
          userId: prompt.authorId,
          type: 'paid_prompt_sale',
          direction: 'credit',
          amountInr: priceInr,
          balanceType: 'earnings',
          balanceAfterInr: newEarnings,
          refId: purchaseId,
          note: `Sale of "${prompt.title}" — gross ${priceInr} (withdrawal fee at payout)`,
          gateway: 'play_billing',
          gatewayFeeInr: gateway.feeInr,
          platformFeeInr: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Ledger — debit the buyer by the full amount paid (gross + 5% fee).
      await writeLedger(
        tx,
        {
          userId: buyerId,
          type: 'paid_prompt_sale',
          direction: 'debit',
          amountInr: buyerPaysInr,
          refId: purchaseId,
          note: `Unlocked "${prompt.title}"`,
          balanceInr: buyerPrev,
        },
      );
    });

    // Acknowledge AFTER a successful grant — prevents Google's 3-day auto-refund.
    await acknowledgePurchase({ productId, purchaseToken, isSubscription: false }).catch(() => {});

    return {
      success: true,
      unlocked: true,
      promptId,
      purchaseId,
      buyerPaysInr,
      transactionFeeInr,
    };
  } catch (err) {
    if (err.alreadyOwns) return err(409, 'You already own this prompt');
    if (/ABORTED|already exists/i.test(err.message)) return err(409, 'You already own this prompt');
    throw err;
  }
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

  // Verify the purchase token with Google BEFORE granting.
  const purchase = await verifyOneTimePurchase({ productId: 'ad_free', purchaseToken });
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
    await acknowledgePurchase({ productId: 'ad_free', purchaseToken }).catch(() => {});

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

  // Verify the purchase token with Google BEFORE crediting.
  const purchase = await verifyOneTimePurchase({ productId, purchaseToken });
  if (!purchase || Number(purchase.purchaseState) !== 0) {
    return err(400, 'Purchase not completed');
  }

  const priceInr = product.priceInr;
  const gateway = calculatePlayBillingFee({ salePriceInr: priceInr });
  const gatewayFeeInr = gateway.feeInr;
  const netDeposit = priceInr - gatewayFeeInr;
  const purchaseRowId = `${userId}_${productId}`;

  try {
    await runTransaction(async (tx) => {
      // Idempotent: check for an existing completed purchase with this token.
      const existingPurchase = await inTxGet(tx, COLS.promptPurchases, purchaseRowId);
      if (existingPurchase?.gatewayOrderToken === purchaseToken) {
        throw Object.assign(new Error('already-processed'), { alreadyProcessed: true });
      }

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
      creditDepositTopUpTx(tx, {
        userId,
        priceInr,
        gatewayFeeInr,
        refId: purchaseRowId,
        note: `Top-up ${product.name} — net ${netDeposit} after ${gatewayFeeInr} gateway fee`,
      });
    });

    // Acknowledge AFTER successful grant — prevents Google's 3-day auto-refund.
    await acknowledgePurchase({ productId, purchaseToken }).catch(() => {});

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