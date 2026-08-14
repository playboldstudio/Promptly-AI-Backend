import { COLS, findByPk, queryAll } from '../../db/firestoreRepo.js';

export async function currentActiveSubscriptionWithPlan(userId) {
  const { rows } = await queryAll({
    collection: COLS.userSubscriptions,
    filters: [{ field: 'userId', value: userId }, { field: 'status', value: 'active' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 1,
  });
  const sub = rows[0];
  if (!sub) return null;
  const plan = await findByPk(COLS.subscriptionPlans, sub.planId);
  return { ...sub, plan: plan ?? null };
}
