import { COLS, findByPk, update, upsert } from '../db/firestoreRepo.js';
import { handleRTDNSubscription } from './payments/subscriptions.service.js';

/**
 * Google Play Real-Time Developer Notification handler.
 *
 * Google pushes subscription lifecycle events (SUBSCRIPTION_RENEWED /
 * CANCELED / EXPIRED / PAUSED / RESTARTED) via Cloud Pub/Sub. Each message is
 * parsed, deduped by our deterministic doc id (sha256 of the event payload),
 * and dispatched to the subscription service.
 *
 * The HTTP route (routes/rtdn.js) returns 200 even on failure so Pub/Sub does
 * not retry a handler that keeps failing — errors are logged server-side.
 */

function dedupeKeyFor(event) {
  const payload = JSON.stringify(event ?? {});
  return `rtdn_${Buffer.from(payload).toString('hex').slice(0, 64)}`;
}

export async function handleRTDNEvent(event, subscriptionName) {
  // Bearer-token / subscription-name verification happens in the route; here we
  // only process the typed event.
  const { purchaseToken, inappProductId, subscriptionNotification } = event ?? {};
  const notification = subscriptionNotification ?? event?.notification;
  const eventType = notification?.notificationType; // SUBSCRIPTION_RENEWED etc.
  const token = purchaseToken ?? event?.purchaseToken;

  // Dedupe — same event can arrive twice from Pub/Sub.
  const dedupeKey = dedupeKeyFor(event);
  const existing = await findByPk(COLS.webhookEvents, dedupeKey);
  if (existing?.processedAt) return { status: 'replay' };

  if (!existing) {
    await upsert(COLS.webhookEvents, dedupeKey, {
      provider: 'play_billing',
      eventName: eventType ?? 'unknown',
      payload: event ?? {},
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  try {
    if (token && eventType) {
      await handleRTDNSubscription({ purchaseToken: token, eventType });
    } else if (inappProductId && event?.inappProductId) {
      // One-time purchase void/refund handled by the void endpoint; RTDN just
      // logs it here.
    }
    await update(COLS.webhookEvents, dedupeKey, {
      processedAt: new Date(),
      updatedAt: new Date(),
    });
    return { status: 'processed' };
  } catch (err) {
    console.error(`RTDN ${eventType} failed to process:`, err);
    return { status: 'error' };
  }
}