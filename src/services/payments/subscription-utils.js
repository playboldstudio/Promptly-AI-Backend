import { COLS, findByPk, queryAll } from '../../db/firestoreRepo.js';
import { isAdminEmail } from '../../config/env.js';
import { planById, basePlanTier } from './plans.js';

export async function currentActiveSubscriptionWithPlan(userId) {
  const user = await findByPk(COLS.users, userId);

  // Admins always hold an active Creator subscription — full platform access
  // regardless of any real (test/live) subscription state. This unlocks paid
  // publishing, unlimited posting, 5% platform fee, and paid-prompt access.
  if (user && isAdminEmail(user.email)) {
    const creatorPlan = await planById('creator');
    return {
      id: `admin_creator_${userId}`,
      userId,
      planId: 'creator',
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      plan: creatorPlan ?? null,
      adminPerk: true,
    };
  }

  const { rows } = await queryAll({
    collection: COLS.userSubscriptions,
    filters: [{ field: 'userId', value: userId }, { field: 'status', value: 'active' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 1,
  });
  const sub = rows[0];
  if (!sub) return null;
  const plan = await planById(sub.planId);
  return { ...sub, plan: plan ?? null };
}

/**
 * Check if a user has ad-free access — either via subscription perk (Pro/Creator)
 * or via explicit ad-free purchase.
 */
export async function hasAdFreeAccess(userId) {
  const user = await findByPk(COLS.users, userId);
  if (!user) return false;

  // Admins always have full access.
  if (isAdminEmail(user.email)) return true;

  // Explicit ad-free purchase (one-time).
  if (user.adFree) return true;

  // Subscription perk — Pro and Creator (monthly + annual) include ad-free.
  const sub = await currentActiveSubscriptionWithPlan(userId);
  if (sub?.status === 'active' && sub.plan?.perks?.includes('ad_free')) return true;

  return false;
}

/**
 * Determine the effective plan tier for a user (pro / creator / null).
 * Works for both monthly and annual subscriptions.
 */
export async function effectivePlanTier(userId) {
  const sub = await currentActiveSubscriptionWithPlan(userId);
  if (!sub) return null;
  return basePlanTier(sub.planId);
}
