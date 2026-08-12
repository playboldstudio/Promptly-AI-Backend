import { BankAccount, KycVerification, Payout } from '../../db/models.js';
import { sequelize } from '../../db/config.js';
import { writeLedger } from '../ledger.js';

/**
 * CREATOR PAYOUTS — MANUAL SETTLE (solo developer; no RazorpayX).
 *
 * ⚠️ RazorpayX Payouts (automatic bank transfer to a third party) is BUSINESS-
 * only — a solo individual can't get a payout route. So the flow is:
 *
 *   Creator balance ──(request, min ₹60)──► Payout row (pending)
 *        admin transfers ₹ via their OWN bank app  (NOT Razorpay)
 *        admin marks the payout paid/failed in the app
 *        creator sees "Processing → Paid" in My Account
 *
 * requestPayout({ userId, amountInr }):
 *   1. GATE: kyc_verifications.status === 'verified' (server-side, not just UI)
 *   2. GATE: an active bank_accounts row exists (the destination; full account
 *      number stored for the admin to transfer to — see BankAccount model)
 *   3. RULE: amountInr >= 60 (min withdrawal)
 *   4. RULE: amountInr <= available balance (ledger credits − debits) minus any
 *      amount already locked in a pending payout
 *   5. Writes a Payout row (status pending) + a ledger debit (type = payout) in
 *      one transaction, so the balance is reserved the moment the request lands.
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

  const [kyc, bank] = await Promise.all([
    KycVerification.findOne({ where: { userId } }),
    BankAccount.findOne({ where: { userId, isActive: true }, order: [['createdAt', 'DESC']] }),
  ]);
  if (!kyc || kyc.status !== 'verified') {
    return err(403, 'KYC must be verified before you can withdraw');
  }
  if (!bank) {
    return err(400, 'Add a verified bank account before withdrawing');
  }

  const balance = await availableBalance(userId);
  if (amountInr > balance) {
    return err(400, `Insufficient balance — you can withdraw up to ₹${balance}`);
  }

  try {
    const payout = await sequelize.transaction(async (t) => {
      const created = await Payout.create(
        { userId, amountInr, status: 'pending', bankAccountId: bank.id },
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
          note: `Withdrawal request (manual settle, pending)`,
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
        createdAt: payout.createdAt,
      },
    };
  } catch (err) {
    // Out-of-order writes or a constraint hit — surface as 409 rather than a raw 500.
    return { error: { status: 409, message: 'Could not create the payout — try again' } };
  }
}

/**
 * Admin — list payout requests with the transfer details the admin needs.
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
      { association: 'bankAccount' },
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
