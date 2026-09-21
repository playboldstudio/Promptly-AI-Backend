import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { isAdminEmail } from '../config/env.js';
import {
  requestPayout,
  listPayouts,
  listUserPayouts,
  withdrawalEligibility,
  markPayoutPaid,
  markPayoutFailed,
} from '../services/payments/payouts.service.js';
import { grantAdFree, handleDepositTopUp } from '../services/payments/playBilling.service.js';
import { voidOneTimePurchase, voidSubscriptionPurchase } from '../services/payments/void.service.js';
import { activateSubscriptionFromToken, cancelActiveSubscription } from '../services/payments/subscriptions.service.js';
import { isDepositProduct, isAdFreeProduct } from '../services/payments/products.js';
import { PRODUCT_TO_PLAN } from '../services/payments/plans.js';
import { internalProductId } from '../services/payments/playConsoleIds.js';
import { getWallet, adjustWallet, calculatePaymentSplit, spendFromWallet, buyPromptWithWallet, bonusFirstOpts } from '../services/wallet.service.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parsePaging } from '../utils/paging.js';
import { httpError } from '../utils/http-error.js';
import { playBillingConfigured } from '../lib/playBilling.js';

const router = Router();

// Money-mutating endpoints — throttle per user/IP to blunt abuse.
const moneyLimiter = rateLimit({ windowMs: 60_000, max: 60, message: 'Too many payment requests — try again shortly' });

// All payment routes require auth. The manual-settle payout routes work
// without any payment-gateway config; Play Billing verify routes rely on
// ../lib/playBilling.js which resolves creds via ADC at call time.
router.use(requireAuth);

// Play Billing verify/void routes need PLAY_BILLING_PACKAGE_NAME set — otherwise
// a clearly-config issue surfaces as a raw Google 400. Return a clean 503.
function requirePlayBilling(req, res, next) {
  if (!playBillingConfigured()) {
    return next(httpError(503, 'Play Billing is not configured yet — please try again later'));
  }
  return next();
}

// Admin back-office: only emails listed in ADMIN_EMAILS may settle payouts.
function requireAdmin(req, res, next) {
  if (!isAdminEmail(req.user?.email)) {
    const err = new Error('You need admin access to do this');
    err.status = 403;
    return next(err);
  }
  return next();
}

const playBillingVerifySchema = z.object({
  productId: z.string().min(1),
  purchaseToken: z.string().min(1),
  isSubscription: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional().default(false),
});

const playBillingVoidSchema = z.object({
  productId: z.string().min(1),
  purchaseToken: z.string().min(1),
  isSubscription: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional().default(false),
  reason: z.string().optional(),
});

/**
 * POST /payments/playbilling/verify — verify a Play Billing purchase token and
 * grant the entitlement. Dispatches by productId:
 *   - pro / pro_annual / creator / creator_annual (isSubscription: true) → activate subscription + perks
 *   - ad_free            → one-time ad-free purchase (non-consumable)
 *   - deposit_*          → deposit top-up (consumable, fee recycled as bonus)
 *   - prompt_<id>        → NOT supported here — paid prompts are bought wallet-only
 *                         via POST /payments/wallet/buy
 */
router.post('/playbilling/verify', moneyLimiter, requirePlayBilling, async (req, res, next) => {
  try {
    const parsed = playBillingVerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, 'Missing purchase details'));
    const { purchaseToken, isSubscription } = parsed.data;
    // Map the real Play Console productId to the internal id used for dispatch.
    const productId = internalProductId(parsed.data.productId);

    // Subscription activation (monthly or annual).
    if (isSubscription === true || isSubscription === 'true' || PRODUCT_TO_PLAN[productId]) {
      const result = await activateSubscriptionFromToken({
        userId: req.userId,
        productId,
        purchaseToken,
      });
      if (result.error) return next(httpError(result.error.status, result.error.message));
      return res.json({ verified: true, subscription: result });
    }

    // Paid prompt unlock is wallet-only — POST /payments/wallet/buy. A prompt_*
    // product hitting Play Billing verify is a misconfigured client.
    if (productId?.startsWith('prompt_')) {
      return next(httpError(400, 'Paid prompts are purchased from your wallet — see /payments/wallet/buy'));
    }

    // Ad-free (one-time, non-consumable).
    if (isAdFreeProduct(productId)) {
      const result = await grantAdFree({ userId: req.userId, purchaseToken });
      if (result.error) return next(httpError(result.error.status, result.error.message));
      return res.json({ verified: true, ...result });
    }

    // Deposit top-up (consumable).
    if (isDepositProduct(productId)) {
      const result = await handleDepositTopUp({ userId: req.userId, productId, purchaseToken });
      if (result.error) return next(httpError(result.error.status, result.error.message));
      return res.json({ verified: true, ...result });
    }

    return next(httpError(400, 'Unknown product'));
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /payments/playbilling/void — void/refund a Play Billing grant.
 * Body: { productId, purchaseToken, isSubscription?, reason? }.
 * Reverses the matching grant: prompt unlock revokes + debits creator
 * earnings (capped), deposit top-up refunds net + removes bonus vintage,
 * ad-free revokes (unless a subscription perk), subscription is marked void.
 * (plans/play-billing.md §7)
 */
router.post('/playbilling/void', moneyLimiter, async (req, res, next) => {
  try {
    const parsed = playBillingVoidSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, 'Missing void details'));
    const { productId, purchaseToken, isSubscription, reason } = parsed.data;

    if (isSubscription === true || isSubscription === 'true') {
      const result = await voidSubscriptionPurchase({ purchaseToken, reason });
      if (result.error) return next(httpError(result.error.status, result.error.message));
      return res.json(result);
    }

    // Same normalization the verify route applies (line ~82): the Play Console
    // route exposes raw console ids (`playbold.promptly.deposit_s`,
    // `playbold.promptly.ad`), but voidOneTimePurchase dispatches on INTERNAL
    // ids (`deposit_s`, `ad_free`, `prompt_*`). Forgetting this here made every
    // deposit / ad-free void hit the 400 "Unknown productId for void" branch.
    const result = await voidOneTimePurchase({
      userId: req.userId,
      productId: internalProductId(productId),
      purchaseToken,
      reason,
    });
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /payments/subscriptions — cancel the signed-in user's active
 * subscription. Play Billing cancellations are user-initiated in the Play
 * Store; this marks the local row cancelled (paid current period stays).
 * Admins get 409 (their access is permanent).
 */
router.delete('/subscriptions', moneyLimiter, async (req, res, next) => {
  try {
    const result = await cancelActiveSubscription(req.userId);
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /payments/wallet — the signed-in user's multi-balance wallet breakdown:
 * earnings (withdrawable), deposits (own money), bonus (expiring credits).
 * Returns per-balance amounts, type metadata, and sanitized `bonusCredits`
 * (opaque ids — never the raw internal vintage ids).
 */
router.get('/wallet', async (req, res, next) => {
  try {
    const wallet = await getWallet(req.userId);
    return res.json(wallet);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /payments/wallet/allocate?itemPriceInr=99 — read-only preview of how the
 * user would pay for an item from their wallet. Returns how much comes from each
 * bucket (`bonus` → `deposits` → `earnings`) plus what's left to pay / what they
 * still owe. Read-only — the actual spend happens at a later phase.
 *
 * For paid prompts this mirrors the buy flow exactly: BONUS FIRST, capped at 10%
 * of `itemPriceInr`, then deposits, then earnings. So for a ₹99 prompt you get:
 *   { bonus: 9.9, deposits: X, earnings: Y, totalCovered, remaining }
 * The app renders the per-bucket amounts directly.
 *
 * Response also carries the raw `split` list (for back-compat) and the user's
 * available `wallet` balances so the UI can show "X of Y".
 */
router.get('/wallet/allocate', async (req, res, next) => {
  try {
    const itemPriceInr = Number(req.query.itemPriceInr);
    if (!Number.isFinite(itemPriceInr) || itemPriceInr <= 0) {
      return next(httpError(400, 'itemPriceInr must be a positive number'));
    }
    const result = await calculatePaymentSplit(req.userId, itemPriceInr, bonusFirstOpts(itemPriceInr));
    const allocation = { bonus: 0, deposits: 0, earnings: 0 };
    for (const s of result.split) allocation[s.balanceType] = s.amountToUse;
    const wallet = await getWallet(req.userId);
    return res.json({
      itemPriceInr,
      ...allocation,
      totalCovered: result.totalCovered,
      remaining: result.remaining,
      split: result.split,
      wallet: wallet.balances,
    });
  } catch (err) {
    return next(err);
  }
});

const walletSpendSchema = z.object({
  itemPriceInr: z.number().positive().finite(),
  refId: z.string().trim().min(1).max(300),
  note: z.string().trim().max(300).optional(),
});

/**
 * POST /payments/wallet/spend — spend wallet balances as a payment source toward
 * an item. Partial-coverage: debits exactly the wallet split (deposits →
 * earnings → bonus, bonus capped at 10% of itemPriceInr) and returns `remaining`
 * as the residual the caller pays via a real Play Billing purchase. Idempotent
 * by `refId` — a replay returns the same result without double-debiting.
 */
router.post('/wallet/spend', moneyLimiter, async (req, res, next) => {
  try {
    const parsed = walletSpendSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return next(httpError(400, 'Invalid request body — expected itemPriceInr, refId, and optional note'));
    }
    const result = await spendFromWallet({ userId: req.userId, ...parsed.data });
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

const walletBuySchema = z.object({
  itemPriceInr: z.number().positive().finite(),
  refId: z.string().trim().min(1).max(300),
});

/**
 * POST /payments/wallet/buy — buy a paid prompt's unlock ENTIRELY from the user
 * wallet (no Play Billing, no purchase token). The buyer pays `price × 1.05`
 * (5% transaction fee, mirroring Play's prompt fee); the wallet covers the whole
 * amount. In one transaction: debits the wallet split (deposits → earnings →
 * bonus, bonus ≤ 10% of the total due), writes the completed `prompt_purchases`
 * row (`gateway:'wallet'`, with `buyerPaysInr` + `transactionFeeInr`), credits
 * the author's earnings the gross price, and appends the sale ledger row.
 * Idempotent by `refId` (`prompt_<id>` — the same claim seam as wallet/spend),
 * so a retry never double-charges.
 *
 * Body: { itemPriceInr, refId } → { success, unlocked, promptId, purchaseId,
 * buyerPaysInr, transactionFeeInr, split, wallet }
 * On insufficient funds → 402 { error, shortfall } and the client routes to Top-up.
 */
router.post('/wallet/buy', moneyLimiter, async (req, res, next) => {
  try {
    const parsed = walletBuySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return next(httpError(400, 'Invalid request body — expected itemPriceInr and refId'));
    }
    const { itemPriceInr, refId } = parsed.data;
    // refId is `prompt_<id>` — parse the prompt id from it (server-authoritative).
    const promptId = String(refId).startsWith('prompt_') ? String(refId).slice('prompt_'.length) : '';
    if (!promptId) return next(httpError(400, 'refId must look like prompt_<id>'));

    const result = await buyPromptWithWallet({ userId: req.userId, itemPriceInr, promptId, refId });
    if (result.error) return next(httpError(result.error.status, result.error.message));
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

/**
 * PATCH /payments/admin/wallets/:id — manual wallet adjustment (support /
 * refund-dispute tooling, plans/moderation.md §7).
 * Body: { balanceType: 'earnings'|'deposits'|'bonus', deltaInr: ±amount, note? }.
 * Positive deltaInr credits, negative debits. Runs through the same
 * credit/debit primitives as every other write (ledger row + FEFO intact).
 */
const walletAdjustSchema = z.object({
  balanceType: z.enum(['earnings', 'deposits', 'bonus']),
  deltaInr: z.number().finite().refine((n) => n !== 0, 'deltaInr must be non-zero'),
  note: z.string().trim().max(300).optional(),
});

router.patch('/admin/wallets/:id', moneyLimiter, requireAdmin, async (req, res, next) => {
  try {
    const parsed = walletAdjustSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return next(httpError(400, parsed.error.issues[0]?.message ?? 'Invalid adjustment body'));
    }
    const result = await adjustWallet({
      userId: req.params.id,
      balanceType: parsed.data.balanceType,
      deltaInr: parsed.data.deltaInr,
      note: parsed.data.note,
    });
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
