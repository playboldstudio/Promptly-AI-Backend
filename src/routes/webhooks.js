import { Router } from 'express';
import { handleWebhook } from '../services/webhooks.service.js';

const router = Router();

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
    if (result.status === 'error') {
      const err = new Error('Webhook handler failed');
      err.status = 500;
      return next(err);
    }
    return res.status(200).json({ received: true, ...result });
  } catch (err) {
    return next(err);
  }
});

export default router;
