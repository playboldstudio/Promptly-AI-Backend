import { User } from '../db/models.js';

/**
 * Dev authentication: `Authorization: Bearer <userId>`.
 *
 * ⚠️ DEV ONLY. The token is just the user's id — no signing, no expiry.
 * This is the swap point for real auth (Firebase Auth / Supabase Auth / phone OTP):
 * verify the Bearer token against the provider, resolve `authProviderId` → user,
 * and attach the same `req.user`.
 *
 * Attaches `req.user` (full User row) and `req.userId` on success.
 * Throws 401 when the header is missing, the token isn't a valid UUID, or the user
 * doesn't exist.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unauthorized(next, message) {
  const err = new Error(message);
  err.status = 401;
  return next(err);
}

/** Dev tokens are user UUIDs. Anything else fails fast instead of hitting Postgres. */
function isValidToken(token) {
  return Boolean(token) && UUID_RE.test(token);
}

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

    if (!token) {
      return unauthorized(next, 'Authentication required — send Authorization: Bearer <userId>');
    }
    if (!isValidToken(token)) {
      return unauthorized(next, 'Invalid auth token');
    }

    const user = await User.findByPk(token);
    if (!user) {
      return unauthorized(next, 'Invalid or unknown auth token');
    }

    req.user = user;
    req.userId = user.id;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Optional auth — attaches req.user when a valid Bearer token is present,
 * otherwise continues as anonymous. Used by prompt detail (paid prompts unlock
 * only for signed-in users).
 */
export async function optionalAuth(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token && isValidToken(token)) {
      const user = await User.findByPk(token);
      if (user) {
        req.user = user;
        req.userId = user.id;
      }
    }
    return next();
  } catch (err) {
    return next(err);
  }
}
