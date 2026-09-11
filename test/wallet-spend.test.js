import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSplitFromBalances } from '../src/services/wallet.service.js';

function balances(overrides = {}) {
  return {
    earnings: { amountInr: 0 },
    deposits: { amountInr: 0 },
    bonus: { amountInr: 0 },
    ...Object.fromEntries(
      Object.entries(overrides).map(([k, v]) => [k, { amountInr: v }]),
    ),
  };
}

test('wallet-spend: deposits are spent before earnings before bonus (priority order)', () => {
  const split = calculateSplitFromBalances(
    balances({ deposits: 50, earnings: 30, bonus: 20 }),
    90,
  );
  assert.deepEqual(split.split, [
    { balanceType: 'deposits', amountToUse: 50 },
    { balanceType: 'earnings', amountToUse: 30 },
    { balanceType: 'bonus', amountToUse: 9 }, // 10% cap of 90
  ]);
});

test('wallet-spend: bonus is capped at 10% of item price', () => {
  const split = calculateSplitFromBalances(
    balances({ deposits: 0, earnings: 0, bonus: 200 }),
    100,
  );
  assert.deepEqual(split.split, [{ balanceType: 'bonus', amountToUse: 10 }]); // min(200, 10, 100)
  assert.equal(split.totalCovered, 10);
  assert.equal(split.remaining, 90);
});

test('wallet-spend: full coverage when balances exceed price (totalCovered = price, remaining 0)', () => {
  const split = calculateSplitFromBalances(
    balances({ deposits: 100, earnings: 100, bonus: 100 }),
    80,
  );
  assert.deepEqual(split.split, [
    { balanceType: 'deposits', amountToUse: 80 },
  ]);
  assert.equal(split.totalCovered, 80);
  assert.equal(split.remaining, 0);
});

test('wallet-spend: empty wallet → zero split, full residual', () => {
  const split = calculateSplitFromBalances(balances(), 99);
  assert.deepEqual(split.split, []);
  assert.equal(split.totalCovered, 0);
  assert.equal(split.remaining, 99);
});

test('wallet-spend: only unused balance types appear in the split (deposits exhausted, earnings covers rest)', () => {
  const split = calculateSplitFromBalances(
    balances({ deposits: 30, earnings: 70, bonus: 0 }),
    100,
  );
  assert.deepEqual(split.split, [
    { balanceType: 'deposits', amountToUse: 30 },
    { balanceType: 'earnings', amountToUse: 70 },
  ]);
  assert.equal(split.totalCovered, 100);
  assert.equal(split.remaining, 0);
});