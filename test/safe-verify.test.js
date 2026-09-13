import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeVerify } from '../src/lib/playBilling.js';

test('safeVerify: returns data on success', async () => {
  const result = await safeVerify(() => Promise.resolve({ productId: 'x', purchaseState: 0 }));
  assert.deepEqual(result, { data: { productId: 'x', purchaseState: 0 } });
});

test('safeVerify: maps 400/404/403 Google errors to a clean error object (no throw)', async () => {
  const apiErr = new Error('not found');
  apiErr.code = 404;
  apiErr.errors = [{ message: 'Purchase token not found' }];
  const result = await safeVerify(() => Promise.reject(apiErr));
  assert.equal(result.data, null);
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /not verified/i);
});

test('safeVerify: maps Google string-code errors (missing required parameters) to 400', async () => {
  const apiErr = new Error('Missing required parameters: subscriptionId');
  apiErr.code = 'Missing required parameters: subscriptionId';
  const result = await safeVerify(() => Promise.reject(apiErr));
  assert.equal(result.data, null);
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /not verified/i);
});

test('safeVerify: rethrows genuine server errors (network, auth) for the global handler', async () => {
  const netErr = new Error('ECONNRESET');
  netErr.code = 'ECONNRESET';
  await assert.rejects(() => safeVerify(() => Promise.reject(netErr)), /ECONNRESET/);
});

test('safeVerify: rethrows non-API errors (unknown shape)', async () => {
  await assert.rejects(() => safeVerify(() => Promise.reject(new Error('boom'))), /boom/);
});