import { Op } from 'sequelize';
import { Prompt, PromptPurchase, Payout, Transaction } from '../db/models.js';
import { sequelize } from '../db/config.js';

/**
 * Creator earnings — everything derived from prompt_purchases + payouts + ledger.
 *
 * Money model:
 *   Buyer ──(₹, Checkout)──► Platform pool
 *                              │  net = price × (100 − fee%) / 100
 *                              ▼
 *                       Creator balance
 *                              │  withdraw (min ₹60)
 *                              ▼
 *                       Creator's bank
 *
 * All amounts are integer rupees.
 */

// Only non-refunded sales count toward earnings.
const SALE_WHERE = { status: 'completed' };

/**
 * Per-prompt breakdown for a creator, newest prompts first.
 * totalInr      — sum of net_inr across completed sales of that prompt
 * salesCount    — number of completed sales
 * promptTitle   — denormalized title for the UI (authorId match)
 */
export async function getEarningsByPrompt(authorId) {
  const rows = await PromptPurchase.findAll({
    where: { ...SALE_WHERE, authorId },
    attributes: [
      'promptId',
      [sequelize.fn('SUM', sequelize.col('net_inr')), 'totalInr'],
      [sequelize.fn('COUNT', sequelize.col('id')), 'salesCount'],
    ],
    group: ['promptId'],
    raw: true,
  });

  const promptIds = rows.map((r) => r.promptId);
  const prompts = promptIds.length
    ? await Prompt.findAll({ where: { id: { [Op.in]: promptIds } }, attributes: ['id', 'title'] })
    : [];

  const titleById = new Map(prompts.map((p) => [p.id, p.title]));

  return rows.map((r) => ({
    promptId: r.promptId,
    title: titleById.get(r.promptId) ?? 'Unknown prompt',
    totalInr: Number(r.totalInr) || 0,
    salesCount: Number(r.salesCount) || 0,
  }));
}

/**
 * Earnings summary for a creator:
 *   totalEarnings  — lifetime net from completed sales
 *   withdrawnInr   — sum of completed/processing/paid payout amounts
 *   pendingPayouts — sum of payouts still pending
 *   balanceInr     — available = lifetime ledger balance (credits − debits)
 *   salesCount     — completed sales count
 */
export async function getEarningsSummary(authorId) {
  const [sales, payoutRows, ledger] = await Promise.all([
    PromptPurchase.findAll({
      where: { ...SALE_WHERE, authorId },
      attributes: [
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('net_inr')), 0), 'totalNetInr'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'salesCount'],
      ],
      raw: true,
    }),
    Payout.findAll({
      where: { userId: authorId },
      attributes: ['status', 'amountInr'],
      raw: true,
    }),
    Transaction.findAll({
      where: { userId: authorId },
      attributes: ['direction', 'amountInr'],
      raw: true,
    }),
  ]);

  const totalEarnings = Number(sales[0]?.totalNetInr) || 0;
  const salesCount = Number(sales[0]?.salesCount) || 0;

  const withdrawnInr = payoutRows
    .filter((p) => ['processing', 'paid'].includes(p.status))
    .reduce((sum, p) => sum + p.amountInr, 0);
  const pendingPayouts = payoutRows
    .filter((p) => p.status === 'pending')
    .reduce((sum, p) => sum + p.amountInr, 0);

  // Ledger balance is the source of truth for "available": credits − debits.
  const balanceInr = ledger.reduce((sum, t) => {
    const signed = t.direction === 'credit' ? t.amountInr : -t.amountInr;
    return sum + signed;
  }, 0);

  return {
    totalEarnings,
    salesCount,
    withdrawnInr,
    pendingPayouts,
    balanceInr, // what the creator can withdraw (subject to min ₹60 + saved UPI)
  };
}
