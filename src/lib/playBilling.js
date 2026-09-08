import { google } from 'googleapis';
import { env } from '../config/env.js';

/**
 * Google Play Billing client + purchase helpers.
 *
 * Uses androidpublisher v3 to verify purchases by token, acknowledge them
 * (acknowledging prevents Google's auto-refund), and read subscription state.
 * Authentication is handled implicitly through Application Default Credentials
 * (GoogleAuth) — on Cloud Run that is the service account; locally it uses
 * GOOGLE_APPLICATION_CREDENTIALS or gcloud application-default.
 *
 * The client is created lazily so the app boots even while the API is unset
 * (payment routes respond via hasPlayBilling in the routes layer).
 */

let _androidpublisher = null;

function getClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  if (!_androidpublisher) {
    _androidpublisher = google.androidpublisher({ version: 'v3', auth });
  }
  return _androidpublisher;
}

/** Verify an in-app one-time product purchase (prompts, deposits, ad-free). */
export async function verifyOneTimePurchase({ productId, purchaseToken }) {
  const { data } = await getClient().purchases.products.get({
    packageName: env.PLAY_BILLING_PACKAGE_NAME,
    productId,
    token: purchaseToken,
  });
  return data; // purchaseState, consumptionState, token, purchaseTimeMillis, ...
}

/** Verify a subscription purchase token. */
export async function verifySubscription({ purchaseToken }) {
  const { data } = await getClient().purchases.subscriptions.get({
    packageName: env.PLAY_BILLING_PACKAGE_NAME,
    token: purchaseToken,
  });
  return data; // expiryTimeMillis, autoRenewing, cancelReason, ...
}

/** Acknowledge a purchase — required within 3 days or Google auto-refunds. */
export async function acknowledgePurchase({ productId, purchaseToken, isSubscription = false }) {
  if (isSubscription) {
    await getClient().purchases.subscriptions.acknowledge({
      packageName: env.PLAY_BILLING_PACKAGE_NAME,
      token: purchaseToken,
      requestBody: { developerPayload: '' },
    });
  } else {
    await getClient().purchases.products.acknowledge({
      packageName: env.PLAY_BILLING_PACKAGE_NAME,
      productId,
      token: purchaseToken,
      requestBody: { developerPayload: '' },
    });
  }
}

/**********************************************************************
 * Play Billing commission — Google does NOT return it in the response.
 * We calculate from public rules + track tenant tenure ourselves.    *
 **********************************************************************/
/**
 * Play Billing commission for a seller's earnings credit. For in-app
 * products it's a flat 15% (under US$1M lifetime revenue), and for
 * subscriptions it drops to 10% after 12 months of continuous tenure.
 * The commission is the platform's cost — it is tracked for reconciliation
 * but never deducted at withdrawal.
 */
export function calculatePlayBillingFee({
  salePriceInr,
  subscriberTenureMonths = 0,
  isSubscription = false,
  lifetimeRevenueUsd = 0,
}) {
  if (isSubscription) {
    const feePercent = subscriberTenureMonths <= 12 ? 15 : 10;
    return {
      feePercent,
      feeInr: Math.round((salePriceInr * feePercent) / 100),
      tenureCategory: subscriberTenureMonths <= 12 ? 'year1' : 'year2plus',
    };
  }
  const feePercent = lifetimeRevenueUsd < 1_000_000 ? 15 : 30;
  return {
    feePercent,
    feeInr: Math.round((salePriceInr * feePercent) / 100),
    revenueCategory: lifetimeRevenueUsd < 1_000_000 ? 'under1M' : 'over1M',
  };
}