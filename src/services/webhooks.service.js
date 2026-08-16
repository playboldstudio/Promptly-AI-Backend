import crypto from 'node:crypto';
import { COLS, findByPk, upsert, update } from '../db/firestoreRepo.js';
import { verifyWebhookSignature } from '../lib/razorpay.js';
import { activateSubscription, deactivateSubscription } from './payments/subscriptions.service.js';

/**
 * Razorpay webhook handling: verify → log idempotently → dispatch.
 * The dedupe key IS the doc id (sha256 of event + payload), so replays are
 * skipped. `processedAt` is set only after the handler succeeds; a failure
 * leaves it null so the next delivery re-runs it (at-least-once).
 */

function dedupeKeyFor(eventName, payload) {
  return crypto
    .createHash('sha256')
    .update(`${eventName}\n${JSON.stringify(payload)}`)
    .digest('hex');
}

export async function handleWebhook({ rawBody, signature, body }) {
  // 1. Signature check — reject anything that isn't genuinely from Razorpay.
  if (!verifyWebhookSignature(rawBody, signature)) {
    const e = new Error('Invalid webhook signature');
    e.status = 401;
    throw e;
  }

  const eventName = body?.event ?? 'unknown';
  const payload = body?.payload ?? {};

  // 2. Idempotent log — the dedupe key IS the doc id.
  const dedupeKey = dedupeKeyFor(eventName, payload);
  const existing = await findByPk(COLS.webhookEvents, dedupeKey);

  if (existing) {
    // Already fully handled → replay (Razorpay retried). Skip.
    if (existing.processedAt) return { status: 'replay' };
    // Created but not yet processed → a retry of a partially-handled event.
    // Re-attempt dispatch (at-least-once). Fall through below.
  } else {
    // First sighting — record it BEFORE dispatching.
    await upsert(COLS.webhookEvents, dedupeKey, {
      provider: 'razorpay',
      eventName,
      payload: body,
      razorpaySignature: signature,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // 3. Dispatch by event name. Unknown events are logged but ignored
  //    (Razorpay sends plenty — payment.captured, subscription.halted, …).
  try {
    if (eventName === 'subscription.activated' || eventName === 'subscription.charged') {
      await activateSubscription(payload.subscription?.entity);
    } else if (eventName === 'subscription.cancelled' || eventName === 'subscription.expired') {
      await deactivateSubscription(payload.subscription?.entity);
    }
    await update(COLS.webhookEvents, dedupeKey, {
      processedAt: new Date(),
      updatedAt: new Date(),
    });
    return { status: 'processed' };
  } catch (err) {
    // Leave processed_at null — the next delivery retries this event.
    console.error(`Webhook ${eventName} failed to process:`, err);
    return { status: 'error' };
  }
}
