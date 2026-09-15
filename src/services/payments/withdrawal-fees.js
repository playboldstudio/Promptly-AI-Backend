/**
 * Withdrawal fee math (plans/withdrawals.md §2) — pure, unit-testable.
 *
 * A withdrawal deducts ONLY the seller's platform fee — 15% (Pro seller) /
 * 5% (Creator seller). The Play Billing ~15% commission was absorbed by the
 * platform at payment time, and the 5% buyer transaction fee was app income
 * at purchase — neither is re-deducted here.
 */

/** Money precision: rupees with paise — never more than 2 decimals. */
function toMoney(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Fee breakdown for a withdrawal.
 *
 * @param {number} options.earningsBalance - the gross amount the creator asked
 *   to withdraw (their wallet `earnings`, full gross of the sale price).
 * @param {number} [options.platformFeePercent] - the seller's plan withdrawal
 *   fee (15 for Pro, 5 for Creator, 0 for free).
 * @returns {{ earningsBalance: number, platformFeePercent: number,
 *   platformFeeInr: number, feeInr: number, netInr: number, netPayout: number }}
 *   `netPayout` is the amount the admin transfers to the creator's bank; the
 *   platform keeps `feeInr`.
 */
export function calculateWithdrawal({ earningsBalance, platformFeePercent = 0 }) {
  const platformFeeInr = toMoney((earningsBalance * (platformFeePercent || 0)) / 100);
  const netInr = toMoney(earningsBalance - platformFeeInr);
  return {
    earningsBalance,
    platformFeePercent,
    platformFeeInr,
    feeInr: platformFeeInr,
    netInr,
    netPayout: netInr,
  };
}