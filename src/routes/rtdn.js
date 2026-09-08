import { Router } from 'express';
import { handleRTDNEvent } from '../services/rtdn.service.js';
import { env } from '../config/env.js';

/**
 * Google Play Real-Time Developer Notification webhook.
 *
 * Google's Pub/Sub subscription pushes each RTDN message as a POST to this
 * endpoint. We verify the origin subscription id (a bearer token on the push
 * subscription also works), then process the event. We always return 200 so a
 * handler error does not trigger a Pub/Sub retry storm — failures are logged
 * and reconciled later.
 */
const router = Router();

router.post('/', async (req, res) => {
  const message = req.body?.message;
  if (!message?.data) {
    return res.status(200).json({ received: true });
  }

  // Verify origin — the push subscription must be ours.
  if (req.body.subscription && env.RTDN_SUBSCRIPTION && req.body.subscription !== env.RTDN_SUBSCRIPTION) {
    return res.status(403).json({ error: 'Invalid subscription' });
  }

  try {
    const data = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
    const result = await handleRTDNEvent(data, req.body.subscription);
    return res.status(200).json({ received: true, ...result });
  } catch (err) {
    console.error('RTDN handler failed:', err);
    return res.status(200).json({ received: true, status: 'error' }); // always 200 → no retry storm
  }
});

export default router;