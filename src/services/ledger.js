import { Transaction } from '../db/models.js';

/**
 * Shared ledger helpers — every credit/debit for a user is one row in
 * `transactions`, with `balance_after_inr` snapshotted for an audit trail.
 * All amounts are integer rupees.
 */

/** Latest running balance for a user, used to keep balance_after_inr consistent. */
export async function runningBalanceFor(userId, transaction) {
  const last = await Transaction.findOne({
    where: { userId },
    order: [['createdAt', 'DESC']],
    transaction,
  });
  return last ? last.balanceAfterInr : 0;
}

/**
 * Write one ledger row inside the caller's transaction and return it.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.type     TransactionType enum value
 * @param {'credit'|'debit'} opts.direction
 * @param {number} opts.amountInr positive integer rupees
 * @param {string} [opts.refId]   id of the source row (purchase/subscription/payout)
 * @param {string} opts.note      human-readable line shown in the app
 * @param {import('sequelize').Transaction} transaction
 */
export async function writeLedger({ userId, type, direction, amountInr, refId, note }, transaction) {
  const balance = await runningBalanceFor(userId, transaction);
  const balanceAfterInr = direction === 'credit' ? balance + amountInr : balance - amountInr;
  return Transaction.create(
    { userId, type, direction, amountInr, balanceAfterInr, refId, note },
    { transaction },
  );
}
