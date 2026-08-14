import { COLS, queryAll, getMany } from '../db/firestoreRepo.js';
import { balanceFor } from './ledger.js';

/**
 * Creator earnings — derived from prompt_purchases + payouts + ledger.
 * All amounts are integer rupees.
 */

export async function getEarningsByPrompt(authorId) {
  const { rows } = await queryAll({
    collection: COLS.promptPurchases,
    filters: [{ field: 'authorId', value: authorId }, { field: 'status', value: 'completed' }],
  });

  const byPrompt = new Map();
  rows.forEach((r) => {
    const entry = byPrompt.get(r.promptId) ?? { totalInr: 0, salesCount: 0 };
    entry.totalInr += Number(r.netInr) || 0;
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
 * Earnings summary: lifetime net, withdrawn, pending payouts, available balance.
 */
export async function getEarningsSummary(authorId) {
  const [sales, payoutRows, balance] = await Promise.all([
    queryAll({
      collection: COLS.promptPurchases,
      filters: [{ field: 'authorId', value: authorId }, { field: 'status', value: 'completed' }],
    }),
    queryAll({ collection: COLS.payouts, filters: [{ field: 'userId', value: authorId }] }),
    balanceFor(authorId),
  ]);

  const totalEarnings = sales.rows.reduce((sum, s) => sum + (Number(s.netInr) || 0), 0);
  const salesCount = sales.rows.length;

  const withdrawnInr = payoutRows.rows
    .filter((p) => ['processing', 'paid'].includes(p.status))
    .reduce((sum, p) => sum + (Number(p.amountInr) || 0), 0);
  const pendingPayouts = payoutRows.rows
    .filter((p) => p.status === 'pending')
    .reduce((sum, p) => sum + (Number(p.amountInr) || 0), 0);

  return {
    totalEarnings,
    salesCount,
    withdrawnInr,
    pendingPayouts,
    balanceInr: balance, // what the creator can withdraw (subject to min ₹60 + saved UPI)
  };
}
