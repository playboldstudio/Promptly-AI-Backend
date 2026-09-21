import { google } from 'googleapis';
import { env, hasPlayBilling } from '../config/env.js';

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

/**
 * True only when Play Billing is configured (package name set). Used by the
 * verify routes to return a clear 503 instead of a raw Google 400 when the
 * package name is unset (the audit's §1.1 — config problem, not a purchase bug).
 */
export function playBillingConfigured() {
  return hasPlayBilling;
}

/** Consume a consumable one-time product (deposit packs). Required before a 2nd
 *  purchase of the same SKU, else Google returns ITEM_ALREADY_OWNED. */
export async function consumePurchase({ productId, purchaseToken }) {
  const { data } = await getClient().purchases.products.consume({
    packageName: env.PLAY_BILLING_PACKAGE_NAME,
    productId,
    token: purchaseToken,
  });
  return data;
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

/**
 * Verify a subscription purchase token.
 *
 * `subscriptionId` is the Play Console subscription SKU (e.g. `playbold-promptly-pro-monthly`)
 * — the androidpublisher `purchases.subscriptions.get` API requires it alongside
 * the purchase token. Callers pass the real console id (playConsoleProductId).
 */
export async function verifySubscription({ subscriptionId, purchaseToken }) {
  const { data } = await getClient().purchases.subscriptions.get({
    packageName: env.PLAY_BILLING_PACKAGE_NAME,
    subscriptionId,
    token: purchaseToken,
  });
  return data; // expiryTimeMillis, autoRenewing, cancelReason, ...
}

/**
 * Wrap a Google Play Billing verify call so API errors (bad token, missing
 * product, permission denied) return a clean {data:null, error:{status:400,message}}
 * instead of throwing a raw 500. Genuine server errors (network, auth) still throw.
 *
 * @param {() => Promise<T>} verifyFn
 * @returns {Promise<{data:T}|{data:null,error:{status:number,message:string}}>}
 */
export async function safeVerify(verifyFn) {
  try {
    const data = await verifyFn();
    return { data };
  } catch (e) {
    // Google API errors carry a numeric `code`/`status` (HTTP) OR a string code
    // like "Missing required parameters: subscriptionId"; both mean the purchase
    // can't be verified as-is and are the client's problem, not a server outage.
    const code = e.code ?? e.status;
    const isClientError =
      code === 400 || code === 403 || code === 404 ||
      (typeof code === 'string' && /missing|required|invalid|not ?found|forbidden|expired/i.test(code));
    if (isClientError) {
      return {
        data: null,
        error: { status: 400, message: 'Purchase not verified — the token may be invalid or expired. Please try again.' },
      };
    }
    throw e; // genuine server errors (network, auth outage) propagate → 500
  }
}

/** Acknowledge a purchase — required within 3 days or Google auto-refunds. */
async function acknowledgePurchase({ productId, purchaseToken, isSubscription = false }) {
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

/** Sleep helper for the acknowledge retry backoff. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acknowledge with a small retry/backoff — a silent ack failure lets Google
 * auto-refund the buyer in 3 days even though we already granted the
 * entitlement (money leak). If it still fails after retries the caller's
 * catch handles it (logged; never blocks the purchase response).
 */
export async function acknowledgePurchaseWithRetry(opts, { attempts = 3 } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await acknowledgePurchase(opts);
      return true;
    } catch (err) {
      if (i === attempts) throw err;
      await sleep(100 * 2 ** (i - 1));
    }
  }
  return false;
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