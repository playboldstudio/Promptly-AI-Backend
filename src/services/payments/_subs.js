import { COLS, findByPk, queryAll } from '../../db/firestoreRepo.js';

/**
 * Shared helpers for reading a user's current subscription (with plan embedded).
 */

/**
 * The user's current ACTIVE subscription, newest first. Returns null when absent.
 * The `plan` object is embedded for fee-percent reads.
 */
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
