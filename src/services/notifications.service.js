import { COLS, findByPk, add, update, upsert, queryAll, countDocuments } from '../db/firestoreRepo.js';
import { getBonusExpiringSoon } from './wallet.service.js';

/**
 * In-app notification inbox (plans/wallet.md §5.4 — the "no app change" delivery
 * for the bonus-expiry reminder). Zero native-push: the app polls the inbox at
 * launch. FCM/APNs push is a deferred alternative (APP_INTEGRATION.md §3).
 *
 * Each notification is a `notifications` doc:
 *   { userId, type, title, body, refId?, data?, status: 'unread'|'read',
 *     readAt?, createdAt, updatedAt }
 * Notifications are deduped by their deterministic doc id when `dedupeKey` is
 * given (createNotification) so daily sweeps never spam duplicates.
 */

/** Deterministic doc id for a deduped notification — pure (testable). */
export function notificationIdFor(userId, type, dedupeKey) {
  return `${userId}_${type}_${dedupeKey}`;
}

export async function createNotification({ userId, type, title, body, refId, dedupeKey, data = {} }) {
  const payload = {
    userId,
    type,
    title,
    body,
    refId: refId ?? null,
    data,
    status: 'unread',
    readAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  if (dedupeKey) {
    const id = notificationIdFor(userId, type, dedupeKey);
    const existing = await findByPk(COLS.notifications, id);
    if (existing) return existing; // already there → no duplicate
    return upsert(COLS.notifications, id, payload);
  }

  return add(COLS.notifications, payload);
}

/**
 * List the signed-in user's inbox, newest first. `unreadOnly` filters to
 * unread rows; `limit`/`offset` page (parsePaging in the route).
 */
export async function listNotifications(userId, { unreadOnly = false, limit = 50, offset = 0 } = {}) {
  const filters = [{ field: 'userId', value: userId }];
  if (unreadOnly) filters.push({ field: 'status', value: 'unread' });

  const [page, total] = await Promise.all([
    queryAll({
      collection: COLS.notifications,
      filters,
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
      offset,
    }),
    countDocuments(COLS.notifications, filters),
  ]);
  return { notifications: page.rows, total: total ?? page.rows.length };
}

/**
 * Mark the user's notifications as read. Only rows owned by `userId` are
 * touched (ownership guard — a caller can't flip another user's rows).
 * Returns the count actually updated.
 */
export async function markNotificationsRead(userId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return { updated: 0 };

  let updated = 0;
  for (const id of ids) {
    const doc = await findByPk(COLS.notifications, id);
    if (!doc || doc.userId !== userId) continue; // not yours → skip silently
    if (doc.status === 'read') continue;
    await update(COLS.notifications, id, { status: 'read', readAt: new Date(), updatedAt: new Date() });
    updated += 1;
  }
  return { updated };
}

/**
 * Bonus-expiry reminder (plans/wallet.md §5.4). Wraps getBonusExpiringSoon and
 * writes ONE inbox row for the earliest-expiring vintage per user, deduped by
 * the vintage id so the daily sweep never repeats it. Uses
 * `notifyBeforeExpiry` (7 days) from the bonus balance-type config.
 */
/**
 * Build the bonus-expiry reminder title/body for the earliest-expiring vintage.
 * Pure (testable). `days` is floored at 1 so a vintage expiring today still
 * says "in 1 day" rather than "in 0 days".
 */
export function bonusExpiryReminderMessage({ amount, expiresAt, now = Date.now() }) {
  const days = Math.max(1, Math.round((new Date(expiresAt).getTime() - now) / 86_400_000));
  return {
    title: 'Bonus expiring soon',
    body: `🎁 Your ₹${amount} bonus expires in ${days} day${days > 1 ? 's' : ''}. Use it before it's gone!`,
    days,
  };
}

export async function getBonusExpiryReminder(userId) {
  const { expiring } = await getBonusExpiringSoon(userId, { withinDays: 7 });
  if (expiring.length === 0) return { notified: 0, expiring: [] };

  // Earliest-expiring first (closest to loss).
  const earliest = [...expiring].sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt))[0];
  const { title, body, days } = bonusExpiryReminderMessage(earliest);

  await createNotification({
    userId,
    type: 'bonus_expiry',
    title,
    body,
    refId: earliest.id,
    dedupeKey: earliest.id, // stable per-vintage id → the daily sweep won't duplicate
    data: { amountInr: earliest.amount, expiresAt: earliest.expiresAt },
  });

  return { notified: 1, expiring };
}