import { randomBytes } from 'crypto';
import { getStorage } from 'firebase-admin/storage';
import { adminApp } from '../db/firestore.js';
import { env } from '../config/env.js';

/**
 * Cloud Storage uploads (avatars, prompt images).
 *
 * Objects live in a public GCS bucket and are served straight from
 * storage.googleapis.com, so clients don't need Firebase Storage SDK auth.
 */

const BUCKET = env.STORAGE_BUCKET || `${env.FIREBASE_PROJECT_ID}.appspot.com`;

/** True when the GCS error means the bucket itself is missing/misconfigured. */
function isBucketConfigError(err) {
  const msg = String(err?.message ?? err?.errors?.[0]?.message ?? '');
  return /bucket does not exist|404 not found|bucket[^.]*not found|storage bucket.*configured/i.test(msg);
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

function extFor(contentType) {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    case 'image/jpeg':
    default:
      return 'jpg';
  }
}

/** Upload raw image bytes and return the public URL. */
export async function uploadImage({ folder, buffer, contentType = 'image/jpeg' }) {
  if (!(buffer instanceof Buffer) || buffer.length === 0) {
    throw Object.assign(new Error('No image was received'), { status: 400 });
  }
  if (buffer.length > 3 * 1024 * 1024) {
    throw Object.assign(new Error('Image is too large (max 3 MB)'), { status: 413 });
  }
  const mime = MIME_BY_EXT[contentType.toLowerCase()] ?? 'image/jpeg';
  const ext = extFor(mime);

  const random = randomBytes(8).toString('hex');
  const path = `${folder}/${Date.now()}-${random}.${ext}`;

  const file = getStorage(adminApp).bucket(BUCKET).file(path);
  try {
    await file.save(buffer, {
      contentType: mime,
      metadata: { cacheControl: 'public, max-age=31536000, immutable' },
      resumable: false,
    });
  } catch (err) {
    // A missing/non-existent bucket (e.g. STORAGE_BUCKET not set on a dev
    // service) would otherwise surface as a raw 500 on every upload. Surface
    // it as a clean 503 so misconfiguration is obvious.
    if (isBucketConfigError(err)) {
      throw Object.assign(
        new Error('Image storage is not configured — uploads are unavailable'),
        { status: 503 }
      );
    }
    throw err;
  }

  // Bucket IAM grants allUsers objectViewer → public read via this URL.
  return `https://storage.googleapis.com/${BUCKET}/${path}`;
}
