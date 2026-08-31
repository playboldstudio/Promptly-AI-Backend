/**
 * Shared pagination parsing + result assembly.
 *
 * Every list endpoint reads `limit`/`offset` from the query string the same way;
 * centralising it keeps the clamps consistent and removes copy-paste across
 * routes. `offset` pagination is fine at this scale (Firestore `offset()` only
 * documents a start position — rows before it are not transferred).
 */

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;

/** Parse + clamp `limit` (max 100, default 50) and `offset` (min 0). */
export function parsePaging(query = {}) {
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 1 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}