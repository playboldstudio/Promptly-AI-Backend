import { ImageAnnotatorClient } from '@google-cloud/vision';

/**
 * Server-side NSFW / adult-image moderation via Google Cloud Vision SafeSearch.
 *
 * Used on user prompt-image uploads (POST /prompts/image). Admin bulk imports
 * are exempt — admins are trusted curators.
 *
 * Returns { safe: true } or { safe: false, reason } with a human-readable
 * rejection reason so the caller can surface it in the 4xx response.
 */

let client = null;
function getClient() {
  if (!client) client = new ImageAnnotatorClient();
  return client;
}

/** Likelihood values returned by the Vision API, ascending severity. */
const SEVERITY = ['UNKNOWN', 'VERY_UNLIKELY', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'VERY_LIKELY'];

/** Threshold — reject when adult or racy is at or above this level. */
const REJECT_LEVEL = 'LIKELY'; // index 4 in SEVERITY

function isAtOrAbove(level, threshold) {
  return SEVERITY.indexOf(level) >= SEVERITY.indexOf(threshold);
}

/**
 * Moderate a raw image buffer.
 * @param {Buffer} buffer   — raw image bytes (JPEG/PNG/WebP/etc.)
 * @param {string} mimeType — e.g. 'image/jpeg'
 * @returns {{ safe: boolean, reason?: string }}
 */
export async function moderateImage(buffer, mimeType = 'image/jpeg') {
  const [result] = await getClient().annotateImage({
    image: { content: buffer.toString('base64') },
    features: [{ type: 'SAFE_SEARCH_DETECTION' }],
  });

  const ss = result.safeSearchAnnotation;
  if (!ss) return { safe: true };

  const flags = [];
  if (isAtOrAbove(ss.adult, REJECT_LEVEL)) flags.push('adult');
  if (isAtOrAbove(ss.racy, REJECT_LEVEL)) flags.push('racy');

  if (flags.length) {
    return {
      safe: false,
      reason: `Image flagged as ${flags.join(' and ')} content (not allowed on user uploads)`,
    };
  }

  return { safe: true };
}
