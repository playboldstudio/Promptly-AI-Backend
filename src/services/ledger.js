import { FieldValue } from 'firebase-admin/firestore';
import { COLS, inTxAdd, inTxGet, inTxSet, findByPk } from '../db/firestoreRepo.js';

/**
 * Ledger helpers — every credit/debit is one row in `transactions` with the
 * running balance (user_balances) snapshotted for an audit trail.
 * All amounts are integer rupees. MUST run inside a Firestore transaction.
 */

export async function writeLedger(tx, { userId, type, direction, amountInr, refId, note, balanceInr }) {
  // Firestore forbids reads AFTER writes inside a transaction, so callers that
  // write before the ledger must pre-read the balance and pass it here.
  const prevBalance =
    balanceInr ?? Number((await inTxGet(tx, COLS.userBalances, userId))?.balanceInr ?? 0);
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
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Keep the aggregate balance in sync (absolute write inside the tx is atomic).
  inTxSet(tx, COLS.userBalances, userId, {
    balanceInr: balanceAfterInr,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return ref.id;
}

/**
 * Read a user's current balance (for display / payout pre-checks — authoritative
 * deduction happens inside writeLedger's transaction).
 */
export async function balanceFor(userId) {
  const doc = await findByPk(COLS.userBalances, userId);
  return Number(doc?.balanceInr ?? 0);
}
