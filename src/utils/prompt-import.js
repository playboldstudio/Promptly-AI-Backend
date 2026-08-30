import { csvToObjects } from './csv.js';

/**
 * Pure prompt-import helpers (no DB / storage / firebase deps — unit-testable).
 *
 * Mirrors the rules the creator POST /prompts route enforces (title/desc
 * lengths, category enum, tag limits, paid-price requirement) plus the
 * cross-row duplicate and image-availability checks used by the admin bulk
 * import. Deliberately dependency-free so tests can import it cold.
 */

export const PROMPT_CATEGORIES = [
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

export const MAX_TITLE = 60;
export const MAX_DESCRIPTION = 100;
export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 40;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

export const IMAGE_MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/** Normalize an uploaded filename → a stable lookup key (basename, lower-case). */
export function normalizeImageName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .pop();
}

/** True when the name looks like a supported image filename. */
export function isImageFilename(name) {
  const norm = normalizeImageName(name);
  const ext = `.${norm.split('.').pop()}`;
  return Boolean(norm) && IMAGE_EXT.has(ext);
}

function parseBool(value) {
  if (value === undefined || value === null || String(value).trim() === '') return false;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'paid'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'free'].includes(s)) return false;
  return null; // invalid
}

function parsePrice(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function parseTags(value) {
  return String(value ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Validate every CSV row against the import rules.
 *
 * imagesByName: Map of normalized filename → { buffer, mimetype }.
 * Returns { error, valid, errors } — `valid` rows are import-ready.
 */
export function validateBulkRows(csvText, imagesByName = new Map()) {
  const { header, rows } = csvToObjects(csvText);
  if (!header) {
    return {
      error: 'CSV is empty or missing a header row (title, description, promptText, category, …)',
      valid: [],
      errors: [{ row: 0, title: null, reason: 'CSV is empty or missing a header row' }],
    };
  }

  const required = ['title', 'description', 'prompttext', 'category'];
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) {
    const labels = { title: 'title', description: 'description', prompttext: 'promptText', category: 'category' };
    return {
      error: `CSV is missing required columns: ${missing.map((c) => labels[c]).join(', ')}`,
      valid: [],
      errors: [{ row: 0, title: null, reason: `CSV is missing required columns: ${missing.map((c) => labels[c]).join(', ')}` }],
    };
  }

  const seenTitles = new Set();
  const seenTexts = new Set();
  const valid = [];
  const errors = [];

  rows.forEach((row, idx) => {
    const rowNumber = idx + 2; // 1-indexed rows + header row
    const title = String(row.title ?? '').trim();
    const description = String(row.description ?? '').trim();
    const promptText = String(row.prompttext ?? '').trim();
    const category = String(row.category ?? '').trim().toLowerCase();
    const tags = parseTags(row.tags);
    const isPaid = parseBool(row.ispaid);
    const priceInr = parsePrice(row.priceinr);
    const imageName = String(row.image ?? '').trim();

    const reasons = [];
    if (!title) reasons.push('Missing title');
    else if (title.length > MAX_TITLE) reasons.push(`Title too long (max ${MAX_TITLE} chars)`);
    if (!description) reasons.push('Missing description');
    else if (description.length > MAX_DESCRIPTION) reasons.push(`Description too long (max ${MAX_DESCRIPTION} chars)`);
    if (!promptText) reasons.push('Missing promptText');
    if (!imageName) reasons.push('Missing image');
    if (!PROMPT_CATEGORIES.includes(category)) reasons.push(`Invalid category "${category}"`);
    if (tags.length > MAX_TAGS) reasons.push(`Too many tags (max ${MAX_TAGS})`);
    if (tags.some((t) => t.length > MAX_TAG_LEN)) reasons.push(`Tag too long (max ${MAX_TAG_LEN} chars)`);
    if (isPaid === null) reasons.push('Invalid isPaid value (use true/false)');
    else if (isPaid && priceInr === null) reasons.push('Paid prompt requires a positive priceInr');
    if (imageName && !isImageFilename(imageName)) reasons.push(`Invalid image filename "${imageName}"`);
    if (imageName && !imagesByName.has(normalizeImageName(imageName))) {
      reasons.push(`Image "${imageName}" not found in upload`);
    }

    if (!reasons.length) {
      if (seenTitles.has(title)) reasons.push('Duplicate title in import');
      if (seenTexts.has(promptText)) reasons.push('Duplicate promptText in import');
    }

    seenTitles.add(title);
    seenTexts.add(promptText);

    if (reasons.length) {
      errors.push({ row: rowNumber, title: title || null, reason: reasons.join('; ') });
    } else {
      valid.push({ rowNumber, title, description, promptText, category, tags, isPaid, priceInr, imageName: normalizeImageName(imageName) });
    }
  });

  return { error: null, valid, errors };
}