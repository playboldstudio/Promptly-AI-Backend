import { Router } from 'express';
import { z } from 'zod';
import {
  listPrompts,
  getPromptById,
  recordPromptView,
  savePrompt,
  unsavePrompt,
  createPrompt,
} from '../services/prompts.service.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';

// Mirrors the Prompt.category enum in src/db/models/Prompt.js.
const PROMPT_CATEGORIES = [
  'portrait',
  'fashion',
  'cinematic',
  'product',
  'travel',
  'creative',
  'social',
  'photography',
  'other',
];

const router = Router();

const createPromptSchema = z
  .object({
    title: z.string().trim().min(1).max(140),
    description: z.string().trim().min(1).max(2000),
    promptText: z.string().trim().min(1),
    imageUrl: z.string().trim().url().optional().nullable(),
    category: z.enum(PROMPT_CATEGORIES),
    tags: z.array(z.string().trim().min(1)).max(20).default([]),
    isPaid: z.boolean().default(false),
    priceInr: z.number().int().positive().optional().nullable(),
  })
  .refine((v) => !v.isPaid || (v.isPaid && v.priceInr), {
    message: 'A paid prompt requires a positive priceInr',
    path: ['priceInr'],
  });

/**
 * POST /prompts — creator publish. Authenticated; authorId is the caller.
 * Gates: daily post limit from the plan (Free=3/day, Pro/Creator unlimited)
 * and paid prompts require the Creator plan (canPostPaid).
 * Body: { title, description, promptText, imageUrl?, category, tags?, isPaid, priceInr? }
 */
router.post('/prompts', requireAuth, async (req, res, next) => {
  try {
    const parsed = createPromptSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const err = new Error(parsed.error.issues[0]?.message ?? 'Invalid prompt body');
      err.status = 400;
      return next(err);
    }
    const result = await createPrompt({ userId: req.userId, input: parsed.data });
    if (result.error) {
      const { status, message } = result.error;
      const err = new Error(message);
      err.status = status;
      return next(err);
    }
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /prompts
 * Query params:
 *   category  — PromptCategory enum value
 *   paid      — "free" | "paid"
 *   sort      — "trending" | "new" | "recent"
 *   q         — search text (title/description/tags)
 *   limit     — page size (default 50)
 *   offset    — page offset (default 0)
 */
// Optional auth → each row is annotated with savedByMe for the signed-in viewer.
router.get('/prompts', optionalAuth, async (req, res, next) => {
  try {
    const { category, paid, sort, q } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    if (category && !PROMPT_CATEGORIES.includes(category)) {
      const err = new Error(`Invalid category "${category}"`);
      err.status = 400;
      return next(err);
    }
    if (paid && !['free', 'paid'].includes(paid)) {
      const err = new Error('paid must be "free" or "paid"');
      err.status = 400;
      return next(err);
    }

    const result = await listPrompts({
      category,
      paid,
      sort,
      q,
      viewerId: req.userId,
      limit,
      offset,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /prompts/:id
 * Optional auth — a signed-in viewer unlocks the paid prompt text if they own it
 * or have a completed purchase. Free prompts always include prompt_text.
 */
router.get('/prompts/:id', optionalAuth, async (req, res, next) => {
  try {
    const prompt = await getPromptById(req.params.id, req.userId);
    if (!prompt) {
      const err = new Error('Prompt not found');
      err.status = 404;
      return next(err);
    }

    // Fire-and-forget view count — never fail the request on a bump.
    recordPromptView(prompt.id);

    return res.json({ prompt });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /prompts/:id/save — save a prompt for the signed-in user.
 * Idempotent. Returns { saved, saveCount } for the UI to update the button/counter.
 */
router.post('/prompts/:id/save', requireAuth, async (req, res, next) => {
  try {
    const result = await savePrompt(req.params.id, req.userId);
    if (result.notFound) {
      const err = new Error('Prompt not found');
      err.status = 404;
      return next(err);
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /prompts/:id/unsave — remove the save. Idempotent.
 * Returns { saved: false, saveCount } so the UI can flip the button back.
 */
router.post('/prompts/:id/unsave', requireAuth, async (req, res, next) => {
  try {
    const result = await unsavePrompt(req.params.id, req.userId);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
