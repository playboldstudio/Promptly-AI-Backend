import { Router, raw } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  listPrompts,
  listPromptCategories,
  listNewPrompts,
  listMonthPrompts,
  getPromptById,
  recordPromptView,
  savePrompt,
  unsavePrompt,
  createPrompt,
  deletePrompt,
} from '../services/prompts.service.js';
import {
  reportPrompt,
  appealPrompt,
  toggleLike,
  sharePrompt,
} from '../services/moderation.service.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { isAdminEmail } from '../config/env.js';
import { uploadImage } from '../services/storage.service.js';
import { watermarkedPromptImage } from '../services/image-watermark.service.js';
import { moderateImage } from '../services/image-moderation.service.js';
import { parsePaging } from '../utils/paging.js';
import { httpError } from '../utils/http-error.js';
import { PROMPT_CATEGORIES } from '../utils/prompt-import.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

const reportLimiter = rateLimit({ windowMs: 3600_000, max: 5, message: 'Too many reports — try again later' });

/** Field rules shared by the JSON body and the multipart form. */
const promptFieldsSchema = z.object({
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(100),
  promptText: z.string().trim().min(1),
  // Accept "" (empty) and whitespace as "no image" so the schema falls through
  // to the friendly "A cover image is required" check instead of a raw "Invalid
  // url" — the app may send an empty string when no image was picked yet.
  imageUrl: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().url().optional().nullable(),
  ),
  images: z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() !== '') : v),
    z.array(z.string().trim().url()).max(10).optional(),
  ),
  category: z.enum(PROMPT_CATEGORIES),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  isPaid: z.boolean().default(false),
  priceInr: z.number().int().positive().optional().nullable(),
});

const paidRequiresPriceRule = (v) => !v.isPaid || (v.isPaid && v.priceInr);
const paidRequiresPriceRefine = {
  message: 'A paid prompt requires a positive priceInr',
  path: ['priceInr'],
};

/** Full JSON-body schema — fields + paid/price + cover requirements. */
const createPromptSchema = promptFieldsSchema
  .refine(paidRequiresPriceRule, paidRequiresPriceRefine)
  .superRefine((v, ctx) => {
    const hasUrl = !!v.imageUrl?.trim();
    const hasImages = Array.isArray(v.images) && v.images.length > 0;
    if (!hasUrl && !hasImages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A cover image is required. Please add an image to your prompt.',
        path: ['imageUrl'],
      });
    }
  });

/**
 * Multipart fields schema — same field rules and paid/price check as JSON, but
 * NO cover superRefine: in a multipart request the cover/gallery URLs come from
 * the uploaded files, so the "no cover" check runs after uploads (see
 * createPromptFromMultipart) with the exact same friendly message.
 */
const multipartPromptSchema = promptFieldsSchema.refine(paidRequiresPriceRule, paidRequiresPriceRefine);

/** Human-readable first validation error: "field: message" (e.g. "description: Required"). */
function promptValidationMessage(error) {
  const issue = error?.issues?.[0];
  if (!issue) return 'Invalid prompt body';
  const field = Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : null;
  return field ? `${field}: ${issue.message}` : issue.message;
}

/* ── Multipart (POST /prompts) — fields + cover/gallery image files ─────────── */

const PROMPT_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const PROMPT_IMAGE_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per file
const PROMPT_IMAGE_FIELDS = [
  { name: 'image', maxCount: 1 }, // exactly one cover
  { name: 'images', maxCount: 5 }, // up to five gallery images
];

/** In-memory multipart uploader — only POST /prompts uses it. */
const promptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROMPT_IMAGE_FILE_SIZE, files: 6 },
  fileFilter: (_req, file, cb) => {
    if (PROMPT_IMAGE_MIME.includes(String(file.mimetype ?? '').toLowerCase())) return cb(null, true);
    return cb(httpError(400, 'Only JPG, PNG or WebP images are allowed'));
  },
});

/** Convert a multer error into a clean httpError (message, never a stack trace). */
export function httpizeMultipartError(err) {
  if (err?.status) return err;
  switch (err?.code) {
    case 'LIMIT_FILE_SIZE':
      return httpError(413, 'Image file is too large (max 5 MB each)');
    case 'LIMIT_FILE_COUNT':
      return httpError(400, 'Too many image files (max 1 cover + 5 gallery images)');
    case 'LIMIT_UNEXPECTED_FILE':
      return httpError(
        400,
        `Unexpected file field${err.field ? ` "${err.field}"` : ''} — use "image" (cover) or "images" (gallery)`,
      );
    case 'LIMIT_PART_COUNT':
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_FIELD_VALUE':
    case 'LIMIT_FIELD_KEY':
      return httpError(400, 'Multipart request is malformed (too many fields or parts)');
    default:
      return httpError(400, String(err?.message ?? 'Invalid multipart upload').slice(0, 200));
  }
}

/**
 * Coerce a multipart `tags` field (multer gives strings) into array form.
 * Handles the app's single comma-joined field ("cinematic,portrait") and a
 * JSON-encoded array (["a","b"]) with a JSON.parse fallback.
 */
export function parseTags(value) {
  if (value === undefined || value === null) return [];
  const raw = String(value);
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
  } catch {
    // not JSON → treat as comma-joined
  }
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

/** Coerce a multipart `isPaid` field: "true" / "1" → true, anything else → false. */
export function parseIsPaid(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'true' || s === '1';
}

/**
 * Turn raw multipart text fields into the typed values zod expects. Invalid
 * priceInr strings are left as strings so the schema rejects them with a clean
 * "priceInr: ..." message instead of a silent NaN.
 */
export function coerceMultipartFields(raw) {
  const out = { ...raw };
  out.tags = parseTags(raw.tags);
  out.isPaid = parseIsPaid(raw.isPaid);
  if (raw.priceInr !== undefined && raw.priceInr !== null && String(raw.priceInr).trim() !== '') {
    const n = Number.parseInt(String(raw.priceInr), 10);
    out.priceInr = Number.isNaN(n) ? raw.priceInr : n;
  }
  return out;
}

/**
 * Multipart-only body parser for POST /prompts. JSON requests pass straight
 * through untouched (multer would otherwise drain/overwrite the parsed body).
 */
export function parseMultipart(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  promptUpload.fields(PROMPT_IMAGE_FIELDS)(req, res, (err) => {
    if (err) return next(httpizeMultipartError(err));
    return next();
  });
}

/**
 * Multipart branch of POST /prompts. Coerces the text fields, validates them
 * with the same rules as JSON, then moderates + uploads every image file. The
 * `image` file becomes the cover URL; the `images` files become the gallery.
 */
async function createPromptFromMultipart(req, res, next) {
  try {
    const fields = coerceMultipartFields(req.body ?? {});
    const parsed = multipartPromptSchema.safeParse(fields);
    if (!parsed.success) return next(httpError(400, promptValidationMessage(parsed.error)));

    const allFiles = [...(req.files?.image ?? []), ...(req.files?.images ?? [])];

    // No image files at all → same friendly "cover required" message as JSON.
    if (allFiles.length === 0) {
      return next(httpError(400, 'imageUrl: A cover image is required. Please add an image to your prompt.'));
    }

    const urls = [];
    for (const file of allFiles) {
      const contentType = String(file.mimetype ?? 'image/jpeg');
      const mod = await moderateImage(file.buffer);
      if (!mod.safe) return next(httpError(422, mod.reason));
      const imageUrl = await uploadImage({
        folder: `prompts/${req.userId}`,
        buffer: file.buffer,
        contentType,
      });
      urls.push(imageUrl);
    }

    const input = { ...parsed.data, imageUrl: urls[0], images: urls.slice(1) };
    const result = await createPrompt({ userId: req.userId, input });
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /prompts — creator publish. Authenticated; authorId is the caller.
 * Unlimited free posts for every user; paid prompts require the Pro or
 * Creator plan (canPostPaid).
 *
 * Body:
 *  - JSON: title, description, promptText, category, imageUrl OR images[],
 *    optional tags[], isPaid, priceInr.
 *  - multipart/form-data: the same text fields (tags one comma-joined string,
 *    isPaid "true"/"1", priceInr a number string) plus image files: `image`
 *    (exactly 1 — the cover) and `images` (0-5 — the gallery).
 */
router.post('/prompts', requireAuth, parseMultipart, async (req, res, next) => {
  try {
    if (req.is('multipart/form-data')) {
      return createPromptFromMultipart(req, res, next);
    }
    const parsed = createPromptSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, promptValidationMessage(parsed.error)));
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
        return next(httpError(400, 'Please upload an image file (JPG, PNG or WebP)'));
      }
      const contentType = String(req.headers['content-type'] ?? 'image/jpeg').split(';')[0].trim();

      // Server-side NSFW moderation — reject adult/racy images for non-admins.
      // Admins are exempt (admin bulk import uses a separate route).
      const mod = await moderateImage(req.body);
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
 * GET /prompts/categories — Flipkart-style category rails: every category with
 * its published count + the newest `previewLimit` prompts (default 4, max 10).
 * Optional `paid` narrows the rails to "free" | "paid" items.
 */
router.get('/prompts/categories', optionalAuth, async (req, res, next) => {
  try {
    const { paid } = req.query;
    const result = await listPromptCategories({
      previewLimit: req.query.previewLimit,
      paid,
      viewerId: req.userId,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /prompts/new — "just added" feed: prompts published within the last
 * `days` (default 7, max 90), newest first. Same row shape as GET /prompts.
 */
router.get('/prompts/new', optionalAuth, async (req, res, next) => {
  try {
    const { limit, offset } = parsePaging(req.query);
    const result = await listNewPrompts({
      days: req.query.days,
      viewerId: req.userId,
      limit,
      offset,
    });
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /prompts/month — month-wise feed: prompts published within a calendar
 * month (`month=YYYY-MM`), newest first. Same row shape as GET /prompts.
 */
router.get('/prompts/month', optionalAuth, async (req, res, next) => {
  try {
    const { limit, offset } = parsePaging(req.query);
    const result = await listMonthPrompts({
      month: req.query.month,
      viewerId: req.userId,
      limit,
      offset,
    });
    if (result.error) return next(httpError(result.error.status, result.error.message));
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

/* ── Moderation: report / like / share / appeal ──────────────────────────────── */

const reportSchema = z.object({
  reason: z.enum(['spam', 'inappropriate', 'copyright', 'misleading', 'other']),
  description: z.string().trim().max(500).optional(),
});

/**
 * POST /prompts/:id/report — flag a prompt. Rate-limited (5 per user/hour).
 * Body: { reason, description? }.
 */
router.post('/prompts/:id/report', requireAuth, reportLimiter, async (req, res, next) => {
  try {
    const parsed = reportSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, parsed.error.issues[0]?.message ?? 'Invalid report'));
    const result = await reportPrompt({
      promptId: req.params.id,
      userId: req.userId,
      reason: parsed.data.reason,
      description: parsed.data.description,
    });
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

const appealSchema = z.object({
  reason: z.string().trim().min(10).max(500),
});

/**
 * POST /prompts/:id/appeal — creator appeal within 7-day window.
 * Body: { reason }.
 */
router.post('/prompts/:id/appeal', requireAuth, async (req, res, next) => {
  try {
    const parsed = appealSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(httpError(400, parsed.error.issues[0]?.message ?? 'Please provide a reason for your appeal'));
    const result = await appealPrompt({
      promptId: req.params.id,
      authorId: req.userId,
      reason: parsed.data.reason,
    });
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /prompts/:id/like — toggle like (idempotent).
 */
router.post('/prompts/:id/like', requireAuth, async (req, res, next) => {
  try {
    const result = await toggleLike({ promptId: req.params.id, userId: req.userId });
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /prompts/:id/share — increment share count.
 */
router.post('/prompts/:id/share', requireAuth, async (req, res, next) => {
  try {
    const result = await sharePrompt(req.params.id);
    if (result.error) return next(httpError(result.error.status, result.error.message));
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
