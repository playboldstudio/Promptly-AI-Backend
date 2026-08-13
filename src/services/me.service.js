import {
  COLS,
  findByPk,
  queryAll,
  getMany,
  upsert,
} from '../db/firestoreRepo.js';
import { currentActiveSubscriptionWithPlan } from './payments/_subs.js';

/**
 * Profile for the signed-in user: profile fields + current subscription + KYC state.
 */
export async function getProfile(userId) {
  const [subscription, kyc] = await Promise.all([
    currentActiveSubscriptionWithPlan(userId),
    findByPk(COLS.kycVerifications, userId),
  ]);

  return {
    subscription: subscription
      ? { ...subscription }
      : null,
    kycStatus: kyc?.status ?? 'not_submitted',
  };
}

/**
 * Prompts the user has published (their catalog rows). Maps to the UI "My Prompts".
 */
export async function getMyPrompts(userId, { limit = 50, offset = 0 } = {}) {
  const all = await queryAll({
    collection: COLS.prompts,
    filters: [{ field: 'authorId', value: userId }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 10000,
  });
  const prompts = all.rows.slice(offset, offset + limit);
  return { prompts, total: all.rows.length };
}

/**
 * Prompts the user has saved (join table → prompt rows). Maps to the UI "Saved".
 */
export async function getSavedPrompts(userId, { limit = 50, offset = 0 } = {}) {
  const all = await queryAll({
    collection: COLS.savedPrompts,
    filters: [{ field: 'userId', value: userId }],
    limit: 10000,
  });
  // Order newest-saved first (savedAt desc) to match the old ORDER BY.
  const sorted = all.rows.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  const page = sorted.slice(offset, offset + limit);

  const promptIds = page.map((r) => r.promptId).filter(Boolean);
  const prompts = promptIds.length ? await getMany(COLS.prompts, promptIds) : {};

  // Gate the paid prompt body the same way the prompt feed/detail do:
  // unlock when free, the viewer is the author, or they have a completed purchase.
  const unlockedQuery = await queryAll({
    collection: COLS.promptPurchases,
    filters: [{ field: 'buyerId', value: userId }, { field: 'status', value: 'completed' }],
    limit: 10000,
  });
  const unlockedIds = new Set(unlockedQuery.rows.map((p) => p.promptId));

  const saved = page.map((row) => {
    const prompt = prompts[row.promptId];
    const json = prompt ? { ...prompt } : {};
    const unlocked =
      !prompt ||
      !json.isPaid ||
      (json.authorId && json.authorId === userId) ||
      unlockedIds.has(json.id);
    if (!unlocked) delete json.promptText;
    return {
      ...row,
      prompt: {
        ...json,
        savedByMe: true,
        unlocked,
      },
    };
  });

  return { saved, total: sorted.length };
}

/**
 * The My Account ledger — one row per transaction, newest first.
 */
export async function getTransactions(userId, { limit = 50, offset = 0 } = {}) {
  const all = await queryAll({
    collection: COLS.transactions,
    filters: [{ field: 'userId', value: userId }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 10000,
  });
  const transactions = all.rows.slice(offset, offset + limit);
  return { transactions, total: all.rows.length };
}

/**
 * Save the user's UPI payout destination on their profile.
 */
export async function setUpiId(userId, upiId) {
  await upsert(COLS.users, userId, { upiId, updatedAt: new Date() });
  return findByPk(COLS.users, userId);
}
