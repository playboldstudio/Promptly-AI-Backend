import { COLS, findByPk, queryAll } from '../../db/firestoreRepo.js';
import { isAdminEmail } from '../../config/env.js';
import { planById } from './plans.js';

export async function currentActiveSubscriptionWithPlan(userId) {
  const user = await findByPk(COLS.users, userId);

  // Admins always hold an active Creator subscription — full platform access
  // regardless of any real (test/live) subscription state. This unlocks paid
  // publishing, unlimited posting, 0% platform fee, and paid-prompt access.
  if (user && isAdminEmail(user.email)) {
    const creatorPlan = await planById('creator');
    return {
      id: `admin_creator_${userId}`,
      userId,
      planId: 'creator',
      status: 'active',
      razorpaySubId: null,
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
