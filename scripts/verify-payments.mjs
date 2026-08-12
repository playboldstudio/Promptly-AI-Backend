#!/usr/bin/env node
/**
 * Dev helper — exercise subscriptions + manual-settle payouts end-to-end.
 * Requires the server running on localhost:3000 with .env loaded.
 *
 * Usage: node scripts/verify-payments.mjs
 */
import crypto from 'node:crypto';
import 'dotenv/config';

const BASE = 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

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

/** Sign a raw webhook body string the way Razorpay does (HMAC-SHA256). */
function webhookSig(rawBody) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

/** POST a webhook with a correct Razorpay signature. Takes a raw body string. */
async function postWebhook(rawBody) {
  const signature = webhookSig(rawBody);
  return fetch(`${BASE}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature },
    body: rawBody,
  });
}

async function main() {
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok, extra });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  };

  // ── Setup: demo creator (has verified KYC + bank + earnings from seed) ──
  const creatorLogin = await req('POST', '/auth/dev/login', { body: { email: 'demo@promptly.app' } });
  const creatorToken = creatorLogin.json.token;
  check('demo creator login', Boolean(creatorToken));

  // Give the creator some balance via a real paid sale (checkout flow).
  const buyerLogin = await req('POST', '/auth/dev/login', { body: { email: `buyer-${Date.now()}@test.com` } });
  const buyerToken = buyerLogin.json.token;
  const list = await req('GET', '/prompts?paid=paid');
  const paidPrompt = list.json.prompts[0];
  const order = await req('POST', '/payments/checkout/order', { token: buyerToken, body: { promptId: paidPrompt.id } });
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${order.json.order.orderId}|pay_e2e_${Date.now()}`).digest('hex');
  const verify = await req('POST', '/payments/checkout/verify', {
    token: buyerToken,
    body: { promptId: paidPrompt.id, orderId: order.json.order.orderId, paymentId: `pay_e2e_${Date.now()}`, signature: sig },
  });
  check('creator has a sale on balance', verify.status === 200, `status ${verify.status}`);

  // ── Payouts ──
  // min ₹60 gate
  const minGate = await req('POST', '/payments/payouts', { token: creatorToken, body: { amountInr: 10 } });
  check('payout min ₹60 rejected', minGate.status === 400, `status ${minGate.status}`);

  // happy path — withdraw 60
  const payout = await req('POST', '/payments/payouts', { token: creatorToken, body: { amountInr: 60 } });
  check('payout request created', payout.status === 201 && payout.json.payout?.status === 'pending', `status ${payout.status}`);
  const payoutId = payout.json.payout?.id;

  // balance reserved (ledger debit)
  const earnings = await req('GET', '/me/earnings', { token: creatorToken });
  const pendingNow = earnings.json.earnings?.pendingPayouts;
  check('pending payout counted', pendingNow === 60, `pending ${pendingNow}`);

  // over-balance rejected
  const over = await req('POST', '/payments/payouts', { token: creatorToken, body: { amountInr: 999999 } });
  check('over-balance rejected', over.status === 400, `status ${over.status}`);

  // ── Admin: manual settle ──
  const adminList = await req('GET', '/payments/admin/payouts?status=pending', { token: creatorToken });
  const found = adminList.json.payouts?.some((p) => p.id === payoutId);
  check('admin sees pending payout + bank details', found && adminList.json.payouts[0]?.bankAccount?.accountNumberFull, 'bank full account present');

  const markPaid = await req('POST', `/payments/admin/payouts/${payoutId}/mark-paid`, { token: creatorToken });
  check('admin marks paid', markPaid.status === 200 && markPaid.json.payout?.status === 'paid');

  const earningsAfter = await req('GET', '/me/earnings', { token: creatorToken });
  check('withdrawn reflects paid payout', earningsAfter.json.earnings?.withdrawnInr === 60, `withdrawn ${earningsAfter.json.earnings?.withdrawnInr}`);

  // double mark → 409
  const dupMark = await req('POST', `/payments/admin/payouts/${payoutId}/mark-paid`, { token: creatorToken });
  check('double mark-paid rejected', dupMark.status === 409, `status ${dupMark.status}`);

  // ── Subscriptions ──
  const subCreate = await req('POST', '/payments/subscriptions', { token: creatorToken, body: { planId: 'creator' } });
  check('subscription created with shortUrl', subCreate.status === 200 && subCreate.json.subscription?.shortUrl, `status ${subCreate.status}, sub ${subCreate.json.subscription?.razorpaySubId?.slice(0, 12)}`);
  const rzpSubId = subCreate.json.subscription?.razorpaySubId;

  // ── Webhooks ──
  const subPayload = (status = 'active') => ({
    event: 'subscription.charged',
    payload: {
      subscription: {
        entity: {
          id: rzpSubId,
          status,
          plan_id: process.env.RAZORPAY_PLAN_CREATOR_ID,
          current_start: Math.floor(Date.now() / 1000),
          current_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          notes: { userId: creatorLogin.json.user?.id },
        },
      },
    },
  });

  const chargedBody = JSON.stringify(subPayload());
  const wh1 = await postWebhook(chargedBody);
  check('webhook accepted', wh1.status === 200);
  const wh1Body = await wh1.json();
  check('webhook processed', wh1Body.status === 'processed', `status ${wh1Body.status}`);

  const profile = await req('GET', '/me/profile', { token: creatorToken });
  check('subscription active after webhook', profile.json.subscription?.status === 'active' && profile.json.subscription?.planId === 'creator', `plan ${profile.json.subscription?.planId}`);

  // replay → skipped (idempotency). Razorpay replays are BYTE-IDENTICAL, so
  // re-send the SAME raw body + signature.
  const wh2 = await postWebhook(chargedBody);
  const wh2Body = await wh2.json();
  check('replay deduped', wh2Body.status === 'replay', `status ${wh2Body.status}`);

  // cancellation
  const wh3 = await postWebhook(JSON.stringify({ event: 'subscription.cancelled', payload: { subscription: { entity: { id: rzpSubId, status: 'cancelled' } } } }));
  const wh3Body = await wh3.json();
  check('cancel webhook processed', wh3Body.status === 'processed', `status ${wh3Body.status}`);
  const profileAfter = await req('GET', '/me/profile', { token: creatorToken });
  // getProfile only returns the ACTIVE subscription, so a cancelled one reads null.
  check('subscription no longer active', profileAfter.json.subscription === null, `subscription ${JSON.stringify(profileAfter.json.subscription)}`);

  // bad signature → 401
  const badSigRes = await fetch(`${BASE}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'deadbeef' },
    body: JSON.stringify({ event: 'subscription.charged', payload: {} }),
  });
  check('bad signature rejected', badSigRes.status === 401, `status ${badSigRes.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
