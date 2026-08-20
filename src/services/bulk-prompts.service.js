import crypto from 'node:crypto';
import { COLS, batchCreate } from '../db/firestoreRepo.js';
import { uploadImage } from './storage.service.js';
import { validateBulkRows } from '../utils/prompt-import.js';

/**
 * Admin bulk prompt import.
 *
 * Parses a prompts.csv, validates every row via the pure prompt-import helpers
 * (same rules the creator POST /prompts route enforces), uploads matched image
 * files to Cloud Storage, and creates the Firestore documents with batched
 * writes.
 *
 * Deliberately NOT the creator createPrompt() path: bulk imports are an admin
 * back-office operation and must not trip the plan gates.
 */

const BATCH_SIZE = 500;

/** Run async work over a list with a small concurrency cap (image uploads). */
async function mapWithConcurrency(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Import validated rows. Uploads each referenced image to Cloud Storage, then
 * creates all prompt docs in Firestore batches (500 writes per batch).
 *
 * Returns an import report: { success, total, created, failed, errors, createdIds }.
 */
export async function bulkUploadPrompts({ userId, adminEmail, csvText, imagesByName }) {
  const { valid, errors, error } = validateBulkRows(csvText, imagesByName);
  if (error) {
    return { success: false, total: 0, created: 0, failed: 0, errors: errors ?? [] };
  }

  const now = new Date();
  const folder = `prompts/admin/${Date.now()}`;

  const enriched = await mapWithConcurrency(valid, 8, async (item) => {
    let imageUrl = null;
    let images = [];
    if (item.imageName) {
      const file = imagesByName.get(item.imageName);
      const url = await uploadImage({
        folder,
        buffer: file.buffer,
        contentType: file.mimetype || 'image/jpeg',
      });
      imageUrl = url;
      images = [url];
    }
    return { ...item, id: crypto.randomUUID(), imageUrl, images };
  });

  const failed = [...errors];
  const entries = enriched.map((item) => ({
    id: item.id,
    data: {
      authorId: userId,
      title: item.title,
      description: item.description,
      promptText: item.promptText,
      imageUrl: item.imageUrl,
      images: item.images,
      category: item.category,
      tags: item.tags,
      isPaid: item.isPaid,
      priceInr: item.isPaid ? item.priceInr : null,
      status: 'published',
      viewCount: 0,
      saveCount: 0,
      createdAt: now,
      updatedAt: now,
      importedBy: adminEmail,
      importBatch: now.toISOString(),
    },
  }));

  // Batched Firestore writes — 500 per commit, so a 1,000-prompt import is 2
  // commits instead of 1,000 individual writes. Image uploads above still run
  // individually (Storage has no batch API).
  const createdIds = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const chunkIds = await batchCreate(COLS.prompts, entries.slice(i, i + BATCH_SIZE));
    createdIds.push(...chunkIds);
  }

  return {
    success: true,
    total: createdIds.length + failed.length,
    created: createdIds.length,
    failed: failed.length,
    errors: failed,
    createdIds,
  };
}