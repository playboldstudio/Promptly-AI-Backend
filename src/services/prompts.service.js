import { Op } from 'sequelize';
import { Prompt, PromptPurchase, SavedPrompt } from '../db/models.js';
import { sequelize } from '../db/config.js';
import { derivePromptFlags } from './prompt-metrics.js';

// Fields safe to expose publicly. promptText is intentionally excluded — it is the
// paid asset and is only revealed to owners/unlockers (see getPromptById).
// isTrending / isNew are NOT in the DB — they are derived (see derivePromptFlags).
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
  'updatedAt',
];

// Author info exposed on prompts (no email — avoid leaking PII publicly).
const AUTHOR_ATTRS = ['id', 'fullName', 'avatarUrl', 'role'];

function serializeAuthor(prompt) {
  return prompt.author
    ? {
        id: prompt.author.id,
        fullName: prompt.author.fullName,
        avatarUrl: prompt.author.avatarUrl,
        role: prompt.author.role,
      }
    : null;
}

/**
 * List published prompts with the browse filters used by the UI:
 *   ?category=cinematic     — filter by category
 *   ?paid=free|paid         — filter on is_paid
 *   ?sort=trending|new|recent — default recent
 *   ?q=...                  — simple title/description/tags search
 *
 * `viewerId` (optional) additionally annotates each row with savedByMe.
 */
export async function listPrompts({ category, paid, sort, q, viewerId, limit = 50, offset = 0 }) {
  const where = { status: 'published' };

  if (category) where.category = category;
  if (paid === 'free') where.isPaid = false;
  if (paid === 'paid') where.isPaid = true;
  if (q) {
    where[Op.or] = [
      { title: { [Op.iLike]: `%${q}%` } },
      { description: { [Op.iLike]: `%${q}%` } },
      { tags: { [Op.overlap]: [q] } },
    ];
  }

  // Trending sort = derived engagement, evaluated by Postgres (no stored column).
  const order =
    sort === 'trending'
      ? [sequelize.literal('"view_count" + "save_count" DESC')]
      : [['createdAt', 'DESC']];

  const { rows, count } = await Prompt.findAndCountAll({
    where,
    attributes: PUBLIC_PROMPT_ATTRS,
    include: [{ association: 'author', attributes: AUTHOR_ATTRS, required: false }],
    order,
    limit,
    offset,
    distinct: true,
  });

  // One query for the viewer's saved prompt ids → savedByMe set membership.
  let savedIds = new Set();
  if (viewerId) {
    const saved = await SavedPrompt.findAll({
      where: { userId: viewerId },
      attributes: ['promptId'],
    });
    savedIds = new Set(saved.map((s) => s.promptId));
  }

  const prompts = rows.map((row) => ({
    ...row.toJSON(),
    ...derivePromptFlags(row),
    author: serializeAuthor(row),
    savedByMe: viewerId ? savedIds.has(row.id) : false,
  }));

  return { prompts, total: count, limit, offset };
}

/**
 * Fetch one published prompt by id. `viewerId` (optional) enables paid unlock:
 * the full promptText is returned only when the prompt is free, the viewer owns it,
 * or they have a completed PromptPurchase (unlock) row. Also annotates savedByMe.
 */
export async function getPromptById(id, viewerId) {
  const prompt = await Prompt.findOne({
    where: { id, status: 'published' },
    include: [{ association: 'author', attributes: AUTHOR_ATTRS, required: false }],
  });
  if (!prompt) return null;

  // Free prompts are always unlocked; paid ones unlock for the owner or a buyer.
  let unlocked = !prompt.isPaid || Boolean(viewerId && prompt.authorId === viewerId);

  let savedByMe = false;
  if (viewerId) {
    const [purchase, saved] = await Promise.all([
      unlocked
        ? null
        : PromptPurchase.findOne({
            where: { buyerId: viewerId, promptId: prompt.id, status: 'completed' },
          }),
      SavedPrompt.findOne({ where: { userId: viewerId, promptId: prompt.id } }),
    ]);
    if (purchase) unlocked = true;
    savedByMe = Boolean(saved);
  }

  const json = prompt.toJSON();
  if (!unlocked) delete json.promptText; // gate the paid prompt body

  return {
    ...json,
    ...derivePromptFlags(prompt),
    author: serializeAuthor(prompt),
    savedByMe,
    unlocked,
  };
}

/**
 * Increment a prompt's view count. Fire-and-forget — failures must never fail the request.
 */
export async function recordPromptView(id) {
  try {
    await Prompt.increment('viewCount', { where: { id } });
  } catch {
    // non-fatal
  }
}

/**
 * Save a prompt for a user (creates the join row + bumps save_count).
 * Idempotent: saving twice is a no-op. Returns the updated save count.
 */
export async function savePrompt(promptId, userId) {
  const prompt = await Prompt.findByPk(promptId);
  if (!prompt) return { notFound: true };

  const [, created] = await SavedPrompt.findOrCreate({
    where: { userId, promptId },
  });
  if (created) {
    await Prompt.increment('saveCount', { where: { id: promptId } });
  }

  const updated = await Prompt.findByPk(promptId, { attributes: ['saveCount'] });
  return { saved: true, saveCount: updated.saveCount };
}

/**
 * Unsave a prompt for a user (removes the join row + decrements save_count, floor 0).
 * Idempotent. Returns the updated save count.
 */
export async function unsavePrompt(promptId, userId) {
  const deleted = await SavedPrompt.destroy({ where: { userId, promptId } });
  if (deleted) {
    // Floor at 0 so a stale counter can never go negative.
    await Prompt.decrement('saveCount', {
      by: 1,
      where: { id: promptId, saveCount: { [Op.gt]: 0 } },
    });
  }

  const updated = await Prompt.findByPk(promptId, { attributes: ['saveCount'] });
  return { saved: false, saveCount: updated ? updated.saveCount : 0 };
}
