import { COLS, findByPk } from '../../db/firestoreRepo.js';

/**
 * Built-in plan definitions — the app's source of truth when the
 * `subscription_plans` docs haven't been seeded (e.g. a fresh live DB).
 * Keeps publish limits, paid-posting, and platform fees working everywhere
 * without depending on DB config being present.
 *
 * Each plan carries a `perks` array listing included entitlements. The
 * verify-route and subscription-utils use this to grant perks on activation.
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
    perks: [],
    isActive: true,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceInr: 99,
    billingCycle: 'monthly',
    dailyPostLimit: null, // unlimited
    canPostPaid: true,
    platformFeePercent: 15,
    perks: ['ad_free'],
    isActive: true,
  },
  pro_annual: {
    id: 'pro_annual',
    name: 'Pro (Annual)',
    priceInr: 999,
    billingCycle: 'annual',
    dailyPostLimit: null,
    canPostPaid: true,
    platformFeePercent: 15,
    perks: ['ad_free'],
    isActive: true,
  },
  creator: {
    id: 'creator',
    name: 'Creator',
    priceInr: 199,
    billingCycle: 'monthly',
    dailyPostLimit: null, // unlimited
    canPostPaid: true,
    platformFeePercent: 5,
    perks: ['ad_free'],
    isActive: true,
  },
  creator_annual: {
    id: 'creator_annual',
    name: 'Creator (Annual)',
    priceInr: 1999,
    billingCycle: 'annual',
    dailyPostLimit: null,
    canPostPaid: true,
    platformFeePercent: 5,
    perks: ['ad_free'],
    isActive: true,
  },
};

/**
 * Map a Play Billing productId to the internal plan it activates.
 * Handles both monthly and annual subscription SKUs.
 */
export const PRODUCT_TO_PLAN = {
  pro: 'pro',
  pro_annual: 'pro_annual',
  creator: 'creator',
  creator_annual: 'creator_annual',
};

/** Resolve the base plan tier (pro/creator) from any plan id. */
export function basePlanTier(planId) {
  if (!planId) return null;
  if (planId.startsWith('pro')) return 'pro';
  if (planId.startsWith('creator')) return 'creator';
  return null;
}

/** Plan doc from Firestore, falling back to the built-in definition. */
export async function planById(planId) {
  if (!planId) return null;
  const dbPlan = await findByPk(COLS.subscriptionPlans, planId);
  return dbPlan ?? BUILTIN_PLANS[planId] ?? null;
}