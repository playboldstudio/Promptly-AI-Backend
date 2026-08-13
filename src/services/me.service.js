import {
  Prompt,
  PromptPurchase,
  Transaction,
  UserSubscription,
  SavedPrompt,
  KycVerification,
} from '../db/models.js';

/**
 * Profile for the signed-in user: profile fields + current subscription + KYC state.
 */
export async function getProfile(userId) {
  const [subscription, kyc] = await Promise.all([
    UserSubscription.findOne({
      where: { userId, status: 'active' },
      order: [['createdAt', 'DESC']],
      include: [{ association: 'plan' }],
    }),
    KycVerification.findOne({ where: { userId } }),
  ]);

  return {
    subscription: subscription ? { ...subscription.toJSON(), plan: subscription.plan } : null,
    kycStatus: kyc?.status ?? 'not_submitted',
  };
}

/**
 * Prompts the user has published (their catalog rows). Maps to the UI "My Prompts".
 */
export async function getMyPrompts(userId, { limit = 50, offset = 0 } = {}) {
  const { rows, count } = await Prompt.findAndCountAll({
    where: { authorId: userId },
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });
  return { prompts: rows, total: count };
}

/**
 * Prompts the user has saved (join table → prompt rows). Maps to the UI "Saved".
 */
export async function getSavedPrompts(userId, { limit = 50, offset = 0 } = {}) {
  const { rows, count } = await SavedPrompt.findAndCountAll({
    where: { userId },
    include: [{ association: 'prompt' }],
    order: [['savedAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  // Gate the paid prompt body the same way the prompt feed/detail do:
  // unlock when free, the viewer is the author, or they have a completed purchase.
  const promptIds = rows.map((r) => r.promptId).filter(Boolean);
  const purchases =
    promptIds.length === 0
      ? []
      : await PromptPurchase.findAll({
          where: { buyerId: userId, promptId: promptIds, status: 'completed' },
        });
  const unlockedIds = new Set(purchases.map((p) => p.promptId));

  const saved = rows.map((row) => {
    const prompt = row.prompt;
    const json = prompt ? prompt.toJSON() : {};
    const unlocked =
      !prompt ||
      !json.isPaid ||
      (json.authorId && json.authorId === userId) ||
      unlockedIds.has(json.id);
    if (!unlocked) delete json.promptText;
    return {
      ...row.toJSON(),
      prompt: {
        ...json,
        savedByMe: true,
        unlocked,
      },
    };
  });

  return { saved, total: count };
}

/**
 * The My Account ledger — one row per transaction, newest first.
 */
export async function getTransactions(userId, { limit = 50, offset = 0 } = {}) {
  const { rows, count } = await Transaction.findAndCountAll({
    where: { userId },
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });
  return { transactions: rows, total: count };
}
