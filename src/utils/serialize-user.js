/**
 * Public-facing user / subscription serializers.
 *
 * These are the ONLY shapes a client should ever receive, replacing the old
 * habit of spreading the raw `users` / `user_subscriptions` docs — which was
 * leaking bank/PAN/KYC PII and the raw Google Play purchase token
 * (`gatewaySubscriptionId`) into API responses.
 *
 * KYC / bank details remain reachable via `GET /me/bank` only.
 */

import { isAdminEmail } from '../config/env.js';

export function serializeUser(user) {
  if (!user) return null;
  const isAdmin = Boolean(user.email && isAdminEmail(user.email));
  return {
    id: user.id,
    fullName: user.fullName ?? null,
    bio: user.bio ?? null,
    avatarUrl: user.avatarUrl ?? null,
    email: user.email ?? null,
    role: isAdmin ? 'admin' : (user.role ?? 'viewer'),
    isAdmin,
    adFree: Boolean(user.adFree),
  };
}

/**
 * Trimmed subscription for the profile payload. Never emits the doc id
 * (`sub_<purchaseToken>`), `gateway` or `gatewaySubscriptionId` — the raw
 * Google Play purchase token must not leave the backend.
 */
export function serializeSubscription(sub) {
  if (!sub) return null;
  return {
    planId: sub.planId ?? null,
    planName: sub.plan?.name ?? null,
    status: sub.status ?? null,
    billingCycle: sub.plan?.billingCycle ?? null,
    currentPeriodStart: sub.currentPeriodStart ?? null,
    currentPeriodEnd: sub.currentPeriodEnd ?? null,
    perks: sub.plan?.perks ?? [],
    platformFeePercent: sub.plan?.platformFeePercent ?? null,
    canPostPaid: sub.plan?.canPostPaid ?? false,
    adminPerk: Boolean(sub.adminPerk),
  };
}