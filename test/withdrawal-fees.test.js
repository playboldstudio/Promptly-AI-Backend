import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateWithdrawal } from '../src/services/payments/withdrawal-fees.js';

test('calculateWithdrawal: Pro seller — 15% platform fee, net to bank', () => {
  const r = calculateWithdrawal({ earningsBalance: 1000, platformFeePercent: 15 });
  assert.equal(r.platformFeeInr, 150);
  assert.equal(r.feeInr, 150);
  assert.equal(r.netInr, 850);
  assert.equal(r.netPayout, 850);
});

test('calculateWithdrawal: Creator seller — 5% platform fee', () => {
  const r = calculateWithdrawal({ earningsBalance: 1000, platformFeePercent: 5 });
  assert.equal(r.platformFeeInr, 50);
  assert.equal(r.netInr, 950);
});

test('calculateWithdrawal: no fee when platformFeePercent is 0 (free plan)', () => {
  const r = calculateWithdrawal({ earningsBalance: 500, platformFeePercent: 0 });
  assert.equal(r.platformFeeInr, 0);
  assert.equal(r.netInr, 500);
});

test('calculateWithdrawal: paise preserved at 2 decimals', () => {
  // ₹99 gross at 15%: 14.85 fee → ₹84.15 net.
  const r = calculateWithdrawal({ earningsBalance: 99, platformFeePercent: 15 });
  assert.equal(r.platformFeeInr, 14.85);
  assert.equal(r.netInr, 84.15);
});

test('calculateWithdrawal: default platformFeePercent is 0', () => {
  const r = calculateWithdrawal({ earningsBalance: 123 });
  assert.equal(r.platformFeePercent, 0);
  assert.equal(r.platformFeeInr, 0);
  assert.equal(r.netInr, 123);
});