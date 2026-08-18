import { COLS, findByPk } from '../../db/firestoreRepo.js';

/**
 * Built-in plan definitions — the app's source of truth when the
 * `subscription_plans` docs haven't been seeded (e.g. a fresh live DB).
 * Keeps publish limits, paid-posting, and platform fees working everywhere
 * without depending on DB config being present.
 */
export const BUILTIN_PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceInr: 0,
    billingCycle: 'monthly',
    dailyPostLimit: 3,
    canPostPaid: false,
    platformFeePercent: 0,
    isActive: true,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceInr: 49,
    billingCycle: 'monthly',
    dailyPostLimit: null, // unlimited
    canPostPaid: true,
    platformFeePercent: 5,
    isActive: true,
  },
  creator: {
    id: 'creator',
    name: 'Creator',
    priceInr: 99,
    billingCycle: 'monthly',
    dailyPostLimit: null, // unlimited
    canPostPaid: true,
    platformFeePercent: 0,
    isActive: true,
  },
};

/** Plan doc from Firestore, falling back to the built-in definition. */
export async function planById(planId) {
  if (!planId) return null;
  const dbPlan = await findByPk(COLS.subscriptionPlans, planId);
  return dbPlan ?? BUILTIN_PLANS[planId] ?? null;
}