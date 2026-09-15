import {
  COLS,
  findByPk,
  queryAll,
  getMany,
  upsert,
  removeMany,
  countDocuments,
} from '../db/firestoreRepo.js';
import { firebaseAuth } from '../db/firestore.js';
import { currentActiveSubscriptionWithPlan, hasAdFreeAccess } from './payments/subscription-utils.js';
import { cancelActiveSubscription } from './payments/subscriptions.service.js';
import { isAdminEmail } from '../config/env.js';

export async function getProfile(userId) {
  const [subscription, kyc, adFree] = await Promise.all([
    currentActiveSubscriptionWithPlan(userId),
    findByPk(COLS.kycVerifications, userId),
    hasAdFreeAccess(userId),
  ]);

  return {
    subscription: subscription
      ? { ...subscription }
      : null,
    kycStatus: kyc?.status ?? 'not_submitted',
    adFree,
  };
}

export async function getMyPrompts(userId, { limit = 50, offset = 0 } = {}) {
  const [page, total] = await Promise.all([
    queryAll({
      collection: COLS.prompts,
      filters: [{ field: 'authorId', value: userId }],
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
      offset,
    }),
    countDocuments(COLS.prompts, [{ field: 'authorId', value: userId }]),
  ]);
  const prompts = page.rows;
  return { prompts, total: total ?? prompts.length };
}

export async function getSavedPrompts(userId, { limit = 50, offset = 0 } = {}) {
  // Order newest-saved first (savedAt desc) — pagination is server-side now.
  const [page, total] = await Promise.all([
    queryAll({
      collection: COLS.savedPrompts,
      filters: [{ field: 'userId', value: userId }],
      orderBy: { field: 'savedAt', direction: 'desc' },
      limit,
      offset,
    }),
    countDocuments(COLS.savedPrompts, [{ field: 'userId', value: userId }]),
  ]);
  const rows = page.rows;

  const promptIds = rows.map((r) => r.promptId).filter(Boolean);
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

  const saved = rows.map((row) => {
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

  return { saved, total: total ?? saved.length };
}

export async function getPurchasedPrompts(userId, { limit = 50, offset = 0 } = {}) {
  const page = await queryAll({
    collection: COLS.promptPurchases,
    filters: [{ field: 'buyerId', value: userId }, { field: 'status', value: 'completed' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit,
    offset,
  });
  const rows = page.rows;

  const promptIds = rows.map((r) => r.promptId).filter(Boolean);
  const prompts = promptIds.length ? await getMany(COLS.prompts, promptIds) : {};

  // Only *real* prompt unlocks belong here. The prompt_purchases collection also
  // holds deposit top-ups (promptId = 'deposit_s'…) and ad-free (promptId =
  // 'ad_free') rows — those aren't prompts, so drop any row whose promptId isn't
  // an existing prompts doc (or where authorId is null — no creator to credit).
  const purchases = rows
    .filter((row) => prompts[row.promptId] || row.authorId)
    .map((row) => {
      const prompt = prompts[row.promptId];
      return {
        purchaseId: row.id,
        purchasedAt: row.createdAt,
        priceInr: Number(row.priceInr) || 0,
        // The buyer owns the prompt — always return the full unlocked body.
        prompt: prompt ? { ...prompt, unlocked: true, savedByMe: false } : null,
      };
    });

  // `total` reflects the filtered prompt-purchase rows actually returned; the
  // raw prompt_purchases count includes unrelated top-up/ad-free rows, so it
  // would overstate the app's "purchased prompts" count.
  return { purchases, total: purchases.length };
}

/**
 * The user's deposit top-up history (one per deposit pack purchased).
 * Same prompt_purchases collection, but only the `deposit_*` rows.
 */
export async function getTopUpHistory(userId, { limit = 100, offset = 0 } = {}) {
  const page = await queryAll({
    collection: COLS.promptPurchases,
    filters: [{ field: 'buyerId', value: userId }, { field: 'status', value: 'completed' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit,
    offset,
  });

  // A deposit row has promptId = 'deposit_s/m/l/xl' and a null/absent authorId
  // (no creator is credited on a top-up). Exclude prompt unlocks + ad-free.
  const DEPOSITS = /^deposit_/;
  const rows = page.rows.filter(
    (r) => DEPOSITS.test(r.promptId ?? '') && (r.authorId == null),
  );

  return {
    topups: rows.map((r) => ({
      id: r.id,
      productId: r.promptId,
      priceInr: Number(r.priceInr) || 0,
      gatewayFeeInr: Number(r.gatewayFeeInr) || 0,
      netDepositInr: Number(r.priceInr) - (Number(r.gatewayFeeInr) || 0),
      bonusCreditInr: Number(r.gatewayFeeInr) || 0, // fee recycled as bonus
      status: r.status,
      createdAt: r.createdAt,
    })),
    total: rows.length,
  };
}

export async function getTransactions(userId, { limit = 50, offset = 0 } = {}) {
  const [page, total] = await Promise.all([
    queryAll({
      collection: COLS.transactions,
      filters: [{ field: 'userId', value: userId }],
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
      offset,
    }),
    countDocuments(COLS.transactions, [{ field: 'userId', value: userId }]),
  ]);
  const transactions = page.rows;
  return { transactions, total: total ?? transactions.length };
}

export async function setUpiId(userId, upiId) {
  await upsert(COLS.users, userId, { upiId, updatedAt: new Date() });
  return findByPk(COLS.users, userId);
}

/**
 * The creator's saved bank-transfer payout details (withdrawal screen).
 * Returns just the fields the UI needs — never the full user row.
 */
export async function getBankDetails(userId) {
  const user = await findByPk(COLS.users, userId);
  return {
    bankDetails: user
      ? {
          panNumber: user.panNumber ?? null,
          panImageUrl: user.panImageUrl ?? null,
          bankHolderName: user.bankHolderName ?? null,
          bankAccountNumber: user.bankAccountNumber ?? null,
          bankIfsc: user.bankIfsc ?? null,
          bankBranch: user.bankBranch ?? null,
          bankAccountImageUrl: user.bankAccountImageUrl ?? null,
          complete: Boolean(
            user.panNumber &&
              user.panImageUrl &&
              user.bankHolderName &&
              user.bankAccountNumber &&
              user.bankIfsc &&
              user.bankBranch &&
              user.bankAccountImageUrl,
          ),
        }
      : null,
  };
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

  // Clean up the user's saved prompts (bounded, chunked fan-out).
  try {
    const saved = await queryAll({
      collection: COLS.savedPrompts,
      filters: [{ field: 'userId', value: userId }],
      fieldMask: ['id'],
      limit: 10000,
    });
    await removeMany(COLS.savedPrompts, saved.rows.map((s) => s.id));
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
