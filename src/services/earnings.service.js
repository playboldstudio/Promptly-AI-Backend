import { COLS, queryAll, getMany } from '../db/firestoreRepo.js';
import { withdrawalEligibility } from './payments/payouts.service.js';
import { getWallet } from './wallet.service.js';

/**
 * Creator earnings — derived from prompt_purchases (per-prompt breakdown) and
 * the wallet `earnings` balance + payouts (summary). All amounts are rupees.
 */

/**
 * Fetch ALL matching rows via offset-paged queries. The repo default is 50 rows
 * per `queryAll`, which would silently truncate any author's totals past 50
 * sales/payouts — paging keeps the aggregates exact at any scale.
 */
async function pageAll(collection, filters) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const page = await queryAll({ collection, filters, limit: 500, offset });
    rows.push(...page.rows);
    if (page.count < 500) break;
    offset += 500;
  }
  return rows;
}

export async function getEarningsByPrompt(authorId) {
  const rows = await pageAll(COLS.promptPurchases, [
    { field: 'authorId', value: authorId },
    { field: 'status', value: 'completed' },
  ]);

  const byPrompt = new Map();
  rows.forEach((r) => {
    const entry = byPrompt.get(r.promptId) ?? { totalInr: 0, salesCount: 0 };
    // Gross earnings per prompt — the full price (withdrawal fee applies at payout).
    entry.totalInr += Number(r.priceInr) || 0;
    entry.salesCount += 1;
    byPrompt.set(r.promptId, entry);
  });

  const promptIds = [...byPrompt.keys()];
  const prompts = promptIds.length ? await getMany(COLS.prompts, promptIds) : {};
  const titleById = new Map(promptIds.map((id) => [id, prompts[id]?.title ?? null]));

  return [...byPrompt.entries()].map(([promptId, e]) => ({
    promptId,
    title: titleById.get(promptId) ?? 'Unknown prompt',
    totalInr: e.totalInr || 0,
    salesCount: e.salesCount || 0,
  }));
}

/**
 * Earnings summary: lifetime gross, withdrawn, pending payouts, available balance.
 */
export async function getEarningsSummary(authorId) {
  const [payoutRows, sales, wallet, elig] = await Promise.all([
    pageAll(COLS.payouts, [{ field: 'userId', value: authorId }]),
    pageAll(COLS.promptPurchases, [
      { field: 'authorId', value: authorId },
      { field: 'status', value: 'completed' },
    ]),
    getWallet(authorId),
    withdrawalEligibility(authorId),
  ]);

  // Lifetime GROSS earnings from sales (full prompt prices, withdrawal fee at payout).
  const totalEarnings = sales.reduce((sum, s) => sum + (Number(s.priceInr) || 0), 0);
  const salesCount = sales.length;

  const withdrawnInr = payoutRows
    .filter((p) => ['processing', 'paid'].includes(p.status))
    .reduce((sum, p) => sum + (Number(p.amountInr) || 0), 0);
  const pendingPayouts = payoutRows
    .filter((p) => p.status === 'pending')
    .reduce((sum, p) => sum + (Number(p.amountInr) || 0), 0);

  // Current earnings balance in the wallet.
  const earningsBalance = wallet.balances?.earnings?.amountInr ?? 0;

  return {
    totalEarnings,
    salesCount,
    withdrawnInr,
    pendingPayouts,
    balanceInr: earningsBalance, // wallet earnings, already net of pending payout reservations
    withdrawableBalance: elig.withdrawableBalance, // what can actually be withdrawn now
    minWithdrawalInr: elig.minWithdrawalInr,
    withdrawalEligible: elig.eligible,
    withdrawalBlockers: elig.blockers,
    currency: elig.currency,
  };
}