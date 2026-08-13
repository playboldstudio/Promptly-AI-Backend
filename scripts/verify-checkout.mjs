#!/usr/bin/env node
/**
 * Dev helper — exercise the Razorpay checkout happy path end-to-end.
 * Requires the server running on localhost:3000 with .env loaded.
 *
 * Usage: node scripts/verify-checkout.mjs
 */
import crypto from 'node:crypto';

const BASE = 'http://localhost:8080';

async function req(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Key secret lives in .env — read it the same way the app does.
import 'dotenv/config';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

function rpSignature(orderId, paymentId) {
  return crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

async function main() {
  console.log('── checkout happy-path verification ──');

  // 1. buyer login
  const login = await req('POST', '/auth/dev/login', {
    body: { email: `e2e-${Date.now()}@test.com`, fullName: 'E2E Buyer' },
  });
  const token = login.json.token;
  console.log('login OK, token:', token?.slice(0, 8), '…');

  // 2. find a paid prompt
  const list = await req('GET', '/prompts?paid=paid');
  const prompt = list.json.prompts[0];
  console.log('paid prompt:', prompt.title, prompt.priceInr, 'INR');
  const promptId = prompt.id;

  // 3. create order
  const order = await req('POST', '/payments/checkout/order', { token, body: { promptId } });
  console.log('order:', order.status, order.json.order?.orderId, order.json.order?.amountInr, 'INR, fee', order.json.order?.feePercent, '%');

  // 4. verify with the CORRECT signature → should unlock
  const paymentId = `pay_e2e_${Date.now()}`;
  const sig = rpSignature(order.json.order.orderId, paymentId);
  const verify = await req('POST', '/payments/checkout/verify', {
    token,
    body: { promptId, orderId: order.json.order.orderId, paymentId, signature: sig },
  });
  console.log('verify (correct sig):', verify.status, verify.json);

  // 5. prompt should now be unlocked for the buyer
  const detail = await req('GET', `/prompts/${promptId}`, { token });
  console.log('prompt unlocked:', detail.json.prompt?.unlocked, '| has promptText:', 'promptText' in detail.json.prompt);

  // 6. duplicate purchase → 409
  const dup = await req('POST', '/payments/checkout/verify', {
    token,
    body: { promptId, orderId: 'order_dup', paymentId: 'pay_dup', signature: rpSignature('order_dup', 'pay_dup') },
  });
  console.log('duplicate purchase:', dup.status, '(expect 409)');

  // 7. creator earnings should now include the sale
  const creator = await req('POST', '/auth/dev/login', { body: { email: 'demo@promptly.app' } });
  const earnings = await req('GET', '/me/earnings', { token: creator.json.token });
  console.log('creator earnings:', earnings.json.earnings);
  const byPrompt = await req('GET', '/me/earnings/prompts', { token: creator.json.token });
  console.log('creator per-prompt:', JSON.stringify(byPrompt.json.prompts?.find((p) => p.promptId === promptId)));

  console.log('── done ──');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
