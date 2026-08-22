import crypto from 'node:crypto';
import { firebaseAuth } from '../db/firestore.js';
import { COLS, findByPk, queryAll, upsert } from '../db/firestoreRepo.js';
import { env } from '../config/env.js';

/**
 * Firebase Authentication middleware.
 *
 * The client signs in with Firebase Auth and sends the resulting ID token as
 * `Authorization: Bearer <token>`. We verify it with the Admin SDK (signature,
 * expiry, audience), then resolve the Firebase UID → the user's Firestore doc,
 * lazily creating/refreshing it from the token claims.
 *
 * In development only, the legacy dev token (a bare user id) is also accepted.
 *
 * Attaches `req.user` (user doc) and `req.userId` (Firestore doc id = uid).
 */

function unauthorized(next, message) {
  const err = new Error(message);
  err.status = 401;
  return next(err);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DEV-ONLY backdoor — active exclusively when DEV_AUTH_PASSWORD is configured.
 * Token shape: "Bearer <password>:<email>". Resolves the user by email (creating
 * a profile only if none exists). NEVER set DEV_AUTH_PASSWORD on production —
 * when the var is absent this path is inert and Firebase auth applies.
 */
async function devUserByEmail(email) {
  if (!email) {
    const e = new Error('Dev auth requires an email — send Bearer <password>:<email>');
    e.status = 401;
    throw e;
  }
  const { rows } = await queryAll({
    collection: COLS.users,
    filters: [{ field: 'email', op: '==', value: email }],
    limit: 1,
  });
  let user = rows[0];
  if (!user) {
    const uid = crypto.createHash('sha256').update(`dev-auth:${email}`).digest('hex').slice(0, 28);
    await upsert(COLS.users, uid, {
      authProviderId: uid,
      email,
      fullName: email.split('@')[0],
      avatarUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    user = await findByPk(COLS.users, uid);
  }
  if (!user || user.deleted) {
    const e = new Error('Invalid or unknown auth token');
    e.status = 401;
    throw e;
  }
  return { user, userId: user.id };
}

async function resolveUser(token) {
  if (!token) {
    const e = new Error('Authentication required — send Authorization: Bearer <token>');
    e.status = 401;
    throw e;
  }

  if (env.DEV_AUTH_PASSWORD) {
    const sep = token.indexOf(':');
    if (sep > 0 && token.slice(0, sep) === env.DEV_AUTH_PASSWORD) {
      return devUserByEmail(token.slice(sep + 1).trim().toLowerCase());
    }
  }

  if (env.NODE_ENV === 'production') {
    return verifyFirebaseToken(token);
  }

  if (UUID_RE.test(token)) {
    const user = await findByPk(COLS.users, token);
    if (!user || user.deleted) {
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

    const existing = await findByPk(COLS.users, uid);
    // Deleted accounts stay deleted — reject before the fill-in-if-missing
    // upsert below could resurrect them.
    if (existing?.deleted) {
      const e = new Error('Account deleted — this account is no longer active');
      e.status = 401;
      throw e;
    }
    // Fill-in-if-missing: token claims seed a NEW profile, but never overwrite
    // values the user has since edited (fullName / avatarUrl via PATCH profile).
    const patch = {
      authProviderId: uid,
      email: decoded.email ?? existing?.email ?? '',
      fullName:
        existing?.fullName?.trim()
          ? existing.fullName
          : decoded.name ?? decoded.displayName ?? decoded.email?.split('@')[0] ?? 'User',
      avatarUrl:
        existing?.avatarUrl
          ? existing.avatarUrl
          : decoded.picture ?? decoded.photoURL ?? null,
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
 * otherwise continues as anonymous. Invalid tokens are treated as anonymous.
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
