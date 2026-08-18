import {
  COLS,
  findByPk,
  queryAll,
  getMany,
  upsert,
  remove,
} from '../db/firestoreRepo.js';
import { firebaseAuth } from '../db/firestore.js';
import { currentActiveSubscriptionWithPlan } from './payments/subscription-utils.js';
import { cancelActiveSubscription } from './payments/subscriptions.service.js';
import { isAdminEmail } from '../config/env.js';

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
  // unlock when free, the viewer is the author, they have a completed purchase,
  // or they are a platform admin (full access — no purchase needed).
  const viewer = await findByPk(COLS.users, userId);
  const isAdmin = viewer && isAdminEmail(viewer.email);
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
      isAdmin ||
      !prompt ||
      !json.isPaid ||
      (json.authorId && json.authorId === userId) ||
      unlockedIds.has(json.id);
    if (!unlocked) delete json.promptText;
    return {
      ...row,
      prompt: {
        ...json,
        images: Array.isArray(json.images) && json.images.length ? json.images : json.imageUrl ? [json.imageUrl] : [],
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

/**
 * Remove the creator's bank-transfer payout details from their profile.
 * KYC documents are wiped too; they can re-add them before the next withdrawal.
 */
export async function clearBankDetails(userId) {
  await upsert(COLS.users, userId, {
    panNumber: null,
    bankHolderName: null,
    bankAccountNumber: null,
    bankIfsc: null,
    bankBranch: null,
    panImageUrl: null,
    bankAccountImageUrl: null,
    updatedAt: new Date(),
  });
  return findByPk(COLS.users, userId);
}

/**
 * Delete the signed-in user's account. Financial rows (purchases, ledger,
 * payouts) keep their author/buyer references for the audit trail, so the
 * profile is soft-deleted and PII redacted; the Firebase Auth account is also
 * removed so the user can no longer sign in. Best-effort: cancels any active
 * subscription first and cleans up saved prompts.
 */
export async function deleteAccount(userId) {
  // Stop the active subscription (if any) so renewals don't keep billing.
  try {
    await cancelActiveSubscription(userId);
  } catch {
    // non-fatal — cancellation is best-effort on account removal
  }

  // Clean up the user's saved prompts.
  try {
    const saved = await queryAll({
      collection: COLS.savedPrompts,
      filters: [{ field: 'userId', value: userId }],
      limit: 10000,
    });
    await Promise.all(saved.rows.map((s) => remove(COLS.savedPrompts, s.id)));
  } catch {
    // non-fatal
  }

  // Soft-delete the profile — financial references (userId/authorId on
  // purchases, ledger, payouts) must keep resolving for the audit trail.
  await upsert(COLS.users, userId, {
    deleted: true,
    deletedAt: new Date(),
    email: null,
    fullName: 'Deleted User',
    bio: null,
    avatarUrl: null,
    upiId: null,
    panNumber: null,
    bankHolderName: null,
    bankAccountNumber: null,
    bankIfsc: null,
    bankBranch: null,
    panImageUrl: null,
    bankAccountImageUrl: null,
    authProviderId: null,
    updatedAt: new Date(),
  });

  // Remove the Firebase Auth account so sign-in fails for this user. Wrapped —
  // the soft-delete above is the source of truth; auth removal is best-effort.
  try {
    await firebaseAuth.deleteUser(userId);
  } catch {
    // non-fatal
  }

  return { success: true };
}
