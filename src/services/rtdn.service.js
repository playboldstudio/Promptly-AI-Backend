import crypto from 'node:crypto';
import { COLS, findByPk, update, upsert, queryAll } from '../db/firestoreRepo.js';
import { handleRTDNSubscription } from './payments/subscriptions.service.js';
import { notify } from './notify.js';

/**
 * Google Play Real-Time Developer Notification handler.
 *
 * Google pushes subscription lifecycle events (SUBSCRIPTION_RENEWED /
 * CANCELED / EXPIRED / PAUSED / RESTARTED) via Cloud Pub/Sub. Each message is
 * parsed, deduped by the sha256 of the event payload, and dispatched to the
 * subscription service.
 *
 * The HTTP route (routes/rtdn.js) returns 200 even on failure so Pub/Sub does
 * not retry a handler that keeps failing — errors are logged server-side.
 */

function dedupeKeyFor(event) {
  const payload = JSON.stringify(event ?? {});
  return `rtdn_${crypto.createHash('sha256').update(payload).digest('hex')}`;
}

export async function handleRTDNEvent(event) {
  // Bearer-token / subscription-name verification happens in the route; here we
  // only process the typed event.
  const { purchaseToken, inappProductId, subscriptionNotification } = event ?? {};
  const notification = subscriptionNotification ?? event?.notification;
  const eventType = notification?.notificationType; // numeric per Google's RTDN schema
  const token = purchaseToken;

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
    } else if (inappProductId) {
      // One-time purchase void/refund pushed by Google. Resolve the purchase
      // row by its gateway token and notify the buyer (the confirm endpoint
      // already reverses the wallet).
      const voided = token
        ? await queryAll({
            collection: COLS.promptPurchases,
            filters: [{ field: 'gatewayOrderToken', value: token }],
            limit: 1,
          })
        : { rows: [] };
      const purchase = voided.rows[0];
      if (purchase?.buyerId) {
        notify({
          userId: purchase.buyerId,
          type: 'deposit_refund',
          title: 'Purchase refunded',
          body: 'Your purchase was refunded by the Play Store.',
          refId: purchase.id,
          dedupeKey: `${purchase.id}_rtdn_void`,
        });
      }
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