import { createHash } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import sharp from 'sharp';
import { adminApp } from '../db/firestore.js';
import { env } from '../config/env.js';

/**
 * Watermarked + download-protected serving for PAID prompt images.
 *
 * The raw cover lives in the public GCS bucket; this service produces a
 * watermarked webp (diagonal repeating title) and caches it back into GCS so
 * it is rendered once per image. The route that streams it adds no-download
 * headers (inline disposition, nosniff, private cache) — client-side guards
 * (context-menu/save blocking) belong in the web page that uses this endpoint.
 */

const BUCKET = env.STORAGE_BUCKET || `${env.FIREBASE_PROJECT_ID}.appspot.com`;

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

/** SVG overlay with the label tiled diagonally across the full canvas. */
function watermarkSvg(width, height, label) {
  const safe = escapeXml(label);
  const step = 260;
  const tilt = -22;
  const tiles = [];
  for (let x = -height; x < width + height; x += step) {
    for (let y = -height; y < height + step; y += step) {
      const tx = x + (y % step);
      const ty = y;
      tiles.push(`<text class="wm" x="${tx}" y="${ty}" transform="rotate(${tilt} ${tx} ${ty})">${safe}</text>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <style>.wm{font:600 26px system-ui,sans-serif;fill:rgba(255,255,255,0.22)}</style>
    ${tiles.join('')}
  </svg>`;
}

/**
 * Return a watermarked webp of the prompt cover (cached in GCS). The buffer is
 * what the route streams to the client.
 */
export async function watermarkedPromptImage({ imageUrl, label }) {
  const cacheKey = createHash('sha256')
    .update(`${imageUrl}\n${label}`)
    .digest('hex')
    .slice(0, 24);
  const bucket = getStorage(adminApp).bucket(BUCKET);
  const file = bucket.file(`watermarked/prompts/${cacheKey}.webp`);

  const [exists] = await file.exists();
  if (exists) {
    const [buf] = await file.download();
    return buf;
  }

  const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    throw Object.assign(new Error(`Failed to fetch source image (HTTP ${resp.status})`), { status: 502 });
  }
  const source = Buffer.from(await resp.arrayBuffer());

  const meta = await sharp(source).metadata();
  const width = meta.width ?? 800;
  const height = meta.height ?? 600;
  const out = await sharp(source)
    .composite([{ input: Buffer.from(watermarkSvg(width, height, label)), top: 0, left: 0 }])
    .webp({ quality: 80 })
    .toBuffer();

  await file.save(out, {
    contentType: 'image/webp',
    resumable: false,
    metadata: { cacheControl: 'private, max-age=3600' },
  });

  return out;
}