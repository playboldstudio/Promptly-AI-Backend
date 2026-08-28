import crypto from 'node:crypto';
import { COLS, findByPk, queryAll, removeMany, upsert, create, getMany, increment, countDocuments } from '../db/firestoreRepo.js';
import { derivePromptFlags } from './prompt-metrics.js';
import { isAdminEmail } from '../config/env.js';
import { currentActiveSubscriptionWithPlan } from './payments/subscription-utils.js';

// promptText is the paid asset and is only revealed to owners/unlockers
// (see getPromptById). isTrending / isNew are derived, never stored.
const PUBLIC_PROMPT_ATTRS = [
  'id',
  'title',
  'description',
  'imageUrl',
  'images',
  'category',
  'tags',
  'isPaid',
  'priceInr',
  'viewCount',
  'saveCount',
  'createdAt',
];

/** Bounded catalog read for semantic browse (search/trending/filters). */
const PHOTOS_CATALOG_MAX = 10000;

/** Normalize a prompt's image list — legacy docs only have imageUrl (cover). */
function normalizeImages(json) {
  return Array.isArray(json.images) && json.images.length
    ? json.images
    : json.imageUrl
      ? [json.imageUrl]
      : [];
}

/** Whitelist-authored author shape — never echoes raw user fields to clients. */
function serializeAuthor(author) {
  if (!author) return null;
  return {
    id: author.id,
    fullName: author.fullName,
    avatarUrl: author.avatarUrl,
    role: author.role,
  };
}

function toPublicPrompt(json) {
  const out = {};
  for (const k of PUBLIC_PROMPT_ATTRS) out[k] = json[k];
  out.images = normalizeImages(json);
  return out;
}

/**
 * Semantic filters (category, paid, trending sort, search) require reading the
 * browse set — Firestore has no substring/cross-field OR and no computed-key
 * ordering. It picks the smallest readable slice for the requested page:
 *   - pure "new" browse (the default feed): a plain paginated query into
 *     Firestore, so the catalog can grow without loading every doc.
 *   - "trending" + unpaginated search: resolves to a bounded catalog read
 *     (PHOTOS_CATALOG_MAX) plus in-memory sort — at this scale the whole
 *     published set still fits comfortably in one instance's memory.
 */
export async function listPrompts({ category, paid, sort, q, viewerId, limit = 50, offset = 0 }) {
  // Pure "new" feed with no semantic filter → push pagination to Firestore.
  if (sort !== 'trending' && !q && !category && !paid) {
    const [page, total] = await Promise.all([
      queryAll({
        collection: COLS.prompts,
        filters: [{ field: 'status', value: 'published' }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit,
        offset,
      }),
      countDocuments(COLS.prompts, [{ field: 'status', value: 'published' }]),
    ]);
    return withAuthorsAndSaveState(page.rows, viewerId, limit, offset, total);
  }

  // Semantic filters (category/paid/search/trending) — read a bounded catalog
  // and filter/sort in memory. PHOTOS_CATALOG_MAX is a documented cap, not a
  // hidden growth limit.
  const { rows } = await queryAll({
    collection: COLS.prompts,
    filters: [{ field: 'status', value: 'published' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: PHOTOS_CATALOG_MAX,
  });

  let filtered = rows;
  if (category) filtered = filtered.filter((r) => r.category === category);
  if (paid === 'free') filtered = filtered.filter((r) => !r.isPaid);
  if (paid === 'paid') filtered = filtered.filter((r) => r.isPaid);
  if (q) {
    const needle = q.toLowerCase();
    filtered = filtered.filter((r) =>
      (r.title ?? '').toLowerCase().includes(needle) ||
      (r.description ?? '').toLowerCase().includes(needle) ||
      (Array.isArray(r.tags) && r.tags.some((t) => t.toLowerCase().includes(needle))),
    );
  }

  if (sort === 'trending') {
    filtered = filtered.sort(
      (a, b) =>
        (Number(b.viewCount) + Number(b.saveCount)) -
        (Number(a.viewCount) + Number(a.saveCount)),
    );
  }

  const page = filtered.slice(offset, offset + limit);
  return withAuthorsAndSaveState(page, viewerId, limit, offset, filtered.length);
}

/**
 * Enrich a page of prompt rows with authors, savedByMe and a total.
 * `total` is exact (count aggregation from the pure-feed path, or the
 * in-memory filtered length from the semantic path).
 */
async function withAuthorsAndSaveState(page, viewerId, limit, offset, total) {
  const authorIds = [...new Set(page.map((r) => r.authorId).filter(Boolean))];
  const authors = authorIds.length ? await getMany(COLS.users, authorIds) : {};

  // One query for the viewer's saved prompt ids → savedByMe set membership.
  let savedIds = new Set();
  if (viewerId) {
    const saved = await queryAll({
      collection: COLS.savedPrompts,
      filters: [{ field: 'userId', value: viewerId }],
      fieldMask: ['promptId'],
    });
    savedIds = new Set(saved.rows.map((s) => s.promptId));
  }

  const prompts = page.map((row) => ({
    ...toPublicPrompt(row),
    ...derivePromptFlags(row),
    author: serializeAuthor(authors[row.authorId] ?? null),
    savedByMe: viewerId ? savedIds.has(row.id) : false,
  }));

  return { prompts, total, limit, offset };
}

/**
 * Fetch one published prompt. `viewerId` (optional) enables paid unlock: the
 * full promptText is returned only when the prompt is free, the viewer owns it,
 * or they have a completed PromptPurchase. Also annotates savedByMe.
 */
export async function getPromptById(id, viewerId) {
  const prompt = await findByPk(COLS.prompts, id);
  if (!prompt || prompt.status !== 'published') return null;

  const author = prompt.authorId ? await findByPk(COLS.users, prompt.authorId) : null;

  // Free prompts are always unlocked; paid ones unlock for the owner, a buyer,
  // or a platform admin (full access without paying).
  let unlocked = !prompt.isPaid || Boolean(viewerId && prompt.authorId === viewerId);

  let savedByMe = false;
  if (viewerId) {
    const [viewer, purchase, saved] = await Promise.all([
      findByPk(COLS.users, viewerId),
      unlocked ? null : findByPk(COLS.promptPurchases, `${viewerId}_${id}`),
      findByPk(COLS.savedPrompts, `${viewerId}_${id}`),
    ]);
    if (viewer && isAdminEmail(viewer.email)) unlocked = true;
    if (purchase && purchase.status === 'completed') unlocked = true;
    savedByMe = Boolean(saved);
  }

  const json = { ...prompt };
  if (!unlocked) delete json.promptText; // gate the paid prompt body

  return {
    ...json,
    ...derivePromptFlags(prompt),
    images: normalizeImages(json),
    author: serializeAuthor(author),
    savedByMe,
    unlocked,
  };
}

/**
 * Publish a new prompt as the signed-in creator (authorId = caller). Everyone
 * may post unlimited free prompts; only PAID prompts are gated — they require
 * the Pro or Creator plan (canPostPaid).
 */
export async function createPrompt({ userId, input }) {
  const user = await findByPk(COLS.users, userId);
  if (!user) return { error: { status: 404, message: 'User not found' } };

  const sub = await currentActiveSubscriptionWithPlan(userId);
  const plan = sub?.plan ?? null;

  // GATE — paid prompts need a paid plan with canPostPaid (Pro or Creator).
  if (input.isPaid && !plan?.canPostPaid) {
    return { error: { status: 403, message: 'Paid prompts require the Pro or Creator plan' } };
  }

  const id = crypto.randomUUID();
  const now = new Date();

  // Multiple image support — `images` is the gallery, `imageUrl` the cover
  // (first image, or the caller's explicit cover). Legacy-safe: a bare
  // imageUrl is stored as a single-element gallery.
  const images = (input.images ?? []).map((s) => s.trim()).filter(Boolean);
  const cover = input.imageUrl ?? images[0] ?? null;

  await create(COLS.prompts, id, {
    authorId: userId,
    title: input.title,
    description: input.description,
    promptText: input.promptText,
    imageUrl: cover,
    images: images.length ? images : cover ? [cover] : [],
    category: input.category,
    tags: input.tags ?? [],
    isPaid: input.isPaid,
    priceInr: input.isPaid ? input.priceInr : null,
    status: 'published',
    viewCount: 0,
    saveCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  const prompt = await findByPk(COLS.prompts, id);
  return {
    prompt: {
      ...toPublicPrompt(prompt),
      ...derivePromptFlags(prompt),
      author: serializeAuthor({ id: user.id, fullName: user.fullName, avatarUrl: user.avatarUrl, role: user.role }),
      savedByMe: false,
    },
  };
}

/**
 * Delete a prompt. The author deletes their own; admins may delete any prompt.
 * Purchase + ledger rows are kept for the financial audit trail — only the
 * content itself and its saves are removed.
 */
export async function deletePrompt({ id, userId, isAdmin }) {
  const prompt = await findByPk(COLS.prompts, id);
  if (!prompt || prompt.status !== 'published') {
    return { error: { status: 404, message: 'Prompt not found' } };
  }
  if (!isAdmin && prompt.authorId !== userId) {
    return { error: { status: 403, message: 'Only the author or an admin can delete this prompt' } };
  }

  await removeMany(COLS.prompts, [id]);

  // Clean up the saves pointing at this prompt (bounded, chunked fan-out —
  // a failed save row is harmless, but the prompt itself is gone).
  try {
    const saved = await queryAll({
      collection: COLS.savedPrompts,
      filters: [{ field: 'promptId', value: id }],
      fieldMask: ['id'],
    });
    await removeMany(COLS.savedPrompts, saved.rows.map((s) => s.id));
  } catch {
    // non-fatal
  }

  return { success: true, id };
}

/**
 * Increment a prompt's view count. Fire-and-forget — never fails the request.
 */
export async function recordPromptView(id) {
  try {
    await upsert(COLS.prompts, id, {
      viewCount: increment(1),
      updatedAt: new Date(),
    });
  } catch {
    // non-fatal
  }
}

/**
 * Save a prompt for a user (creates the join row + bumps save_count).
 * Idempotent. Returns the updated save count.
 */
export async function savePrompt(promptId, userId) {
  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt) return { notFound: true };

  const key = `${userId}_${promptId}`;
  const existing = await findByPk(COLS.savedPrompts, key);
  let created = false;
  if (!existing) {
    await upsert(COLS.savedPrompts, key, {
      userId,
      promptId,
      savedAt: new Date(),
    });
    created = true;
  }

  let saveCount = Number(prompt.saveCount) || 0;
  if (created) {
    await upsert(COLS.prompts, promptId, { saveCount: increment(1), updatedAt: new Date() });
    saveCount += 1;
  }

  return { saved: true, saveCount };
}

/**
 * Unsave a prompt (removes the join row + decrements save_count, floor 0).
 * Idempotent. Returns the updated save count.
 */
export async function unsavePrompt(promptId, userId) {
  const key = `${userId}_${promptId}`;
  const deleted = await remove(COLS.savedPrompts, key);

  if (deleted) {
    await upsert(COLS.prompts, promptId, {
      saveCount: increment(-1),
      updatedAt: new Date(),
    });
  }

  const prompt = await findByPk(COLS.prompts, promptId);
  return { saved: false, saveCount: Math.max(Number(prompt?.saveCount) || 0, 0) };
}
