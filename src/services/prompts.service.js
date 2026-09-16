import crypto from 'node:crypto';
import { COLS, findByPk, queryAll, remove, removeMany, upsert, create, getMany, increment, countDocuments } from '../db/firestoreRepo.js';
import { derivePromptFlags } from './prompt-metrics.js';
import { isAdminEmail } from '../config/env.js';
import { currentActiveSubscriptionWithPlan } from './payments/subscription-utils.js';
import { PROMPT_CATEGORIES } from '../utils/prompt-import.js';

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

export function toPublicPrompt(json) {
  const out = {};
  for (const k of PUBLIC_PROMPT_ATTRS) out[k] = json[k];
  out.images = normalizeImages(json);
  return out;
}

/**
 * Whitelisted prompt detail — the widest shape a client gets. Includes the paid
 * body only when `unlocked` and NEVER exposes moderation internals
 * (`reportedBy`, `reportCount`, appeal fields) — those live only in the admin
 * moderation queue.
 */
export function toPromptDetail(prompt, { unlocked = false } = {}) {
  const out = toPublicPrompt(prompt);
  out.authorId = prompt.authorId ?? null;
  out.likeCount = Number(prompt.likeCount) || 0;
  out.shareCount = Number(prompt.shareCount) || 0;
  out.updatedAt = prompt.updatedAt ?? null;
  if (unlocked) out.promptText = prompt.promptText;
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

/** Parse `YYYY-MM` (or `YYYY-M`) into an inclusive calendar-month range. */
function parseMonth(month) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(month ?? ''));
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  const start = new Date(Date.UTC(year, mon - 1, 1));
  const end = new Date(Date.UTC(mon === 12 ? year + 1 : year, mon % 12, 1));
  return { start, end, label: `${year}-${String(mon).padStart(2, '0')}` };
}

/**
 * Time-window feed ("new"/"month"). Reads the bounded published catalog and
 * filters createdAt in memory for an exact total — Firestore's `count()`
 * aggregation needs a composite index for range filters that isn't deployed,
 * so we follow the same bounded-catalog pattern the semantic list path uses.
 * Rows come back in createdAt-desc order (the catalog query is ordered).
 */
async function listInTimeWindow({ range, viewerId, limit, offset }) {
  const { rows } = await queryAll({
    collection: COLS.prompts,
    filters: [{ field: 'status', value: 'published' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: PHOTOS_CATALOG_MAX,
  });

  const filtered = rows.filter((r) => {
    const t = r.createdAt ? new Date(r.createdAt) : null;
    if (!t) return false;
    if (t < range.start) return false;
    if (range.end && t >= range.end) return false;
    return true;
  });

  const page = filtered.slice(offset, offset + limit);
  return withAuthorsAndSaveState(page, viewerId, limit, offset, filtered.length);
}

/**
 * GET /prompts/categories — Flipkart-style category rails.
 * Reads the published set once, groups in memory, and returns each category
 * with its exact count plus the newest `previewLimit` prompts (enriched with
 * author + savedByMe). `paid` narrows the rails to free/paid only.
 */
export async function listPromptCategories({ previewLimit = 4, paid, viewerId } = {}) {
  const safe = Math.max(1, Math.min(10, Number(previewLimit) || 4));

  const { rows } = await queryAll({
    collection: COLS.prompts,
    filters: [{ field: 'status', value: 'published' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: PHOTOS_CATALOG_MAX,
  });

  const groups = new Map();
  const counts = new Map();
  let total = 0;
  for (const r of rows) {
    if (paid === 'free' && r.isPaid) continue;
    if (paid === 'paid' && !r.isPaid) continue;
    total += 1;
    counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    if (!groups.has(r.category)) groups.set(r.category, []);
    const list = groups.get(r.category);
    if (list.length < safe) list.push(r);
  }

  // Enrich all preview rows in a single pass, then map them back to rails.
  const previewRows = [...groups.values()].flat();
  const catalog = previewRows.length
    ? await withAuthorsAndSaveState(previewRows, viewerId, previewRows.length, 0, previewRows.length)
    : { prompts: [] };
  const enrichedById = new Map(catalog.prompts.map((p) => [p.id, p]));

  const categories = PROMPT_CATEGORIES.map((category) => ({
    category,
    count: counts.get(category) ?? 0,
    previews: (groups.get(category) ?? [])
      .map((r) => enrichedById.get(r.id))
      .filter(Boolean),
  }));

  return { categories, total };
}

/**
 * GET /prompts/new — "just added" feed. Prompts published within the last
 * `days` (default 7, max 90), newest first. Same row shape as GET /prompts.
 */
export async function listNewPrompts({ days = 7, viewerId, limit = 50, offset = 0 } = {}) {
  const safeDays = Math.max(1, Math.min(90, Number(days) || 7));
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const result = await listInTimeWindow({ range: { start: since }, viewerId, limit, offset });

  return { ...result, days: safeDays, since: since.toISOString() };
}

/**
 * GET /prompts/month — month-wise feed. Prompts published within a calendar
 * month (`month=YYYY-MM`), newest first. Same row shape as GET /prompts.
 */
export async function listMonthPrompts({ month, viewerId, limit = 50, offset = 0 } = {}) {
  const range = parseMonth(month);
  if (!range) return { error: { status: 400, message: 'month must be in YYYY-MM format' } };

  const result = await listInTimeWindow({ range, viewerId, limit, offset });

  return { ...result, month: range.label };
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

  const json = toPromptDetail(prompt, { unlocked });

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
      limit: 10000,
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
