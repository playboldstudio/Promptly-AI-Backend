/**
 * Derived prompt flags — the design doc (§4) says avoid stored flags:
 *   is_trending ⟵ engagement (view_count + save_count) above a threshold
 *   is_new      ⟵ created_at within a freshness window
 * Both are computed at read time so they can never drift from the underlying data.
 */

const TRENDING_ENGAGEMENT_THRESHOLD = 100; // view_count + save_count
const NEW_WINDOW_DAYS = 7;
const NEW_WINDOW_MS = NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * @param {object} prompt raw Prompt row (fields: viewCount, saveCount, createdAt)
 * @returns {{ isTrending: boolean, isNew: boolean }}
 */
export function derivePromptFlags(prompt) {
  const engagement =
    Number(prompt.viewCount ?? 0) + Number(prompt.saveCount ?? 0);
  const ageMs = Date.now() - new Date(prompt.createdAt).getTime();

  return {
    isTrending: engagement >= TRENDING_ENGAGEMENT_THRESHOLD,
    isNew: ageMs >= 0 && ageMs <= NEW_WINDOW_MS,
  };
}
