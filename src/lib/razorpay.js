import Razorpay from 'razorpay';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Razorpay client + signature helpers.
 *
 * The client is created lazily — Razorpay is only *used* once keys are present.
 * (Both key_id and key_secret are validated as present by src/config/env.js.)
 */
const keyId = env.RAZORPAY_KEY_ID;
const keySecret = env.RAZORPAY_KEY_SECRET;

export const razorpay = new Razorpay({
  key_id: keyId,
  key_secret: keySecret,
});

/**
 * Verify a Razorpay webhook signature (HMAC-SHA256 of the raw body with the
 * webhook secret). Returns true/false. Must be called with the RAW body string.
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  // Constant-time compare to avoid timing attacks.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verify a payment_signature returned by Razorpay Checkout (from the order + payment).
 * This is the common pattern: Razorpay returns `razorpay_payment_id`,
 * `razorpay_order_id`, `razorpay_signature` after a successful payment.
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!signature || !orderId || !paymentId) return false;
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac('sha256', keySecret).update(body).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
