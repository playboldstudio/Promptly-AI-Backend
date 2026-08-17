import { Router, raw } from 'express';
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
import { uploadImage } from '../services/storage.service.js';
import { watermarkedPromptImage } from '../services/image-watermark.service.js';

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
 * and paid prompts require the Pro or Creator plan (canPostPaid).
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
 * POST /prompts/image — upload a prompt cover image (raw body, e.g. image/jpeg).
 * Returns { imageUrl } — pass that URL to POST /prompts as imageUrl.
 */
router.post(
  '/prompts/image',
  requireAuth,
  raw({ type: 'image/*', limit: '3mb' }),
  async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        const err = new Error('Send the image file as the raw request body (image/jpeg, image/png, …)');
        err.status = 400;
        return next(err);
      }
      const contentType = String(req.headers['content-type'] ?? 'image/jpeg').split(';')[0].trim();
      const imageUrl = await uploadImage({
        folder: `prompts/${req.userId}`,
        buffer: req.body,
        contentType,
      });
      return res.status(201).json({ imageUrl });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /prompts
 * Query params: category, paid ("free"|"paid"), sort (trending|new|recent),
 * q, limit, offset.
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
 * GET /prompts/:id — optional auth unlocks paid prompt text for owners/buyers.
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
 * GET /prompts/:id/image — watermark-protected cover for PAID prompts.
 * Paid covers are re-rendered with a diagonal title watermark and streamed
 * inline with no-download headers (private cache, nosniff) so a future web
 * gallery can show them without handing out the clean file. Free prompts
 * redirect straight to their original public URL.
 */
router.get('/prompts/:id/image', async (req, res, next) => {
  try {
    const prompt = await getPromptById(req.params.id, null);
    if (!prompt || !prompt.imageUrl) {
      const err = new Error('Prompt image not found');
      err.status = 404;
      return next(err);
    }
    if (!prompt.isPaid) {
      return res.redirect(301, prompt.imageUrl);
    }

    const buffer = await watermarkedPromptImage({
      imageUrl: prompt.imageUrl,
      label: prompt.title || 'PROMPTLY',
    });

    res.set({
      'Content-Type': 'image/webp',
      'Content-Disposition': 'inline; filename="prompt.webp"',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
      'X-Robots-Tag': 'noindex',
    });
    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /prompts/:id/save — idempotent. Returns { saved, saveCount }.
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
 * POST /prompts/:id/unsave — idempotent. Returns { saved: false, saveCount }.
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
