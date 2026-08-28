import { Router } from 'express';
import { z } from 'zod';
import { firebaseAuth } from '../db/firestore.js';
import { COLS, findByPk, queryAll, upsert } from '../db/firestoreRepo.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { httpError } from '../utils/http-error.js';

const router = Router();

const loginLimiter = rateLimit({ windowMs: 60_000, max: 30, message: 'Too many login attempts — try again shortly' });

const loginSchema = z.object({ idToken: z.string().min(1) });

router.post('/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, 'Invalid body — expected { idToken: string }'));

    const decoded = await firebaseAuth.verifyIdToken(parsed.data.idToken, true);
    const uid = decoded.uid;
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
    return res.json({ user, token: parsed.data.idToken });
  } catch (err) {
    // Token invalid/expired — surface as 401.
    return next(httpError(401, 'Invalid or expired Firebase token'));
  }
});

/**
 * POST /auth/dev/login — DEV-ONLY auth for UI development + the emulator.
 * Body: { email, fullName? } → { token: <userId>, user }
 * In production this route returns 404.
 */
const devLoginSchema = z.object({
  email: z.string().email(),
  fullName: z.string().optional(),
});

router.post('/auth/dev/login', loginLimiter, async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return next(httpError(404, 'Not found'));
    }

    const parsed = devLoginSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const err = new Error('Invalid body — expected { email: string }');
      err.status = 400;
      return next(err);
    }
    const { email, fullName } = parsed.data;

    const existing = await findByEmail(email);
    let id;
    if (existing) {
      id = existing.id;
    } else {
      const docRef = { upsertId: `dev_${email.replace(/[^a-zA-Z0-9@._-]/g, '_')}` };
      await upsert(COLS.users, docRef.upsertId, {
        authProviderId: email,
        email,
        fullName: fullName ?? email.split('@')[0],
        role: 'viewer',
        upiId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      id = docRef.upsertId;
    }

    const user = await findByPk(COLS.users, id);
    return res.json({ token: id, user });
  } catch (err) {
    return next(err);
  }
});

/** Find a user doc by an exact email match (dev helper). */
async function findByEmail(email) {
  const { rows } = await queryAll({
    collection: COLS.users,
    filters: [{ field: 'email', value: email }],
    limit: 1,
  });
  return rows[0] ?? null;
}

export default router;
