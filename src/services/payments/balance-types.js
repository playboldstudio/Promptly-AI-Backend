/**
 * Wallet balance-type definitions (plans/wallet.md §2).
 *
 * Each wallet bucket's spend rules live here so adding a future balance type is
 * a new entry + a seed default — not a migration.
 *
 * Balances:
 *  - earnings  — withdrawable. Creator receives full gross at sale; the 15% Pro
 *                / 5% Creator withdrawal fee is the only deduction, applied at
 *                payout (see plans/withdrawals.md).
 *  - deposits  — user's own money, net after Google's gateway fee (₹100 top-up
 *                → ₹85). Spend 100%, no expiry, not withdrawable.
 *  - bonus     — earned/recycled credit (deposit fee-recycle, referrals, promos).
 *                Spend 10% max of item price, 90-day expiry, not withdrawable.
 */

export const BALANCE_TYPES = {
  earnings: {
    id: 'earnings',
    withdrawable: true,
    maxUsePercent: 100,
    expires: null,
    notifyBeforeExpiry: null,
    priority: 2,
    description: 'Earnings from prompt sales',
  },
  deposits: {
    id: 'deposits',
    withdrawable: false,
    maxUsePercent: 100,
    expires: null,
    notifyBeforeExpiry: null,
    priority: 1,
    description: 'Credits from top-ups',
  },
  bonus: {
    id: 'bonus',
    withdrawable: false,
    maxUsePercent: 10,
    expires: 90,
    notifyBeforeExpiry: 7,
    priority: 3,
    description: 'Bonus credits from deposit fee-recycle, referrals, rewards, promos',
  },
};

export function getBalanceType(id) {
  return BALANCE_TYPES[id] ?? null;
}

export function isWithdrawable(id) {
  return BALANCE_TYPES[id]?.withdrawable ?? false;
}

export function getMaxUsePercent(id) {
  return BALANCE_TYPES[id]?.maxUsePercent ?? 0;
}

/** Balance types ordered by priority (deposits → earnings → bonus = spend order). */
export function getBalanceTypesByPriority() {
  return Object.values(BALANCE_TYPES).sort((a, b) => a.priority - b.priority);
}

/** An all-zero wallet doc shape (used when one is missing). */
export function zeroBalances() {
  return {
    earnings: 0,
    deposits: 0,
    bonus: 0,
    bonusVintages: {},
  };
}