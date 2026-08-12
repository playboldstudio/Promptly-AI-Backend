import { Router } from 'express';
import { z } from 'zod';
import { User } from '../db/models.js';

const router = Router();

const devLoginSchema = z.object({
  email: z.string().email(),
  fullName: z.string().optional(),
});

/**
 * POST /auth/dev/login — DEV-ONLY auth for UI development.
 *
 * Body: { email, fullName? }
 *   → upserts the user (auth_provider_id = email for determinism)
 *   → returns { token: <userId>, user }
 *
 * The "token" IS the user id. The mobile UI uses it as `Authorization: Bearer <id>`.
 * ⚠️ Replace this route (and middleware/auth.js) with real Firebase/Supabase
 * verification before launch — this must not ship.
 */
router.post('/auth/dev/login', async (req, res, next) => {
  try {
    const parsed = devLoginSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const err = new Error('Invalid body — expected { email: string }');
      err.status = 400;
      return next(err);
    }
    const { email, fullName } = parsed.data;

    const [user] = await User.findOrCreate({
      where: { email },
      defaults: {
        authProviderId: email, // deterministic dev identity
        fullName: fullName ?? email.split('@')[0],
      },
    });

    return res.json({ token: user.id, user });
  } catch (err) {
    return next(err);
  }
});

export default router;
