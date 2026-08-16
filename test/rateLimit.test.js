import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../src/middleware/rateLimit.js';

function makeReq({ ip, userId } = {}) {
  return { ip, userId, socket: { remoteAddress: '127.0.0.1' } };
}

function run(mw, req) {
  return new Promise((resolve) => {
    mw(req, {}, (err) => resolve(err ?? null));
  });
}

test('rateLimit: allows requests within the window', async () => {
  const mw = rateLimit({ windowMs: 60_000, max: 3 });
  const req = makeReq({ ip: '1.1.1.1' });
  for (let i = 0; i < 3; i++) {
    assert.equal(await run(mw, req), null, `request ${i + 1} should pass`);
  }
});

test('rateLimit: blocks once the max is exceeded', async () => {
  const mw = rateLimit({ windowMs: 60_000, max: 2 });
  const req = makeReq({ ip: '2.2.2.2' });
  await run(mw, req);
  await run(mw, req);
  const err = await run(mw, req);
  assert.ok(err);
  assert.equal(err.status, 429);
});

test('rateLimit: different keys have independent budgets', async () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1 });
  const a = makeReq({ ip: '3.3.3.3' });
  const b = makeReq({ ip: '4.4.4.4' });
  assert.equal(await run(mw, a), null);
  assert.equal(await run(mw, b), null);
  assert.ok(await run(mw, a));
});

test('rateLimit: signed-in users are keyed by userId', async () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1 });
  const a = makeReq({ userId: 'user-1', ip: '5.5.5.5' });
  const b = makeReq({ userId: 'user-2', ip: '5.5.5.5' });
  assert.equal(await run(mw, a), null);
  assert.equal(await run(mw, b), null, 'different users share an IP but not a budget');
});
