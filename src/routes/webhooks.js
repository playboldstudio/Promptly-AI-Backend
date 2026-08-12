import { Router } from 'express';
import { handleWebhook } from '../services/webhooks.service.js';

const router = Router();

/**
 * POST /webhooks/razorpay — verify, log idempotently, dispatch.
 *
 * Mounted with express.raw({ type: 'application/json' }) in app.js so req.body
 * is a Buffer. The route hands the raw body to the dispatcher for HMAC
 * verification; the parsed JSON comes from `body.toString('utf8')`.
 *
 * NOTE: this router is mounted at /webhooks/razorpay in app.js, so the route
 * path here is just "/" — otherwise the real URL would be double-prefixed.
 *
 * Responds fast; heavy work happens in the service layer / queue.
 */
router.post('/', async (req, res, next) => {
  try {
    const rawBody = req.body?.toString?.('utf8') ?? '';
    const signature = req.headers['x-razorpay-signature'] ?? '';
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      body = {};
    }

    const result = await handleWebhook({ rawBody, signature, body });
    return res.status(200).json({ received: true, ...result });
  } catch (err) {
    return next(err);
  }
});

export default router;
