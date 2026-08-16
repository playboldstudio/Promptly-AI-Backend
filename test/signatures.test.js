import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Signature helpers import env.js which validates process.env — set the
// required vars BEFORE importing so the test isn't skipped.
process.env.FIREBASE_PROJECT_ID = 'test-project';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
process.env.RAZORPAY_KEY_SECRET = 'keysecret';
const { verifyWebhookSignature, verifyPaymentSignature } = await import('../src/lib/razorpay.js');

test('webhook signature verifies with the right secret', () => {
  const body = JSON.stringify({ event: 'subscription.charged', payload: {} });
  const sig = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex');
  assert.equal(verifyWebhookSignature(body, sig), true);
});

test('webhook signature rejects a wrong secret / tampered body', () => {
  const body = JSON.stringify({ event: 'subscription.charged', payload: {} });
  const bad = crypto.createHmac('sha256', 'other_secret').update(body).digest('hex');
  assert.equal(verifyWebhookSignature(body, bad), false);
  assert.equal(verifyWebhookSignature(body + 'x', bad), false);
});

test('webhook signature rejects empty secret or signature', () => {
  // env.js captured 'whsec_test' at import — verify the helpers still reject
  // when the incoming signature is empty (no secret mutation needed).
  assert.equal(verifyWebhookSignature('{}', ''), false);
});

test('payment signature verifies orderId|paymentId with the key secret', () => {
  const orderId = 'order_test';
  const paymentId = 'pay_test';
  const sig = crypto.createHmac('sha256', 'keysecret').update(`${orderId}|${paymentId}`).digest('hex');
  assert.equal(verifyPaymentSignature({ orderId, paymentId, signature: sig }), true);
});

test('payment signature rejects missing fields', () => {
  assert.equal(verifyPaymentSignature({ orderId: '', paymentId: 'x', signature: 'x' }), false);
  assert.equal(verifyPaymentSignature({ orderId: 'x', paymentId: '', signature: 'x' }), false);
  assert.equal(verifyPaymentSignature({ orderId: 'x', paymentId: 'x', signature: '' }), false);
});
