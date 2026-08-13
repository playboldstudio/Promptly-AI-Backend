import { FieldValue } from 'firebase-admin/firestore';
import { COLS, inTxAdd, inTxGet, findByPk } from '../db/firestoreRepo.js';

/**
 * Shared ledger helpers — every credit/debit for a user is one row in
 * `transactions`, with `balanceAfterInr` snapshotted for an audit trail.
 * All amounts are integer rupees.
 *
 * The running balance is maintained in `user_balances/{userId}.balanceInr`.
 * These helpers MUST be called inside a Firestore transaction (runTransaction)
 * so money rows are all-or-nothing and the balance can't drift.
 */

/**
 * Write one ledger row inside the caller's Firestore transaction.
 * Updates the user's running balance in `user_balances` and snapshots the
 * post-balance onto the new row.
 *
 * @param {import('firebase-admin/firestore').Transaction} tx
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.type     TransactionType enum value
 * @param {'credit'|'debit'} opts.direction
 * @param {number} opts.amountInr positive integer rupees
 * @param {string} [opts.refId]   id of the source row (purchase/subscription/payout)
 * @param {string} opts.note      human-readable line shown in the app
 */
export async function writeLedger(tx, { userId, type, direction, amountInr, refId, note }) {
  const balanceDoc = await inTxGet(tx, COLS.userBalances, userId);
  const prevBalance = Number(balanceDoc?.balanceInr ?? 0);
  const balanceAfterInr =
    direction === 'credit' ? prevBalance + amountInr : prevBalance - amountInr;

  const ref = inTxAdd(tx, COLS.transactions, {
    userId,
    type,
    direction,
    amountInr,
    balanceAfterInr,
    refId: refId ?? null,
    note,
  });

  // Keep the aggregate balance in sync (absolute write inside the tx is atomic).
  inTxSet(tx, COLS.userBalances, userId, {
    balanceInr: balanceAfterInr,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return ref.id;
}

/**
 * Read a user's current available balance (outside a transaction — for display
 * and payout eligibility pre-checks). Not used for authoritative deduction,
 * which happens inside writeLedger's transaction.
 */
export async function balanceFor(userId) {
  const doc = await findByPk(COLS.userBalances, userId);
  return Number(doc?.balanceInr ?? 0);
}
