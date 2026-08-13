import { firebaseAuth } from '../db/firestore.js';
import { COLS, findByPk, upsert } from '../db/firestoreRepo.js';
import { env } from '../config/env.js';

/**
 * Firebase Authentication middleware.
 *
 * The client signs in with Firebase Auth (Android/Web) and sends the resulting
 * ID token as `Authorization: Bearer <token>`. We verify it with the Admin SDK
 * (the JWT's signature, expiry and audience are all checked server-side), then
 * resolve the Firebase UID → the user's Firestore doc, lazily creating/refreshing
 * it from the token's claims (uid, email, name, photo). Never trust a raw UID
 * from the client.
 *
 * In development only, the legacy dev token (a bare user id) is also accepted
 * so local/emulator work keeps working without a Firebase sign-in.
 *
 * Attaches `req.user` (user doc) and `req.userId` (the Firestore doc id = uid).
 */

function unauthorized(next, message) {
  const err = new Error(message);
  err.status = 401;
  return next(err);
}

/** Legacy dev token: a bare UUID. Accepted only outside production. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verify a Bearer token and resolve the user doc.
 * Returns { user, userId } on success, or throws { status: 401 }.
 */
async function resolveUser(token) {
  if (!token) {
    const e = new Error('Authentication required — send Authorization: Bearer <token>');
    e.status = 401;
    throw e;
  }

  // Production: only signed Firebase ID tokens are accepted.
  if (env.NODE_ENV === 'production') {
    return verifyFirebaseToken(token);
  }

  // Development convenience: legacy bare-user-id token.
  if (UUID_RE.test(token)) {
    const user = await findByPk(COLS.users, token);
    if (!user) {
      const e = new Error('Invalid or unknown auth token');
      e.status = 401;
      throw e;
    }
    return { user, userId: user.id };
  }

  return verifyFirebaseToken(token);
}

async function verifyFirebaseToken(token) {
  try {
    const decoded = await firebaseAuth.verifyIdToken(token, true);
    const uid = decoded.uid;

    // Lazy upsert / refresh the user doc from the verified token claims.
    const existing = await findByPk(COLS.users, uid);
    const patch = {
      authProviderId: uid,
      email: decoded.email ?? existing?.email ?? '',
      fullName:
        decoded.name ?? decoded.displayName ?? existing?.fullName ?? decoded.email?.split('@')[0] ?? 'User',
      avatarUrl: decoded.picture ?? decoded.photoURL ?? existing?.avatarUrl ?? null,
      updatedAt: new Date(),
    };
    if (!existing) patch.createdAt = new Date();
    await upsert(COLS.users, uid, patch);

    const user = await findByPk(COLS.users, uid);
    return { user, userId: uid };
  } catch (err) {
    const e = new Error('Invalid or expired auth token');
    e.status = 401;
    throw e;
  }
}

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const { user, userId } = await resolveUser(token);
    req.user = user;
    req.userId = userId;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Optional auth — attaches req.user when a valid Bearer token is present,
 * otherwise continues as anonymous. Used by prompt detail (paid prompts unlock
 * only for signed-in users). Invalid tokens are treated as anonymous here.
 */
export async function optionalAuth(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token) {
      try {
        const { user, userId } = await resolveUser(token);
        req.user = user;
        req.userId = userId;
      } catch {
        // ignore — anonymous
      }
    }
    return next();
  } catch {
    return next();
  }
}
