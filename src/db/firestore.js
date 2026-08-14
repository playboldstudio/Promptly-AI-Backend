import { initializeApp, cert, getApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { env } from '../config/env.js';

/**
 * Firebase Admin initialization for Cloud Run.
 *
 * Credential resolution (in order):
 *   1. FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL (from Secret Manager).
 *   2. GOOGLE_APPLICATION_CREDENTIALS / ADC (Cloud Run runtime service account).
 */
let app;

function projectFor() {
  return env.FIREBASE_PROJECT_ID;
}

function credential() {
  const email = env.FIREBASE_CLIENT_EMAIL;
  const key = env.FIREBASE_PRIVATE_KEY;
  if (email && key) {
    return cert({
      projectId: projectFor(),
      clientEmail: email,
      privateKey: key.replace(/\\n/g, '\n'),
    });
  }
  // Fall back to ADC / metadata-server credentials (GOOGLE_APPLICATION_CREDENTIALS
  // or the Cloud Run default service account) — return null so we OMIT the
  // credential property and let the Admin SDK resolve it.
  return null;
}

if (!projectFor()) {
  throw new Error('FIREBASE_PROJECT_ID is required');
}

try {
  app = getApp('promptly-ai');
} catch {
  const options = { projectId: projectFor() };
  const cred = credential();
  if (cred) options.credential = cred; // only pass explicit cert when configured
  app = initializeApp(options, 'promptly-ai');
}

/** Firestore database instance (datastore/emulator-friendly). */
export const db = getFirestore(app, env.FIRESTORE_DATABASE || undefined);

/** Firebase Authentication admin SDK — verifies client ID tokens. */
export const firebaseAuth = getAuth(app);

/** Convert a JS Date to a Firestore Timestamp helper. */
export function toTimestamp(date) {
  return date instanceof Date ? Timestamp.fromDate(date) : (date ?? null);
}

/** Convert a Firestore Timestamp (or Date) to a JS Date. */
export function fromTimestamp(value) {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return new Date(value);
}

/**
 * Lite connectivity check for /health — reads a known (optional) doc.
 * Firestore has no "ping" query, so we list 1 result from subscription_plans.
 */
export async function pingDb() {
  try {
    const snaps = await db.collection('subscription_plans').limit(1).get();
    return snaps.size >= 0;
  } catch {
    return false;
  }
}
