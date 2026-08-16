const TRENDING_ENGAGEMENT_THRESHOLD = 100;
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function derivePromptFlags(prompt) {
  const engagement =
    Number(prompt.viewCount ?? 0) + Number(prompt.saveCount ?? 0);
  const ageMs = Date.now() - new Date(prompt.createdAt).getTime();

  return {
    isTrending: engagement >= TRENDING_ENGAGEMENT_THRESHOLD,
    isNew: ageMs >= 0 && ageMs <= NEW_WINDOW_MS,
  };
}
