import { COLS, findByPk, queryAll, update, inTxGet, inTxAdd, inTxSet } from '../../db/firestoreRepo.js';
import { runTransaction } from '../../db/config.js';
import { env } from '../../config/env.js';
import { balanceFor, writeLedger } from '../ledger.js';
import { currentActiveSubscriptionWithPlan } from './subscription-utils.js';

const MIN_WITHDRAWAL_INR = env.MIN_WITHDRAWAL_INR;

function err(status, message) {
  return { error: { status, message } };
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

  // GATE 2 — the creator needs a saved UPI payout destination.
  if (!user?.upiId) {
    return err(400, 'Add your UPI ID on your profile before withdrawing');
  }

  // GATE 5 — one in-flight withdrawal at a time (idempotency).
  const inFlight = await queryAll({
    collection: COLS.payouts,
    filters: [
      { field: 'userId', value: userId },
      { field: 'status', op: 'in', value: ['pending', 'processing'] },
    ],
    limit: 1,
  });
  if (inFlight.rows.length) {
    return err(409, 'You already have a withdrawal in progress — wait for it to settle');
  }

  const balance = await balanceFor(userId);
  if (amountInr > balance) {
    return err(400, `Insufficient balance — you can withdraw up to ₹${balance}`);
  }

  try {
    const payoutId = await runTransaction(async (tx) => {
      // Re-check the balance inside the transaction (authoritative).
      const balDoc = await inTxGet(tx, COLS.userBalances, userId);
      const bal = Number(balDoc?.balanceInr ?? 0);
      if (amountInr > bal) {
        throw Object.assign(new Error('insufficient'), { insufficient: true });
      }

      const ref = inTxAdd(tx, COLS.payouts, {
        userId,
        amountInr,
        status: 'pending',
        upiId: user.upiId ?? null,
        razorpayPayoutId: null,
        bankAccountId: null,
        processedAt: null,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Reserve the amount: a debit now, "paid" later is pure bookkeeping.
      await writeLedger(
        tx,
        {
          userId,
          type: 'payout',
          direction: 'debit',
          amountInr,
          refId: ref.id,
          note: 'Withdrawal request (manual settle via UPI, pending)',
        },
      );

      return ref.id;
    });

    const payout = await findByPk(COLS.payouts, payoutId);
    return {
      payout: {
        id: payout.id,
        amountInr: payout.amountInr,
        status: payout.status,
        upiId: payout.upiId,
        createdAt: payout.createdAt,
      },
    };
  } catch (error) {
    if (error.insufficient) {
      return err(400, 'Insufficient balance — the amount you requested is no longer available');
    }
    return { error: { status: 409, message: 'Could not create the payout — try again' } };
  }
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

  // Embed the requesting user (id, fullName, email) like the previous SQL join.
  const maybeUsers = await Promise.all(
    rows.map(async (p) => {
      const user = await findByPk(COLS.users, p.userId);
      return { ...p, user: user ? { id: user.id, fullName: user.fullName, email: user.email } : null };
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
