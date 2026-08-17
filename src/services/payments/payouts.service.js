import { COLS, findByPk, queryAll, inTxGet, inTxAdd, inTxSet, inTxQueryAll } from '../../db/firestoreRepo.js';
import { runTransaction } from '../../db/config.js';
import { env } from '../../config/env.js';
import { writeLedger } from '../ledger.js';
import { currentActiveSubscriptionWithPlan } from './subscription-utils.js';

const MIN_WITHDRAWAL_INR = env.MIN_WITHDRAWAL_INR;

/** Flat Razorpay UPI-transfer fee charged on every withdrawal. */
const RAZORPAY_FEE_PERCENT = 2;

/** GST levied on the Razorpay fee (18% of the 2%). */
const RAZORPAY_GST_PERCENT = 18;

function err(status, message) {
  return { error: { status, message } };
}

/** Money precision: rupees with paise — never more than 2 decimals. */
function toMoney(value) {
  return Math.round(value * 100) / 100;
}

/**
 * The creator's bank-transfer payout destination is complete only when every
 * detail AND both KYC document images are on file. Payouts settle via bank
 * (IMPS/NEFT), so UPI is no longer required.
 */
function bankDetailsComplete(user) {
  return Boolean(
    user &&
      user.panNumber &&
      user.panImageUrl &&
      user.bankHolderName &&
      user.bankAccountNumber &&
      user.bankIfsc &&
      user.bankBranch &&
      user.bankAccountImageUrl,
  );
}

/**
 * Fee breakdown for a withdrawal. Fees are DEDUCTED from the requested amount:
 * 2% Razorpay UPI fee + 18% GST on that fee + the plan's platform fee. Every
 * value is kept to 2 decimal places (paise precision) — no whole-rupee rounding.
 * The admin pays `netInr` to the creator's UPI, the platform keeps the rest.
 * `platformFeePercent` comes from the creator's plan (Pro=5%, Creator=0%).
 */
function payoutFees(amountInr, platformFeePercent = 0) {
  const razorpayFeeInr = toMoney((amountInr * RAZORPAY_FEE_PERCENT) / 100);
  const gstInr = toMoney((razorpayFeeInr * RAZORPAY_GST_PERCENT) / 100);
  const platformFeeInr = toMoney((amountInr * (platformFeePercent || 0)) / 100);
  const feeInr = toMoney(razorpayFeeInr + gstInr + platformFeeInr);
  return {
    razorpayFeeInr,
    gstInr,
    platformFeeInr,
    feeInr,
    netInr: toMoney(amountInr - feeInr),
  };
}

/**
 * True withdrawable balance — ONLY money earned from paid prompt sales (the
 * author's net share), minus what has already been withdrawn or is reserved by
 * an in-flight payout. Wallet-ledger rows for buyer purchases, subscription
 * payments, and corrections do NOT count toward what a creator can withdraw.
 * Returns a non-negative amount.
 */
export async function withdrawableBalanceFor(userId) {
  const [sales, payouts] = await Promise.all([
    queryAll({
      collection: COLS.promptPurchases,
      filters: [{ field: 'authorId', value: userId }, { field: 'status', value: 'completed' }],
    }),
    queryAll({ collection: COLS.payouts, filters: [{ field: 'userId', value: userId }] }),
  ]);

  const earnedInr = sales.rows.reduce((sum, s) => sum + (Number(s.netInr) || 0), 0);
  const reservedInr = payouts.rows
    .filter((p) => ['pending', 'processing', 'paid'].includes(p.status))
    .reduce((sum, p) => sum + (Number(p.amountInr) || 0), 0);

  return Math.max(0, earnedInr - reservedInr);
}

/**
 * Withdrawal eligibility — the authoritative rules the app should surface.
 * A creator can withdraw when they hold an active Pro/Creator plan, have their
 * bank-transfer details + KYC documents on file, and their sales earnings meet
 * the minimum. `hasUpi` is still returned for client compatibility but no
 * longer gates withdrawals.
 */
export async function withdrawalEligibility(userId) {
  const user = await findByPk(COLS.users, userId);
  const sub = await currentActiveSubscriptionWithPlan(userId);
  const planId = sub?.planId;
  const platformFeePercent = sub?.plan?.platformFeePercent ?? 0;
  const withdrawable = await withdrawableBalanceFor(userId);

  const hasBankDetails = bankDetailsComplete(user);
  const hasUpi = Boolean(user?.upiId);
  const hasPaidPlan = planId === 'pro' || planId === 'creator';
  const meetsMinimum = withdrawable >= MIN_WITHDRAWAL_INR;

  const blockers = [];
  if (!hasPaidPlan) blockers.push('Upgrade to Pro or Creator to withdraw');
  if (!hasBankDetails) blockers.push('Add your bank details (PAN + account) on your profile before withdrawing');
  if (!meetsMinimum) blockers.push(`Earnings below the ₹${MIN_WITHDRAWAL_INR} withdrawal minimum`);

  const fees = payoutFees(withdrawable, platformFeePercent);

  return {
    withdrawableBalance: withdrawable,
    minWithdrawalInr: MIN_WITHDRAWAL_INR,
    eligible: blockers.length === 0,
    blockers,
    hasBankDetails,
    hasUpi,
    hasPaidPlan,
    meetsMinimum,
    currency: 'INR',
    razorpayFeePercent: RAZORPAY_FEE_PERCENT,
    razorpayGstPercent: RAZORPAY_GST_PERCENT,
    platformFeePercent,
    estimatedFeeInr: fees.feeInr,
    estimatedRazorpayFeeInr: fees.razorpayFeeInr,
    estimatedGstInr: fees.gstInr,
    estimatedPlatformFeeInr: fees.platformFeeInr,
    estimatedNetInr: fees.netInr,
  };
}

export async function requestPayout({ userId, amountInr }) {
  if (!Number.isInteger(amountInr) || amountInr <= 0) {
    return err(400, 'Amount must be a positive whole number (rupees)');
  }
  if (amountInr < MIN_WITHDRAWAL_INR) {
    return err(400, `Minimum withdrawal is ₹${MIN_WITHDRAWAL_INR}`);
  }

  const user = await findByPk(COLS.users, userId);
  if (!user) return err(404, 'User not found');

  // GATE 1 — payouts are for subscribed creators (Pro/Creator) only.
  const sub = await currentActiveSubscriptionWithPlan(userId);
  const planId = sub?.planId;
  if (planId !== 'pro' && planId !== 'creator') {
    return err(403, 'Subscriber only — upgrade to Pro or Creator before withdrawing');
  }

  // Fee breakdown: 2% Razorpay + the plan's platform fee, deducted from payout.
  const fees = payoutFees(amountInr, sub?.plan?.platformFeePercent ?? 0);

  // GATE 2 — the creator needs a saved bank-transfer destination + KYC docs.
  if (!bankDetailsComplete(user)) {
    return err(400, 'Add your bank details (PAN + account) on your profile before withdrawing');
  }

  // GATE 5 — one in-flight withdrawal at a time (idempotency).
  // Soft-pre-check for a fast 409; the authoritative check runs inside the
  // transaction below so two concurrent requests cannot both pass.

  // GATE 6 — the user may only withdraw money earned from paid prompt sales.
  const sales = await queryAll({
    collection: COLS.promptPurchases,
    filters: [{ field: 'authorId', value: userId }, { field: 'status', value: 'completed' }],
  });
  const earnedInr = sales.rows.reduce((sum, s) => sum + (Number(s.netInr) || 0), 0);

  const withdrawable = await withdrawableBalanceFor(userId);
  if (amountInr > withdrawable) {
    return err(400, `Insufficient sales earnings — you can withdraw up to ₹${withdrawable}`);
  }

  try {
    const { id: payoutId, balanceAfterInr } = await runTransaction(async (tx) => {
      // Authoritative in-flight check inside the transaction (race-safe), using
      // the same query that recounts the reserved payout amounts below.
      const payoutsInTx = await inTxQueryAll(tx, {
        collection: COLS.payouts,
        filters: [{ field: 'userId', value: userId }],
        limit: 100,
      });
      const inFlight = payoutsInTx.find(
        (p) => p.status === 'pending' || p.status === 'processing',
      );
      if (inFlight) {
        throw Object.assign(new Error('in-flight'), { inFlight: true });
      }

      // Re-count the reserved amount inside the transaction (authoritative):
      // earned sales minus pending/processing/paid payouts.
      const reservedInTx = payoutsInTx
        .filter((p) => ['pending', 'processing', 'paid'].includes(p.status))
        .reduce((sum, p) => sum + (Number(p.amountInr) || 0), 0);
      const withdrawableInTx = Math.max(0, earnedInr - reservedInTx);
      if (amountInr > withdrawableInTx) {
        throw Object.assign(new Error('insufficient'), { insufficient: true });
      }

      // Wallet balance for the ledger row (bookkeeping of the reservation only).
      const balDoc = await inTxGet(tx, COLS.userBalances, userId);
      const bal = Number(balDoc?.balanceInr ?? 0);

      const ref = inTxAdd(tx, COLS.payouts, {
        userId,
        amountInr,
        status: 'pending',
        // Historical field retained for old rows; new payouts settle by bank.
        upiId: user.upiId ?? null,
        panNumber: user.panNumber ?? null,
        bankHolderName: user.bankHolderName ?? null,
        bankAccountNumber: user.bankAccountNumber ?? null,
        bankIfsc: user.bankIfsc ?? null,
        bankBranch: user.bankBranch ?? null,
        razorpayPayoutId: null,
        bankAccountId: null,
        razorpayFeeInr: fees.razorpayFeeInr,
        gstInr: fees.gstInr,
        platformFeeInr: fees.platformFeeInr,
        feeInr: fees.feeInr,
        netInr: fees.netInr,
        processedAt: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Reserve the full requested amount: a debit now, "paid" later is pure
      // bookkeeping. The admin transfers only `netInr` to the creator's bank.
      await writeLedger(
        tx,
        {
          userId,
          type: 'payout',
          direction: 'debit',
          amountInr,
          refId: ref.id,
          note: `Withdrawal — ₹${amountInr} minus ₹${fees.feeInr} fees (2% Razorpay + 18% GST${fees.platformFeeInr ? ` + ${sub?.plan?.platformFeePercent ?? 0}% platform` : ''}), ${fees.netInr} to bank`,
          balanceInr: bal,
        },
      );

      return { id: ref.id, balanceAfterInr: withdrawableInTx - amountInr };
    });

    const payout = await findByPk(COLS.payouts, payoutId);
    return {
      payout: {
        id: payout.id,
        amountInr: payout.amountInr,
        status: payout.status,
        upiId: payout.upiId,
        panNumber: payout.panNumber,
        bankHolderName: payout.bankHolderName,
        bankAccountNumber: payout.bankAccountNumber,
        bankIfsc: payout.bankIfsc,
        bankBranch: payout.bankBranch,
        razorpayFeeInr: payout.razorpayFeeInr,
        gstInr: payout.gstInr,
        platformFeeInr: payout.platformFeeInr,
        feeInr: payout.feeInr,
        netInr: payout.netInr,
        createdAt: payout.createdAt,
      },
      balanceInr: balanceAfterInr,
      minWithdrawalInr: MIN_WITHDRAWAL_INR,
      currency: 'INR',
    };
  } catch (error) {
    if (error.inFlight) {
      return err(409, 'You already have a withdrawal in progress — wait for it to settle');
    }
    if (error.insufficient) {
      return err(400, 'Insufficient balance — the amount you requested is no longer available');
    }
    return { error: { status: 409, message: 'Could not create the payout — try again' } };
  }
}

/**
 * A user's own payout history (id, amount, status, dates, failure reason).
 */
export async function listUserPayouts(userId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await queryAll({
    collection: COLS.payouts,
    filters: [{ field: 'userId', value: userId }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: Math.min(limit, 100),
    offset: Math.max(offset, 0),
  });
  return { payouts: rows, total: rows.length };
}

/**
 * Admin — list payout requests with the transfer details the admin needs.
 */
export async function listPayouts({ status, limit = 50, offset = 0 } = {}) {
  const filters = [];
  if (status && ['pending', 'processing', 'paid', 'failed'].includes(status)) {
    filters.push({ field: 'status', value: status });
  }
  const { rows } = await queryAll({
    collection: COLS.payouts,
    filters,
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: Math.min(limit, 100),
    offset: Math.max(offset, 0),
  });

  // Embed the requesting user (id, fullName, email, bank-transfer details)
  // like the previous SQL join.
  const maybeUsers = await Promise.all(
    rows.map(async (p) => {
      const user = await findByPk(COLS.users, p.userId);
      return {
        ...p,
        user: user
          ? {
              id: user.id,
              fullName: user.fullName,
              email: user.email,
              upiId: user.upiId ?? null,
              panNumber: user.panNumber ?? null,
              bankHolderName: user.bankHolderName ?? null,
              bankAccountNumber: user.bankAccountNumber ?? null,
              bankIfsc: user.bankIfsc ?? null,
              bankBranch: user.bankBranch ?? null,
              panImageUrl: user.panImageUrl ?? null,
              bankAccountImageUrl: user.bankAccountImageUrl ?? null,
            }
          : null,
      };
    }),
  );

  return { payouts: maybeUsers, total: rows.length };
}

/**
 * Admin — mark a pending payout PAID after transferring the money manually.
 */
export async function markPayoutPaid({ payoutId }) {
  const payout = await findByPk(COLS.payouts, payoutId);
  if (!payout) return err(404, 'Payout not found');
  if (payout.status !== 'pending') {
    return err(409, `Payout is already ${payout.status}`);
  }

  try {
    await runTransaction(async (tx) => {
      const fresh = await inTxGet(tx, COLS.payouts, payoutId);
      if (!fresh || fresh.status !== 'pending') {
        throw Object.assign(new Error('already-claimed'), { claimed: true });
      }
      inTxSet(tx, COLS.payouts, payoutId, {
        status: 'paid',
        processedAt: new Date(),
        updatedAt: new Date(),
      });
    });
    const updated = await findByPk(COLS.payouts, payoutId);
    return { payout: updated };
  } catch (error) {
    if (error.claimed) return err(409, 'Payout is no longer pending');
    return { error: { status: 409, message: 'Could not update the payout — try again' } };
  }
}

/**
 * Admin — mark a pending payout FAILED. The reserved balance is returned.
 */
export async function markPayoutFailed({ payoutId, reason }) {
  const payout = await findByPk(COLS.payouts, payoutId);
  if (!payout) return err(404, 'Payout not found');
  if (payout.status !== 'pending') {
    return err(409, `Payout is already ${payout.status}`);
  }

  try {
    await runTransaction(async (tx) => {
      const fresh = await inTxGet(tx, COLS.payouts, payoutId);
      if (!fresh || fresh.status !== 'pending') {
        throw Object.assign(new Error('already-claimed'), { claimed: true });
      }
      // Pre-read the balance BEFORE writing so the reversal writes a valid ledger.
      const balDoc = await inTxGet(tx, COLS.userBalances, payout.userId);
      const bal = Number(balDoc?.balanceInr ?? 0);
      inTxSet(tx, COLS.payouts, payoutId, {
        status: 'failed',
        processedAt: new Date(),
        failureReason: reason ?? null,
        updatedAt: new Date(),
      });
      // Reverse the reservation so the creator can re-request.
      await writeLedger(
        tx,
        {
          userId: payout.userId,
          type: 'payout',
          direction: 'credit',
          amountInr: payout.amountInr,
          refId: payout.id,
          note: 'Withdrawal failed — balance returned',
          balanceInr: bal,
        },
      );
    });
    const updated = await findByPk(COLS.payouts, payoutId);
    return { payout: updated };
  } catch (error) {
    if (error.claimed) return err(409, 'Payout is no longer pending');
    return { error: { status: 409, message: 'Could not update the payout — try again' } };
  }
}
