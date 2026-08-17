import {
  COLS,
  findByPk,
  queryAll,
  getMany,
  upsert,
} from '../db/firestoreRepo.js';
import { currentActiveSubscriptionWithPlan } from './payments/subscription-utils.js';

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

export async function getPurchasedPrompts(userId, { limit = 50, offset = 0 } = {}) {
  const all = await queryAll({
    collection: COLS.promptPurchases,
    filters: [{ field: 'buyerId', value: userId }, { field: 'status', value: 'completed' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 10000,
  });
  const page = all.rows.slice(offset, offset + limit);

  const promptIds = page.map((r) => r.promptId).filter(Boolean);
  const prompts = promptIds.length ? await getMany(COLS.prompts, promptIds) : {};

  const purchases = page.map((row) => {
    const prompt = prompts[row.promptId];
    return {
      purchaseId: row.id,
      purchasedAt: row.createdAt,
      priceInr: Number(row.priceInr) || 0,
      // The buyer owns the prompt — always return the full unlocked body.
      prompt: prompt ? { ...prompt, unlocked: true, savedByMe: false } : null,
    };
  });

  return { purchases, total: all.rows.length };
}

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

export async function setUpiId(userId, upiId) {
  await upsert(COLS.users, userId, { upiId, updatedAt: new Date() });
  return findByPk(COLS.users, userId);
}

/** Save the creator's bank-transfer payout details onto their profile. */
export async function setBankDetails(userId, fields) {
  await upsert(COLS.users, userId, { ...fields, updatedAt: new Date() });
  return findByPk(COLS.users, userId);
}

export async function updateProfile(userId, patch) {
  const fields = {};
  if (patch.fullName !== undefined) fields.fullName = patch.fullName;
  if (patch.bio !== undefined) fields.bio = patch.bio;
  if (patch.avatarUrl !== undefined) fields.avatarUrl = patch.avatarUrl;
  if (patch.upiId !== undefined) fields.upiId = patch.upiId;
  fields.updatedAt = new Date();
  await upsert(COLS.users, userId, fields);
  return findByPk(COLS.users, userId);
}
