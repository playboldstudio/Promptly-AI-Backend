import crypto from 'node:crypto';
import { COLS, findByPk, queryAll, remove, upsert, create, getMany, increment } from '../db/firestoreRepo.js';
import { derivePromptFlags } from './prompt-metrics.js';
import { currentActiveSubscriptionWithPlan } from './payments/_subs.js';

// Fields safe to expose publicly. promptText is intentionally excluded — it is the
// paid asset and is only revealed to owners/unlockers (see getPromptById).
// isTrending / isNew are NOT stored — they are derived (see derivePromptFlags).
const PUBLIC_PROMPT_ATTRS = [
  'id',
  'title',
  'description',
  'imageUrl',
  'category',
  'tags',
  'isPaid',
  'priceInr',
  'viewCount',
  'saveCount',
  'createdAt',
];

// Author info exposed on prompts (no email — avoid leaking PII publicly).
const AUTHOR_ATTRS = ['id', 'fullName', 'avatarUrl', 'role'];

function serializeAuthor(author) {
  return author
    ? {
        id: author.id,
        fullName: author.fullName,
        avatarUrl: author.avatarUrl,
        role: author.role,
      }
    : null;
}

/** Pick only the publicly-safe fields, mirroring the old PUBLIC_PROMPT_ATTRS projection. */
function toPublicPrompt(json) {
  const out = {};
  for (const k of PUBLIC_PROMPT_ATTRS) out[k] = json[k];
  return out;
}

/**
 * List published prompts with the browse filters used by the UI.
 * Firestore has no substring ILIKE or cross-field OR, so we fetch the published
 * set and filter/sort in memory — identical behaviour, fine at this scale.
 * The `trending` sort is derived engagement (not a stored column), so it is
 * computed here too.
 */
export async function listPrompts({ category, paid, sort, q, viewerId, limit = 50, offset = 0 }) {
  const all = await queryAll({
    collection: COLS.prompts,
    filters: [{ field: 'status', value: 'published' }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit: 10000, // load the catalog; small-scale app
  });

  let rows = all.rows;

  if (category) rows = rows.filter((r) => r.category === category);
  if (paid === 'free') rows = rows.filter((r) => !r.isPaid);
  if (paid === 'paid') rows = rows.filter((r) => r.isPaid);
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) =>
      (r.title ?? '').toLowerCase().includes(needle) ||
      (r.description ?? '').toLowerCase().includes(needle) ||
      (Array.isArray(r.tags) && r.tags.some((t) => t.toLowerCase().includes(needle))),
    );
  }

  if (sort === 'trending') {
    rows = rows.sort(
      (a, b) =>
        (Number(b.viewCount) + Number(b.saveCount)) -
        (Number(a.viewCount) + Number(a.saveCount)),
    );
  } else {
    rows = rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  const total = rows.length;
  const page = rows.slice(offset, offset + limit);

  const authorIds = [...new Set(page.map((r) => r.authorId).filter(Boolean))];
  const authors = authorIds.length ? await getMany(COLS.users, authorIds) : {};

  // One query for the viewer's saved prompt ids → savedByMe set membership.
  let savedIds = new Set();
  if (viewerId) {
    const saved = await queryAll({
      collection: COLS.savedPrompts,
      filters: [{ field: 'userId', value: viewerId }],
      limit: 10000,
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
 * Fetch one published prompt by id. `viewerId` (optional) enables paid unlock:
 * the full promptText is returned only when the prompt is free, the viewer owns it,
 * or they have a completed PromptPurchase (unlock) row. Also annotates savedByMe.
 */
export async function getPromptById(id, viewerId) {
  const prompt = await findByPk(COLS.prompts, id);
  if (!prompt || prompt.status !== 'published') return null;

  const author = prompt.authorId ? await findByPk(COLS.users, prompt.authorId) : null;

  // Free prompts are always unlocked; paid ones unlock for the owner or a buyer.
  let unlocked = !prompt.isPaid || Boolean(viewerId && prompt.authorId === viewerId);

  let savedByMe = false;
  if (viewerId) {
    const [purchase, saved] = await Promise.all([
      unlocked
        ? null
        : findByPk(COLS.promptPurchases, `${viewerId}_${id}`),
      findByPk(COLS.savedPrompts, `${viewerId}_${id}`),
    ]);
    if (purchase && purchase.status === 'completed') unlocked = true;
    savedByMe = Boolean(saved);
  }

  const json = { ...prompt };
  if (!unlocked) delete json.promptText; // gate the paid prompt body

  return {
    ...json,
    ...derivePromptFlags(prompt),
    author: serializeAuthor(author),
    savedByMe,
    unlocked,
  };
}

/**
 * Publish a new prompt as the signed-in creator. Sets authorId = the caller
 * (owner). Gates:
 *   - Free plan daily post limit (Free = 3/day from the plan seed; Pro/Creator
 *     have dailyPostLimit null = unlimited).
 *   - Paid prompts require the Creator plan (canPostPaid on the plan).
 * New prompts are published immediately and use a UUID doc id.
 * @returns {{ prompt: object } | {error: {status, message}}}
 */
export async function createPrompt({ userId, input }) {
  const user = await findByPk(COLS.users, userId);
  if (!user) return { error: { status: 404, message: 'User not found' } };

  const sub = await currentActiveSubscriptionWithPlan(userId);
  const plan = sub?.plan ?? null;

  // GATE — daily post limit from the current plan. null = unlimited (Pro/Creator);
  // no active sub = Free tier (3/day from the plan seed).
  const dailyLimit = plan ? plan.dailyPostLimit : 3;
  if (dailyLimit) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const { rows } = await queryAll({
      collection: COLS.prompts,
      filters: [{ field: 'authorId', value: userId }],
      limit: 10000,
    });
    const postedToday = rows.filter((r) => new Date(r.createdAt) >= startOfDay).length;
    if (postedToday >= dailyLimit) {
      return {
        error: { status: 429, message: `Daily publish limit reached (${dailyLimit}/day) — upgrade to Pro/Creator for unlimited` },
      };
    }
  }

  // GATE — paid prompts need the Creator plan (canPostPaid).
  if (input.isPaid && !plan?.canPostPaid) {
    return { error: { status: 403, message: 'Paid prompts require the Creator plan' } };
  }

  const id = crypto.randomUUID();
  const now = new Date();
  await create(COLS.prompts, id, {
    authorId: userId,
    title: input.title,
    description: input.description,
    promptText: input.promptText,
    imageUrl: input.imageUrl ?? null,
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
 * Increment a prompt's view count. Fire-and-forget — failures must never fail the request.
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
 * Idempotent: saving twice is a no-op. Returns the updated save count.
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
 * Unsave a prompt for a user (removes the join row + decrements save_count, floor 0).
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
