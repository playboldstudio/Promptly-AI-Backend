import { createNotification } from './notifications.service.js';

/**
 * Best-effort inbox notification for money/inbox events.
 *
 * Notifications are NEVER the source of truth — a purchase/top-up/subscription
 * succeeds regardless of whether the inbox write lands. This wrapper swallows
 * and logs failures so the money path is never blocked by a notification. All
 * call sites use `notify(...)`; the existing `createNotification` stays as the
 * lower-level API (used by the bonus-expiry sweep and anywhere a result is
 * needed).
 */
export async function notify(args) {
  try {
    return await createNotification(args);
  } catch (err) {
    console.error(`notify failed (type=${args.type}, userId=${args.userId}):`, err?.message ?? err);
    return null;
  }
}