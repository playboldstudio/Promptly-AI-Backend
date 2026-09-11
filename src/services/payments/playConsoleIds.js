/**
 * Play Console product/plan ID mapping.
 *
 * The Android app purchases Google Play products by the real strings configured
 * in Play Console (e.g. `playbold-promptly-pro-monthly`, `playbold.promptly.ad`).
 * The backend's internal code, ledger, and dispatch logic use short internal ids
 * (`pro`, `ad_free`, `deposit_s`, …). This module is the single bridge between
 * the two: incoming `productId` values from the app / Play Console are mapped to
 * internal ids so all existing money + entitlement logic stays untouched, while
 * Google API calls (verify / acknowledge) use the real console ids.
 *
 * Keep this table in sync with Google Play Console + the Android app.
 */

/** Map a real Play Console productId → the backend's internal id. */
export const PLAY_CONSOLE_TO_INTERNAL = {
  'playbold-promptly-pro-monthly': 'pro',
  'playbold-promptly-pro-yearly': 'pro_annual',
  'playbold-promptly-creator-monthly': 'creator',
  'playbold-promptly-creator-yearly': 'creator_annual',
  'playbold.promptly.ad': 'ad_free',
  'playbold.promptly.deposit_s': 'deposit_s',
  'playbold.promptly.deposit_m': 'deposit_m',
  'playbold.promptly.deposit_l': 'deposit_l',
  'playbold.promptly.deposit_xl': 'deposit_xl',
};

/** Reverse map: internal id → real Play Console id (for Google API calls). */
export const INTERNAL_TO_PLAY_CONSOLE = Object.fromEntries(
  Object.entries(PLAY_CONSOLE_TO_INTERNAL).map(([external, internal]) => [internal, external]),
);

/**
 * Resolve a raw productId from the app/Play Console to the backend internal id.
 * Values already internal (e.g. dynamic `prompt_<id>` unlocks) pass through
 * unchanged.
 */
export function internalProductId(rawProductId) {
  return PLAY_CONSOLE_TO_INTERNAL[rawProductId] ?? rawProductId;
}

/**
 * Resolve the Play Console id to use for Google API calls given an internal id.
 * Unknown ids (e.g. dynamic prompt unlocks) pass through as-is.
 */
export function playConsoleProductId(internalId) {
  return INTERNAL_TO_PLAY_CONSOLE[internalId] ?? internalId;
}