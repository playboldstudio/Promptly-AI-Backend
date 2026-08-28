import { Router, raw } from 'express';
import { z } from 'zod';
import {
  listPrompts,
  getPromptById,
  recordPromptView,
  savePrompt,
  unsavePrompt,
  createPrompt,
  deletePrompt,
} from '../services/prompts.service.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { isAdminEmail } from '../config/env.js';
import { uploadImage } from '../services/storage.service.js';
import { watermarkedPromptImage } from '../services/image-watermark.service.js';
import { moderateImage } from '../services/image-moderation.service.js';
import { parsePaging } from '../utils/paging.js';
import { httpError } from '../utils/http-error.js';
import { PROMPT_CATEGORIES } from '../utils/prompt-import.js';

const router = Router();

const createPromptSchema = z
  .object({
    title: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(100),
    promptText: z.string().trim().min(1),
    imageUrl: z.string().trim().url().optional().nullable(),
    images: z.array(z.string().trim().url()).max(10).optional(),
    category: z.enum(PROMPT_CATEGORIES),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    isPaid: z.boolean().default(false),
    priceInr: z.number().int().positive().optional().nullable(),
  })
  .refine((v) => !v.isPaid || (v.isPaid && v.priceInr), {
    message: 'A paid prompt requires a positive priceInr',
    path: ['priceInr'],
  });

/**
 * POST /prompts — creator publish. Authenticated; authorId is the caller.
 * Unlimited free posts for every user; paid prompts require the Pro or
 * Creator plan (canPostPaid).
 */
router.post('/prompts', requireAuth, async (req, res, next) => {
  try {
    const parsed = createPromptSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, parsed.error.issues[0]?.message ?? 'Invalid prompt body'));
    const result = await createPrompt({ userId: req.userId, input: parsed.data });
    if (result.error) return next(httpError(result.error.status, result.error.message));
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
        return next(httpError(400, 'Send the image file as the raw request body (image/jpeg, image/png, …)'));
      }
      const contentType = String(req.headers['content-type'] ?? 'image/jpeg').split(';')[0].trim();

      // Server-side NSFW moderation — reject adult/racy images for non-admins.
      // Admins are exempt (admin bulk import uses a separate route).
      const mod = await moderateImage(req.body, contentType);
      if (!mod.safe) {
        return next(httpError(422, mod.reason));
      }

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
    const { limit, offset } = parsePaging(req.query);

    if (category && !PROMPT_CATEGORIES.includes(category)) {
      return next(httpError(400, `Invalid category "${category}"`));
    }
    if (paid && !['free', 'paid'].includes(paid)) {
      return next(httpError(400, 'paid must be "free" or "paid"'));
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
    if (!prompt) return next(httpError(404, 'Prompt not found'));

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
 * redirect straight to their original public URL, and so do admins (they have
 * full access — no watermark).
 */
router.get('/prompts/:id/image', optionalAuth, async (req, res, next) => {
  try {
    const prompt = await getPromptById(req.params.id, req.userId);
    if (!prompt || !prompt.imageUrl) {
      return next(httpError(404, 'Prompt image not found'));
    }
    const isAdmin = Boolean(req.user && isAdminEmail(req.user.email));
    if (!prompt.isPaid || isAdmin) {
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
 * DELETE /prompts/:id — the author deletes their own prompt; admins may delete
 * any prompt. Purchase/ledger rows are kept (financial audit) — only the
 * content and its saves are removed.
 */
router.delete('/prompts/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await deletePrompt({
      id: req.params.id,
      userId: req.userId,
      isAdmin: isAdminEmail(req.user?.email),
    });
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
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
    if (result.notFound) return next(httpError(404, 'Prompt not found'));
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
