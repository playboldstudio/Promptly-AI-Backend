/**
 * One-time in-app product definitions (Play Billing).
 *
 * These are the consumable / non-consumable SKUs the mobile app purchases
 * outside of subscriptions. The backend dispatches by productId in the
 * verify route.
 *
 * Prices are the *list prices* in Play Console — Google's 15% commission
 * is absorbed by the platform. For deposit packs, the fee is recycled as
 * bonus credit (see wallet.md §4.5).
 */

export const ONE_TIME_PRODUCTS = {
  ad_free: {
    id: 'ad_free',
    name: 'Remove Ads (lifetime)',
    priceInr: 149,
    type: 'non_consumable',
    description: 'One-time purchase — ad-free forever',
  },
  deposit_s: {
    id: 'deposit_s',
    name: 'Deposit Pack S',
    priceInr: 10,
    type: 'consumable',
    description: 'Minimum top-up',
  },
  deposit_m: {
    id: 'deposit_m',
    name: 'Deposit Pack M',
    priceInr: 100,
    type: 'consumable',
    description: 'Standard top-up',
  },
  deposit_l: {
    id: 'deposit_l',
    name: 'Deposit Pack L',
    priceInr: 500,
    type: 'consumable',
    description: 'Mid-size top-up',
  },
  deposit_xl: {
    id: 'deposit_xl',
    name: 'Deposit Pack XL',
    priceInr: 1000,
    type: 'consumable',
    description: 'Power-user top-up',
  },
};

/** Look up a one-time product by its Play Billing productId. */
export function getOneTimeProduct(productId) {
  return ONE_TIME_PRODUCTS[productId] ?? null;
}

/** Check if a productId is a deposit pack. */
export function isDepositProduct(productId) {
  return productId?.startsWith('deposit_') && ONE_TIME_PRODUCTS[productId] != null;
}

/** Check if a productId is the ad-free SKU. */
export function isAdFreeProduct(productId) {
  return productId === 'ad_free';
}
