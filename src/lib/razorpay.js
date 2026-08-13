import Razorpay from 'razorpay';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Razorpay client + signature helpers.
 *
 * The client is created LAZILY — Razorpay only needs to exist once keys are
 * present. (Both key_id and key_secret are validated as present by
 * src/config/env.js / hasRazorpayKeys.) This lets the app boot in local dev and
 * on Cloud Run even when the keys are temporarily unset (payment routes return 501).
 */

let _client = null;

function getClient() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    const e = new Error('Razorpay is not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    e.status = 501;
    throw e;
  }
  if (!_client) {
    _client = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    });
  }
  return _client;
}

/** The Razorpay client (throws 501 when keys are unset). */
export function razorpay() {
  return getClient();
}

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
  if (!env.RAZORPAY_KEY_SECRET) return false;
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
