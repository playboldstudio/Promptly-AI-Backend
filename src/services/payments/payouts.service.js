import { Op } from 'sequelize';
import { Payout, User, UserSubscription } from '../../db/models.js';
import { sequelize } from '../../db/config.js';
import { writeLedger } from '../ledger.js';

/**
 * CREATOR PAYOUTS — MANUAL SETTLE (solo developer; no RazorpayX).
 *
 * ⚠️ RazorpayX Payouts (automatic bank transfer to a third party) is BUSINESS-
 * only — a solo individual can't get a payout route. So the flow is:
 *
 *   Creator balance ──(request, min ₹60)──► Payout row (pending, upiId)
 *        admin transfers ₹ to the creator's UPI via their OWN UPI app (NOT Razorpay)
 *        admin marks the payout paid/failed in the app
 *        creator sees "Processing → Paid" in My Account
 *
 * No KYC and no bank account are required — the creator just saves a UPI ID on
 * their profile (POST /me/upi), and the payout snapshots it at request time so
 * a later UPI change never redirects a pending payment.
 *
 * requestPayout({ userId, amountInr }):
 *   1. GATE: user has an ACTIVE paid subscription (Pro/Creator) — payouts are
 *      for subscribed creators only
 *   2. GATE: user has a saved upi_id (the destination; POST /me/upi sets it)
 *   3. GATE: no payout already pending/processing (one in-flight withdrawal)
 *   4. RULE: amountInr >= min (MIN_WITHDRAWAL_INR, default ₹60)
 *   5. RULE: amountInr <= available balance (ledger credits − debits)
 *   6. Writes a Payout row (status pending, upiId snapshot) + a ledger debit
 *      (type = payout) in one transaction, so the balance is reserved the
 *      moment the request lands.
 *
 * Admin (solo = the developer): /admin/payouts lists pending, and
 * markPayoutPaid()/markPayoutFailed() flip status + processed_at after the
 * money is transferred. The ledger debit already happened at request time, so
 * "paid" is just bookkeeping — this is why the balance is *reserved*, not
 * withdrawn, while pending.
 */

const MIN_WITHDRAWAL_INR = 60;

/** Return a 4xx-style error object, matching the other services' shape. */
function err(status, message) {
  return { error: { status, message } };
}

/**
 * Request a withdrawal. Creates the Payout + reserves the balance atomically.
 * @returns {{ payout } | {error}}
 */
export async function requestPayout({ userId, amountInr }) {
  if (!Number.isInteger(amountInr) || amountInr <= 0) {
    return err(400, 'Amount must be a positive whole number (rupees)');
  }
  if (amountInr < MIN_WITHDRAWAL_INR) {
    return err(400, `Minimum withdrawal is ₹${MIN_WITHDRAWAL_INR}`);
  }

  const user = await User.findByPk(userId);
  if (!user) return err(404, 'User not found');

  // GATE 1 — payouts are for subscribed creators (Pro/Creator) only.
  const subscription = await UserSubscription.findOne({
    where: { userId, status: 'active' },
    include: [{ association: 'plan' }],
  });
  const planId = subscription?.plan?.id;
  if (planId !== 'pro' && planId !== 'creator') {
    return err(403, 'Subscriber only — upgrade to Pro or Creator before withdrawing');
  }

  // GATE 2 — the creator needs a saved UPI payout destination.
  if (!user?.upiId) {
    return err(400, 'Add your UPI ID on your profile before withdrawing');
  }

  // GATE 5 — one in-flight withdrawal at a time (idempotency).
  const inFlight = await Payout.findOne({
    where: { userId, status: { [Op.in]: ['pending', 'processing'] } },
  });
  if (inFlight) {
    return err(409, 'You already have a withdrawal in progress — wait for it to settle');
  }

  const balance = await availableBalance(userId);
  if (amountInr > balance) {
    return err(400, `Insufficient balance — you can withdraw up to ₹${balance}`);
  }

  try {
    const payout = await sequelize.transaction(async (t) => {
      const created = await Payout.create(
        { userId, amountInr, status: 'pending', upiId: user.upiId },
        { transaction: t },
      );
      // Reserve the amount: a debit now, "paid" later is pure bookkeeping.
      await writeLedger(
        {
          userId,
          type: 'payout',
          direction: 'debit',
          amountInr,
          refId: created.id,
          note: 'Withdrawal request (manual settle via UPI, pending)',
        },
        t,
      );
      return created;
    });

    return {
      payout: {
        id: payout.id,
        amountInr: payout.amountInr,
        status: payout.status,
        upiId: payout.upiId,
        createdAt: payout.createdAt,
      },
    };
  } catch (err) {
    // Out-of-order writes or a constraint hit — surface as 409 rather than a raw 500.
    return { error: { status: 409, message: 'Could not create the payout — try again' } };
  }
}

/**
 * Admin — list payout requests with the transfer details the admin needs
 * (each row carries the UPI ID to pay to, plus the requesting user).
 * Not the endpoint a regular user calls; gate it with a real admin check
 * (this is dev: any authed user can hit it — document + lock before launch).
 * @returns {Promise<{ payouts: Payout[] }>}
 */
export async function listPayouts({ status, limit = 50, offset = 0 } = {}) {
  const where = {};
  if (status && ['pending', 'processing', 'paid', 'failed'].includes(status)) {
    where.status = status;
  }
  const { rows, count } = await Payout.findAndCountAll({
    where,
    include: [
      { association: 'user', attributes: ['id', 'fullName', 'email'] },
    ],
    order: [['createdAt', 'DESC']],
    limit: Math.min(limit, 100),
    offset: Math.max(offset, 0),
    distinct: true,
  });
  return { payouts: rows, total: count };
}

/**
 * Admin — mark a pending payout PAID after transferring the money manually.
 * @returns {{ payout } | {error}}
 */
export async function markPayoutPaid({ payoutId }) {
  const payout = await Payout.findByPk(payoutId);
  if (!payout) return err(404, 'Payout not found');
  if (payout.status !== 'pending') {
    return err(409, `Payout is already ${payout.status}`);
  }
  await payout.update({ status: 'paid', processedAt: new Date() });
  return { payout };
}

/**
 * Admin — mark a pending payout FAILED (money not sent). The reserved balance
 * is released back to the creator.
 * @returns {{ payout } | {error}}
 */
export async function markPayoutFailed({ payoutId, reason }) {
  const payout = await Payout.findByPk(payoutId);
  if (!payout) return err(404, 'Payout not found');
  if (payout.status !== 'pending') {
    return err(409, `Payout is already ${payout.status}`);
  }

  try {
    await sequelize.transaction(async (t) => {
      await payout.update(
        { status: 'failed', processedAt: new Date(), failureReason: reason ?? null },
        { transaction: t },
      );
      // Reverse the reservation so the creator can re-request.
      await writeLedger(
        {
          userId: payout.userId,
          type: 'payout',
          direction: 'credit',
          amountInr: payout.amountInr,
          refId: payout.id,
          note: 'Withdrawal failed — balance returned',
        },
        t,
      );
    });
    return { payout };
  } catch (err) {
    return { error: { status: 409, message: 'Could not update the payout — try again' } };
  }
}

/**
 * Available balance = ledger credits − debits, minus anything already reserved
 * by a still-pending payout (those debits are in the ledger, so this is really
 * just the ledger total — kept explicit for clarity).
 */
async function availableBalance(userId) {
  const rows = await sequelize.query(
    `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_inr ELSE -amount_inr END), 0) AS balance
       FROM transactions WHERE user_id = $1`,
    { bind: [userId], type: sequelize.QueryTypes.SELECT },
  );
  return Number(rows[0]?.balance) || 0;
}
