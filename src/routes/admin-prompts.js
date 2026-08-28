import { Router } from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { requireAuth } from '../middleware/auth.js';
import { isAdminEmail } from '../config/env.js';
import { bulkUploadPrompts } from '../services/bulk-prompts.service.js';
import { normalizeImageName, validateBulkRows, IMAGE_MIME_BY_EXT } from '../utils/prompt-import.js';
import { httpError } from '../utils/http-error.js';

/**
 * Admin bulk prompt import.
 *
 * Two accepted payload shapes (multipart/form-data):
 *   1. field `csv` (prompts.csv) + repeated field `images` (the image files)
 *   2. a single field `bundle` — a ZIP containing prompts.csv + images
 *
 * Endpoints:
 *   POST /admin/prompts/bulk-upload         → import (returns a report)
 *   POST /admin/prompts/bulk-upload/validate → dry-run, creates nothing
 *
 * Only emails in ADMIN_EMAILS may import.
 */

const router = Router();

// Cloud Run caps a request body at ~32 MB — keep the multipart limit a hair under.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 501 },
});

/** Wrap multer so its errors (file too large, wrong field) become clean HTTP errors. */
function handleUpload(mw) {
  return (req, res, next) =>
    mw(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          err = Object.assign(new Error('File too large — max 30 MB per file'), { status: 413 });
        } else if (err.name === 'MulterError') {
          err = Object.assign(new Error(err.message), { status: 400 });
        }
        return next(err);
      }
      return next();
    });
}

const bulkFields = [
  { name: 'csv', maxCount: 1 },
  { name: 'images', maxCount: 500 },
  { name: 'bundle', maxCount: 1 },
];

function requireAdmin(req, res, next) {
  if (!req.user || !isAdminEmail(req.user.email)) {
    return next(httpError(403, 'Admin access required'));
  }
  return next();
}

function mimeFor(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? 'image/jpeg';
}

/** Build { name, buffer, mimetype } entries from multer's images files. */
function filesFromMultipart(files = []) {
  return files.map((f) => ({
    name: f.originalname,
    buffer: f.buffer,
    mimetype: f.mimetype || mimeFor(f.originalname),
  }));
}

/**
 * Extract prompts.csv + image entries from a ZIP buffer.
 * Returns { csvText, images } or { error }.
 */
function extractBundle(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return { error: 'Invalid ZIP file' };
  }

  let csvEntry = null;
  const images = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.trim();
    const base = normalizeImageName(name);
    if (!base) continue;

    if (base === 'prompts.csv' && !csvEntry) {
      csvEntry = entry;
      continue;
    }
    if (/\.(jpe?g|png|webp|gif|avif)$/i.test(base)) {
      images.push({ name: base, buffer: entry.getData(), mimetype: mimeFor(base) });
    }
  }

  if (!csvEntry) return { error: 'ZIP is missing prompts.csv' };
  return { csvText: csvEntry.getData().toString('utf8'), images };
}

/** Resolve the CSV text + image lookup from a multipart request. */
function extractImportPayload(req) {
  const bundleFile = req.files?.bundle?.[0];
  if (bundleFile) return extractBundle(bundleFile.buffer);

  const csvFile = req.files?.csv?.[0];
  if (!csvFile) {
    return { error: 'Send a CSV file (field "csv") plus images (field "images") — or a single ZIP bundle (field "bundle")' };
  }
  return {
    csvText: csvFile.buffer.toString('utf8'),
    images: filesFromMultipart(req.files?.images ?? []),
  };
}

function imagesByName(images) {
  const map = new Map();
  for (const img of images ?? []) map.set(normalizeImageName(img.name), img);
  return map;
}

/**
 * POST /admin/prompts/bulk-upload/validate — dry run. Validates CSV columns,
 * row rules, duplicates and image availability. Creates nothing.
 */
router.post(
  '/admin/prompts/bulk-upload/validate',
  requireAuth,
  requireAdmin,
  handleUpload(upload.fields(bulkFields)),
  async (req, res, next) => {
    try {
      const payload = extractImportPayload(req);
      if (payload.error) return next(httpError(400, payload.error));
      const result = validateBulkRows(payload.csvText, imagesByName(payload.images));
      const total = result.valid.length + result.errors.length;
      return res.json({
        success: !result.error,
        total,
        valid: result.valid.length,
        failed: result.errors.length,
        errors: result.errors,
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /admin/prompts/bulk-upload — import. Validates, uploads images to Cloud
 * Storage and creates the prompt docs in Firestore batches. Returns a report
 * with per-row errors so the frontend can render a summary + error export.
 */
router.post(
  '/admin/prompts/bulk-upload',
  requireAuth,
  requireAdmin,
  handleUpload(upload.fields(bulkFields)),
  async (req, res, next) => {
    try {
      const payload = extractImportPayload(req);
      if (payload.error) return next(httpError(400, payload.error));
      const report = await bulkUploadPrompts({
        userId: req.userId,
        adminEmail: req.user.email,
        csvText: payload.csvText,
        imagesByName: imagesByName(payload.images),
      });
      return res.status(201).json(report);
    } catch (err) {
      return next(err);
    }
  },
);

export default router;