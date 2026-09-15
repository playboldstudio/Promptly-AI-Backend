import {
  COLS,
  findByPk,
  upsert,
  create,
  remove,
  queryAll,
  increment,
  arrayUnion,
  countDocuments,
} from '../db/firestoreRepo.js';
import { env } from '../config/env.js';

export const REPORT_REASONS = ['spam', 'inappropriate', 'copyright', 'misleading', 'other'];

/** Moderation constants (plans/moderation.md §5) — exported for unit tests. */
export const MODERATION_CONFIG = {
  reportThreshold: env.MODERATION_REPORT_THRESHOLD,   // default 5
  appealWindowDays: env.MODERATION_APPEAL_WINDOW_DAYS, // default 7
};

/* ── Helpers ──────────────────────────────────────────────────────────────────── */

function err(status, message) {
  return { error: { status, message } };
}

/* ── Report ───────────────────────────────────────────────────────────────────── */

/**
 * Report a prompt. Creates a `prompt_reports` join row, increments the
 * prompt's `reportCount`, and auto-soft-deletes when the threshold is reached.
 * Idempotent per (userId, promptId).
 */
export async function reportPrompt({ promptId, userId, reason, description }) {
  if (!REPORT_REASONS.includes(reason)) {
    return err(400, `Invalid reason — must be one of: ${REPORT_REASONS.join(', ')}`);
  }

  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt) return err(404, 'Prompt not found');
  if (prompt.status !== 'published') return err(409, 'Prompt is not available for reporting');
  if (prompt.authorId === userId) return err(403, 'You cannot report your own prompt');

  const reportId = `${userId}_${promptId}`;
  const existing = await findByPk(COLS.promptReports, reportId);
  if (existing) return err(409, 'You have already reported this prompt');

  const now = new Date();
  await create(COLS.promptReports, reportId, {
    userId,
    promptId,
    reason,
    description: description ?? null,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  const newCount = (Number(prompt.reportCount) || 0) + 1;

  await upsert(COLS.prompts, promptId, {
    reportCount: increment(1),
    reportedBy: arrayUnion(userId),
    updatedAt: now,
  });

  // Auto-soft-delete when threshold is reached.
  let softDeleted = false;
  if (newCount >= MODERATION_CONFIG.reportThreshold) {
    const appealDeadline = new Date(now.getTime() + MODERATION_CONFIG.appealWindowDays * 86_400_000);
    await upsert(COLS.prompts, promptId, {
      status: 'reported',
      reportedAt: now,
      appealStatus: 'none',
      appealDeadline,
      updatedAt: now,
    });
    softDeleted = true;
  }

  return { success: true, reportCount: newCount, softDeleted };
}

/* ── Appeal ───────────────────────────────────────────────────────────────────── */

/**
 * Creator appeal — only valid within 7 days of the prompt being reported.
 * Sets prompt status to 'appealed'.
 */
export async function appealPrompt({ promptId, authorId, reason }) {
  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt) return err(404, 'Prompt not found');
  if (prompt.authorId !== authorId) return err(403, 'Only the author can appeal');
  if (prompt.status !== 'reported') return err(409, 'Prompt is not flagged for review');
  if (new Date() > new Date(prompt.appealDeadline)) {
    return err(400, 'The 7-day appeal window has closed');
  }

  await upsert(COLS.prompts, promptId, {
    status: 'appealed',
    appealStatus: 'pending',
    appealReason: reason,
    appealedAt: new Date(),
    updatedAt: new Date(),
  });

  return { success: true, status: 'appealed' };
}

/* ── Admin moderation queue ───────────────────────────────────────────────────── */

/**
 * List prompts in 'reported' | 'appealed' states (admin moderation queue).
 * Joins with prompt_reports for report details.
 */
export async function getModerationQueue({ status, limit = 50, offset = 0 } = {}) {
  const filters = [{ field: 'status', value: status ?? 'reported' }];
  const [page, total] = await Promise.all([
    queryAll({
      collection: COLS.prompts,
      filters,
      orderBy: { field: 'updatedAt', direction: 'desc' },
      limit,
      offset,
    }),
    countDocuments(COLS.prompts, filters),
  ]);

  const prompts = page.rows;

  // Attach pending reports for each prompt.
  const reportQueries = await Promise.all(
    prompts.map((p) =>
      queryAll({
        collection: COLS.promptReports,
        filters: [
          { field: 'promptId', value: p.id },
          { field: 'status', value: 'pending' },
        ],
        orderBy: { field: 'createdAt', direction: 'desc' },
      }),
    ),
  );

  const results = prompts.map((p, i) => ({
    prompt: {
      id: p.id,
      title: p.title,
      authorId: p.authorId,
      status: p.status,
      reportCount: p.reportCount ?? 0,
      reportedAt: p.reportedAt ?? null,
      appealStatus: p.appealStatus ?? 'none',
      appealReason: p.appealReason ?? null,
      appealDeadline: p.appealDeadline ?? null,
      appealedAt: p.appealedAt ?? null,
    },
    reports: reportQueries[i].rows,
  }));

  return { prompts: results, total: total ?? results.length, limit, offset };
}

/* ── Admin approve / reject / dismiss ─────────────────────────────────────────── */

/**
 * Admin approves a creator appeal — restore the prompt to 'published',
 * reset report counters.
 */
export async function approveAppeal({ promptId }) {
  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt) return err(404, 'Prompt not found');
  if (prompt.appealStatus !== 'pending') return err(409, 'No pending appeal to approve');

  await upsert(COLS.prompts, promptId, {
    status: 'published',
    appealStatus: 'approved',
    reportCount: 0,
    reportedAt: null,
    reportedBy: [],
    appealDeadline: null,
    updatedAt: new Date(),
  });

  return { success: true, status: 'published' };
}

/**
 * Admin rejects a creator appeal — hard-delete the prompt.
 */
export async function rejectAppeal({ promptId }) {
  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt) return err(404, 'Prompt not found');
  if (prompt.appealStatus !== 'pending') return err(409, 'No pending appeal to reject');

  await upsert(COLS.prompts, promptId, {
    status: 'deleted',
    appealStatus: 'rejected',
    updatedAt: new Date(),
  });

  return { success: true, status: 'deleted' };
}

/**
 * Admin dismisses reports — reset the prompt back to 'published',
 * clear report counters. Used when reports are invalid/abusive.
 */
export async function dismissReport({ promptId }) {
  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt) return err(404, 'Prompt not found');
  if (prompt.status !== 'reported' && prompt.status !== 'appealed') {
    return err(409, 'Prompt is not in a reported/appealed state');
  }

  // Mark all pending reports as dismissed.
  const pendingReports = await queryAll({
    collection: COLS.promptReports,
    filters: [
      { field: 'promptId', value: promptId },
      { field: 'status', value: 'pending' },
    ],
    limit: 10000,
  });

  for (const report of pendingReports.rows) {
    await upsert(COLS.promptReports, report.id, {
      status: 'dismissed',
      updatedAt: new Date(),
    });
  }

  await upsert(COLS.prompts, promptId, {
    status: 'published',
    reportCount: 0,
    reportedAt: null,
    reportedBy: [],
    appealStatus: 'none',
    appealDeadline: null,
    updatedAt: new Date(),
  });

  return { success: true, status: 'published', dismissedReports: pendingReports.rows.length };
}

/* ── Like / Unlike / Share ────────────────────────────────────────────────────── */

/**
 * Toggle a like on a prompt. Idempotent — creates or removes the join row
 * and updates the denormalized likeCount on the prompt doc.
 */
export async function toggleLike({ promptId, userId }) {
  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt || prompt.status !== 'published') return err(404, 'Prompt not found');

  const likeId = `${userId}_${promptId}`;
  const existing = await findByPk(COLS.promptLikes, likeId);

  if (existing) {
    // Unlike
    await remove(COLS.promptLikes, likeId);
    await upsert(COLS.prompts, promptId, {
      likeCount: increment(-1),
      updatedAt: new Date(),
    });
    const updated = await findByPk(COLS.prompts, promptId);
    return { liked: false, likeCount: Math.max(Number(updated?.likeCount) || 0, 0) };
  }

  // Like
  await upsert(COLS.promptLikes, likeId, {
    userId,
    promptId,
    likedAt: new Date(),
  });
  await upsert(COLS.prompts, promptId, {
    likeCount: increment(1),
    updatedAt: new Date(),
  });
  const updated = await findByPk(COLS.prompts, promptId);
  return { liked: true, likeCount: Number(updated?.likeCount) || 0 };
}

/**
 * Share — fire-and-forget counter increment. No join table needed.
 */
export async function sharePrompt(promptId) {
  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt || prompt.status !== 'published') return err(404, 'Prompt not found');

  await upsert(COLS.prompts, promptId, {
    shareCount: increment(1),
    updatedAt: new Date(),
  });
  const updated = await findByPk(COLS.prompts, promptId);
  return { shared: true, shareCount: Number(updated?.shareCount) || 0 };
}
